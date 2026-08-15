/**
 * GoalState — durable long-task state kernel (huangruiteng/loopx minimal
 * slice).
 *
 * One authoritative JSON restart packet per project
 * (.pi/runtime/goals/goal-state.json) holding the active goal: objective,
 * priority stack, non-goals, next action, typed gates, todos with leases,
 * evidence, quota accounting and an append-only history. The file is loaded
 * at session start so an objective outlives restarts, thread interruptions
 * and agent handoffs (loopx "lifetime-goal invariant").
 *
 * Semantics borrowed from loopx:
 * - gates: typed user/quality gates with a concrete question; an open gate
 *   blocks completion but non-dependent lanes may continue (audited
 *   fallback — the store records a "fallback" history entry).
 * - quota: token budget over a rolling window; shouldRun() answers "may
 *   this lane act now" with spent/budget/nextEligibleAt.
 * - todos: claim→update→spend ownership with TTL leases, so a different
 *   session or agent can take over a stale todo with evidence.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const GOAL_STATE_SCHEMA_VERSION = 1;
export const GATE_KINDS = Object.freeze(["user_gate", "quality_gate"]);
export const GATE_STATUSES = Object.freeze(["open", "satisfied", "blocked"]);
export const TODO_STATUSES = Object.freeze(["open", "claimed", "done"]);
export const HISTORY_KINDS = Object.freeze([
  "activated", "updated", "gate", "todo", "evidence", "spend", "handoff", "completed", "fallback"
]);
const DEFAULT_TOKEN_BUDGET = 200000;
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

function nowIso(now) {
  const value = typeof now === "function" ? now() : now;
  return value ?? new Date().toISOString();
}

function parseTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function assertWorkspacePath(projectRoot, targetPath, label) {
  const relativePath = path.relative(path.resolve(projectRoot), path.resolve(targetPath));
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must stay inside the project root: ${relativePath}`);
  }
}

export function goalStatePath(projectRoot, rootDir) {
  return path.join(path.resolve(projectRoot), rootDir, "goal-state.json");
}

export function loadGoalState(filePath) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  if (!record || record.schemaVersion !== GOAL_STATE_SCHEMA_VERSION || typeof record.goals !== "object" || record.goals === null) {
    return null;
  }
  return record;
}

export function saveGoalState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
  fs.renameSync(tmp, filePath);
  return filePath;
}

/**
 * Normalize a goal from user input. `now` is injectable for tests.
 */
export function createGoal(input = {}, { now = () => new Date().toISOString() } = {}) {
  const objective = String(input.objective ?? "").trim();
  if (!objective) throw new Error("goal objective is required");
  const id = String(input.id ?? `goal-${randomUUID()}`).trim();
  if (!id) throw new Error("goal id is required");
  const quota = {
    tokenBudget: Number(input.quota?.tokenBudget ?? DEFAULT_TOKEN_BUDGET),
    spentTokens: 0,
    windowHours: Number(input.quota?.windowHours ?? DEFAULT_WINDOW_HOURS),
    windowStartedAt: nowIso(now)
  };
  if (!Number.isFinite(quota.tokenBudget) || quota.tokenBudget <= 0) throw new Error("quota.tokenBudget must be a positive number");
  if (!Number.isFinite(quota.windowHours) || quota.windowHours <= 0) throw new Error("quota.windowHours must be a positive number");
  return {
    id,
    objective,
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
    priorityStack: [...(input.priorityStack ?? [])].map(String),
    nonGoals: [...(input.nonGoals ?? [])].map(String),
    nextAction: String(input.nextAction ?? ""),
    gates: [],
    todos: [],
    evidence: [],
    quota,
    history: [],
    completedAt: null,
    completionSummary: ""
  };
}

export function openGates(goal) {
  return goal.gates.filter((gate) => gate.status === "open");
}

export function canComplete(goal) {
  return openGates(goal).length === 0;
}

/**
 * loopx quota-aware should-run guard: gates first (an open gate blocks the
 * lane but allows audited fallback on non-dependent lanes), then the token
 * window (exhausted → not eligible with nextEligibleAt; expired window is
 * rolled over). Returns a decision, not a permission gate — callers may
 * still continue non-dependent lanes and must record the fallback.
 */
export function shouldRunGoal(goal, { now = () => new Date().toISOString() } = {}) {
  const open = openGates(goal);
  if (open.length) {
    const gate = open[0];
    return {
      eligible: false,
      reason: "gate_open",
      gate: gate.name,
      gateKind: gate.kind,
      fallbackAllowed: true
    };
  }
  const windowMs = Number(goal.quota.windowHours) * 3600_000;
  const windowStarted = parseTime(goal.quota.windowStartedAt ?? goal.createdAt);
  const nowMs = parseTime(nowIso(now));
  if (nowMs === null) throw new Error("invalid now timestamp");
  let windowReset = false;
  if (windowStarted !== null && nowMs - windowStarted >= windowMs) {
    goal.quota.spentTokens = 0;
    goal.quota.windowStartedAt = new Date(nowMs).toISOString();
    windowReset = true;
  }
  const spent = Number(goal.quota.spentTokens) || 0;
  const budget = Number(goal.quota.tokenBudget) || 0;
  if (spent >= budget) {
    const nextEligibleAt = windowStarted !== null ? new Date(windowStarted + windowMs).toISOString() : null;
    return { eligible: false, reason: "quota_exhausted", spent, budget, nextEligibleAt, windowReset };
  }
  return { eligible: true, reason: "ok", spent, budget, remaining: Math.max(0, budget - spent), windowReset };
}

/**
 * Spend quota tokens on validated writeback (loopx: spend only after the
 * turn produced validated progress). Rolls an expired window forward first.
 */
export function spendGoalTokens(goal, tokens, { now = () => new Date().toISOString() } = {}) {
  const amount = Math.max(0, Number(tokens) || 0);
  const windowMs = Number(goal.quota.windowHours) * 3600_000;
  const windowStarted = parseTime(goal.quota.windowStartedAt ?? goal.createdAt);
  const nowMs = parseTime(nowIso(now));
  if (nowMs === null) throw new Error("invalid now timestamp");
  let windowReset = false;
  if (windowStarted !== null && nowMs - windowStarted >= windowMs) {
    goal.quota.spentTokens = 0;
    goal.quota.windowStartedAt = new Date(nowMs).toISOString();
    windowReset = true;
  }
  goal.quota.spentTokens = Number(goal.quota.spentTokens) + amount;
  const budget = Number(goal.quota.tokenBudget) || 0;
  return {
    spent: goal.quota.spentTokens,
    budget,
    remaining: Math.max(0, budget - goal.quota.spentTokens),
    windowReset
  };
}

/**
 * Todo claim with TTL lease (loopx task_lease): an unexpired lease blocks
 * other owners; an expired lease can be re-claimed.
 */
export function claimTodoInGoal(goal, todoId, { owner, ttlMs = DEFAULT_LEASE_TTL_MS, now = () => new Date().toISOString() } = {}) {
  const todo = goal.todos.find((entry) => entry.id === todoId);
  if (!todo) return { ok: false, reason: "no_such_todo" };
  if (todo.status === "done") return { ok: false, reason: "already_done" };
  const nowMs = parseTime(nowIso(now));
  if (nowMs === null) throw new Error("invalid now timestamp");
  if (todo.status === "claimed") {
    const expiry = parseTime(todo.leaseExpiresAt);
    if (expiry !== null && expiry > nowMs) {
      return { ok: false, reason: "leased", owner: todo.owner, leaseExpiresAt: todo.leaseExpiresAt };
    }
  }
  todo.status = "claimed";
  todo.owner = String(owner ?? "");
  todo.claimedAt = new Date(nowMs).toISOString();
  todo.leaseExpiresAt = new Date(nowMs + ttlMs).toISOString();
  return { ok: true, todo };
}

export function handoffGoal(goal, { to, note = "", now = () => new Date().toISOString() } = {}) {
  if (!String(to ?? "").trim()) throw new Error("handoff target is required");
  const at = nowIso(now);
  goal.updatedAt = at;
  goal.history.push({ at, kind: "handoff", detail: String(to).trim(), meta: { note: String(note ?? "") } });
  return { ok: true, at, to: String(to).trim() };
}

export function appendEvidenceInGoal(goal, { kind, detail, artifactPath = "", now = () => new Date().toISOString() } = {}) {
  if (!String(kind ?? "").trim()) throw new Error("evidence kind is required");
  const record = {
    id: `ev-${randomUUID()}`,
    at: nowIso(now),
    kind: String(kind).trim(),
    detail: String(detail ?? ""),
    artifactPath: String(artifactPath ?? "")
  };
  goal.evidence.push(record);
  return record;
}

/**
 * Completion requires every gate satisfied (loopx: gates gate completion).
 * Open todos do not block — they become the next actions.
 */
export function completeGoalInGoal(goal, { summary = "", now = () => new Date().toISOString() } = {}) {
  const open = openGates(goal);
  if (open.length) return { ok: false, openGates: open.map((gate) => gate.name) };
  const at = nowIso(now);
  goal.completedAt = at;
  goal.completionSummary = String(summary ?? "");
  goal.updatedAt = at;
  goal.history.push({ at, kind: "completed", detail: String(summary ?? "") });
  return { ok: true, goal };
}

/**
 * Durable goal store backed by goal-state.json. Mutating methods persist
 * atomically. `now` is injectable for deterministic tests.
 *
 * @param {{ projectRoot: string; rootDir?: string; now?: () => string }} options
 */
export function createGoalStore({ projectRoot, rootDir = ".pi/runtime/goals", now = () => new Date().toISOString() } = {}) {
  const root = path.resolve(projectRoot);
  const file = goalStatePath(root, rootDir);
  assertWorkspacePath(root, file, "goalState.rootDir");
  let state = loadGoalState(file) ?? { schemaVersion: GOAL_STATE_SCHEMA_VERSION, activeGoalId: null, goals: {} };

  const save = () => {
    saveGoalState(file, state);
    return state;
  };

  const touch = (goal) => {
    goal.updatedAt = nowIso(now);
  };

  const findGoal = (id) => {
    const goal = state.goals[id];
    if (!goal) throw new Error(`no such goal: ${id}`);
    return goal;
  };

  return {
    file,
    load: () => state,

    activateGoal(input = {}) {
      const goal = createGoal(input, { now });
      state.goals[goal.id] = goal;
      state.activeGoalId = goal.id;
      goal.history.push({ at: nowIso(now), kind: "activated", detail: goal.objective });
      save();
      return goal;
    },

    activeGoal() {
      return state.activeGoalId ? state.goals[state.activeGoalId] ?? null : null;
    },

    updateGoal(id, patch = {}) {
      const goal = findGoal(id);
      if (patch.objective !== undefined) {
        const objective = String(patch.objective).trim();
        if (!objective) throw new Error("objective must be non-empty");
        goal.objective = objective;
      }
      if (patch.priorityStack !== undefined) goal.priorityStack = [...patch.priorityStack].map(String);
      if (patch.nonGoals !== undefined) goal.nonGoals = [...patch.nonGoals].map(String);
      if (patch.nextAction !== undefined) goal.nextAction = String(patch.nextAction ?? "");
      touch(goal);
      goal.history.push({ at: nowIso(now), kind: "updated", detail: String(patch.objective ?? "") });
      save();
      return goal;
    },

    setGate(id, name, { status = "open", resolution = "", question = "", kind } = {}) {
      const goal = findGoal(id);
      if (!GATE_STATUSES.includes(status)) throw new Error(`invalid gate status: ${status}`);
      let gate = goal.gates.find((entry) => entry.name === name);
      const at = nowIso(now);
      if (!gate) {
        const gateKind = kind ?? (String(question).includes("quality") ? "quality_gate" : "user_gate");
        if (!GATE_KINDS.includes(gateKind)) throw new Error(`invalid gate kind: ${gateKind}`);
        gate = { name, kind: gateKind, question: String(question ?? ""), status: "open", resolution: "", resolvedAt: null };
        goal.gates.push(gate);
      }
      gate.status = status;
      if (status !== "open") {
        gate.resolution = String(resolution ?? "");
        gate.resolvedAt = at;
      }
      touch(goal);
      goal.history.push({ at, kind: "gate", detail: `${name}: ${status}`, meta: { resolution: gate.resolution } });
      save();
      return gate;
    },

    addTodo(id, { text } = {}) {
      const goal = findGoal(id);
      if (!String(text ?? "").trim()) throw new Error("todo text is required");
      const todo = {
        id: `todo-${randomUUID()}`,
        text: String(text).trim(),
        status: "open",
        owner: "",
        leaseExpiresAt: null,
        claimedAt: null,
        completedAt: null,
        evidence: []
      };
      goal.todos.push(todo);
      touch(goal);
      goal.history.push({ at: nowIso(now), kind: "todo", detail: `added ${todo.text}` });
      save();
      return todo;
    },

    claimTodo(id, todoId, { owner = "agent", ttlMs = DEFAULT_LEASE_TTL_MS } = {}) {
      const goal = findGoal(id);
      const result = claimTodoInGoal(goal, todoId, { owner, ttlMs, now });
      if (result.ok) {
        touch(goal);
        goal.history.push({ at: nowIso(now), kind: "todo", detail: `claimed ${todoId} by ${owner}` });
        save();
      }
      return result;
    },

    completeTodo(id, todoId, { evidence = "" } = {}) {
      const goal = findGoal(id);
      const todo = goal.todos.find((entry) => entry.id === todoId);
      if (!todo) return { ok: false, reason: "no_such_todo" };
      if (todo.status === "done") return { ok: false, reason: "already_done" };
      todo.status = "done";
      todo.completedAt = nowIso(now);
      if (String(evidence ?? "").trim()) todo.evidence.push(String(evidence).trim());
      touch(goal);
      goal.history.push({ at: nowIso(now), kind: "todo", detail: `completed ${todoId}` });
      save();
      return { ok: true, todo };
    },

    appendEvidence(id, input = {}) {
      const goal = findGoal(id);
      const record = appendEvidenceInGoal(goal, { ...input, now });
      touch(goal);
      goal.history.push({ at: nowIso(now), kind: "evidence", detail: record.kind });
      save();
      return record;
    },

    spendTokens(id, tokens) {
      const goal = findGoal(id);
      const accounting = spendGoalTokens(goal, tokens, { now });
      touch(goal);
      goal.history.push({ at: nowIso(now), kind: "spend", detail: String(tokens), meta: accounting });
      save();
      return accounting;
    },

    shouldRun(id) {
      const goal = findGoal(id);
      const decision = shouldRunGoal(goal, { now });
      if (decision.windowReset) save();
      return decision;
    },

    handoff(id, input = {}) {
      const goal = findGoal(id);
      const result = handoffGoal(goal, { ...input, now });
      save();
      return result;
    },

    recordFallback(id, { gate, note = "" } = {}) {
      const goal = findGoal(id);
      const at = nowIso(now);
      goal.history.push({ at, kind: "fallback", detail: String(gate ?? ""), meta: { note: String(note ?? "") } });
      touch(goal);
      save();
      return { ok: true, at };
    },

    completeGoal(id, { summary = "" } = {}) {
      const goal = findGoal(id);
      const result = completeGoalInGoal(goal, { summary, now });
      if (result.ok) save();
      return result;
    },

    status() {
      const active = this.activeGoal();
      return {
        activeGoalId: state.activeGoalId,
        goalCount: Object.keys(state.goals).length,
        active: active
          ? {
              id: active.id,
              objective: active.objective,
              openGates: openGates(active).map((gate) => ({ name: gate.name, kind: gate.kind, question: gate.question })),
              todos: {
                open: active.todos.filter((todo) => todo.status === "open").length,
                claimed: active.todos.filter((todo) => todo.status === "claimed").length,
                done: active.todos.filter((todo) => todo.status === "done").length
              },
              evidenceCount: active.evidence.length,
              quota: { spent: active.quota.spentTokens, budget: active.quota.tokenBudget, windowHours: active.quota.windowHours },
              completedAt: active.completedAt
            }
          : null,
        file
      };
    }
  };
}
