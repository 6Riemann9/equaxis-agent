import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canComplete,
  claimTodoInGoal,
  completeGoalInGoal,
  createGoal,
  createGoalStore,
  goalStatePath,
  handoffGoal,
  loadGoalState,
  openGates,
  saveGoalState,
  shouldRunGoal,
  spendGoalTokens
} from "../src/goal-state.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-state-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function clock(startIso = "2026-08-15T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms) => {
      t += ms;
    }
  };
}

test("createGoal validates objective and quota", () => {
  assert.throws(() => createGoal({}, { now: clock().now }), /objective is required/);
  assert.throws(() => createGoal({ objective: "x", quota: { tokenBudget: 0 } }, { now: clock().now }), /tokenBudget/);
  assert.throws(() => createGoal({ objective: "x", quota: { windowHours: -1 } }, { now: clock().now }), /windowHours/);
  const goal = createGoal({ id: "g1", objective: "Ship feature", priorityStack: ["a"], nonGoals: ["b"], nextAction: "write code" }, { now: clock().now });
  assert.equal(goal.id, "g1");
  assert.equal(goal.objective, "Ship feature");
  assert.deepEqual(goal.priorityStack, ["a"]);
  assert.equal(goal.completedAt, null);
  assert.equal(goal.quota.spentTokens, 0);
});

test("openGates and canComplete gate completion", () => {
  const c = clock();
  const goal = createGoal({ id: "g1", objective: "x" }, { now: c.now });
  assert.equal(canComplete(goal), true);
  goal.gates.push({ name: "user-approval", kind: "user_gate", question: "Approve the plan?", status: "open", resolution: "", resolvedAt: null });
  assert.deepEqual(openGates(goal).map((gate) => gate.name), ["user-approval"]);
  assert.equal(canComplete(goal), false);

  const blocked = completeGoalInGoal(goal, { now: c.now });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.openGates, ["user-approval"]);

  goal.gates[0].status = "satisfied";
  goal.gates[0].resolvedAt = c.now();
  const done = completeGoalInGoal(goal, { summary: "all good", now: c.now });
  assert.equal(done.ok, true);
  assert.equal(goal.completedAt, c.now());
  assert.equal(goal.completionSummary, "all good");
});

test("shouldRunGoal: gates block with audited fallback; quota gates by window", () => {
  const c = clock();
  const goal = createGoal({ id: "g1", objective: "x", quota: { tokenBudget: 100, windowHours: 24 } }, { now: c.now });

  const ok = shouldRunGoal(goal, { now: c.now });
  assert.deepEqual(ok, { eligible: true, reason: "ok", spent: 0, budget: 100, remaining: 100, windowReset: false });

  goal.gates.push({ name: "review", kind: "quality_gate", question: "Run the suite?", status: "open", resolution: "", resolvedAt: null });
  const gated = shouldRunGoal(goal, { now: c.now });
  assert.equal(gated.eligible, false);
  assert.equal(gated.reason, "gate_open");
  assert.equal(gated.gate, "review");
  assert.equal(gated.fallbackAllowed, true);

  goal.gates[0].status = "satisfied";
  spendGoalTokens(goal, 100, { now: c.now });
  const exhausted = shouldRunGoal(goal, { now: c.now });
  assert.equal(exhausted.eligible, false);
  assert.equal(exhausted.reason, "quota_exhausted");
  assert.equal(exhausted.spent, 100);
  assert.equal(exhausted.nextEligibleAt, "2026-08-16T00:00:00.000Z");

  // window rollover resets spend
  c.advance(25 * 3600 * 1000);
  const rolled = shouldRunGoal(goal, { now: c.now });
  assert.equal(rolled.eligible, true);
  assert.equal(rolled.windowReset, true);
  assert.equal(rolled.spent, 0);
});

test("spendGoalTokens accounts after validated writeback", () => {
  const c = clock();
  const goal = createGoal({ id: "g1", objective: "x", quota: { tokenBudget: 50, windowHours: 1 } }, { now: c.now });
  const first = spendGoalTokens(goal, 30, { now: c.now });
  assert.deepEqual(first, { spent: 30, budget: 50, remaining: 20, windowReset: false });
  const second = spendGoalTokens(goal, 30, { now: c.now });
  assert.equal(second.spent, 60);
  assert.equal(second.remaining, 0);
  assert.equal(spendGoalTokens(goal, -5, { now: c.now }).spent, 60);
});

test("claimTodoInGoal enforces TTL leases and allows re-claim after expiry", () => {
  const c = clock();
  const goal = createGoal({ id: "g1", objective: "x" }, { now: c.now });
  goal.todos.push({ id: "t1", text: "do the thing", status: "open", owner: "", leaseExpiresAt: null, claimedAt: null, completedAt: null, evidence: [] });

  const claim = claimTodoInGoal(goal, "t1", { owner: "agent-a", ttlMs: 60_000, now: c.now });
  assert.equal(claim.ok, true);
  assert.equal(claim.todo.owner, "agent-a");

  const blocked = claimTodoInGoal(goal, "t1", { owner: "agent-b", ttlMs: 60_000, now: c.now });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "leased");
  assert.equal(blocked.owner, "agent-a");

  c.advance(61_000);
  const reClaim = claimTodoInGoal(goal, "t1", { owner: "agent-b", ttlMs: 60_000, now: c.now });
  assert.equal(reClaim.ok, true);
  assert.equal(reClaim.todo.owner, "agent-b");

  assert.equal(claimTodoInGoal(goal, "nope", { owner: "x", now: c.now }).reason, "no_such_todo");
});

test("handoffGoal records an evidence-backed handoff", () => {
  const c = clock();
  const goal = createGoal({ id: "g1", objective: "x" }, { now: c.now });
  const result = handoffGoal(goal, { to: "session-b", note: "context in evidence", now: c.now });
  assert.equal(result.ok, true);
  assert.equal(result.to, "session-b");
  const handoff = goal.history.find((entry) => entry.kind === "handoff");
  assert.equal(handoff.meta.note, "context in evidence");
  assert.throws(() => handoffGoal(goal, { to: "" }), /handoff target is required/);
});

test("store persists every mutation and reloads as one restart packet", (t) => {
  const root = workspace(t);
  const c = clock();
  const store = createGoalStore({ projectRoot: root, now: c.now });

  const goal = store.activateGoal({ id: "g1", objective: "Land the release", priorityStack: ["p1"], nextAction: "merge PR" });
  assert.equal(store.status().activeGoalId, "g1");
  assert.equal(store.status().active.objective, "Land the release");

  store.updateGoal("g1", { objective: "Land the release v2" });
  const todo = store.addTodo("g1", { text: "run the suite" });
  assert.equal(store.claimTodo("g1", todo.id, { owner: "agent-a" }).ok, true);
  store.appendEvidence("g1", { kind: "test", detail: "node suite green", artifactPath: "reports/x" });
  store.spendTokens("g1", 42);
  store.setGate("g1", "review", { question: "Approve?", status: "satisfied", resolution: "approved" });
  store.handoff("g1", { to: "night-run", note: "continue tomorrow" });

  assert.equal(store.shouldRun("g1").eligible, true); // gate satisfied, 42 < budget

  const reloaded = createGoalStore({ projectRoot: root, now: c.now });
  const state = reloaded.load();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.activeGoalId, "g1");
  const restored = state.goals.g1;
  assert.equal(restored.objective, "Land the release v2");
  assert.equal(restored.todos[0].status, "claimed");
  assert.equal(restored.todos[0].owner, "agent-a");
  assert.equal(restored.evidence[0].kind, "test");
  assert.equal(restored.quota.spentTokens, 42);
  assert.equal(restored.gates[0].status, "satisfied");
  assert.equal(restored.gates[0].resolution, "approved");
  assert.ok(restored.history.some((entry) => entry.kind === "handoff"));

  // completion after all gates satisfied
  const complete = reloaded.completeGoal("g1", { summary: "shipped" });
  assert.equal(complete.ok, true);
  assert.equal(reloaded.status().active.completedAt !== null, true);
});

test("store refuses to complete with open gates and records audited fallback", (t) => {
  const root = workspace(t);
  const c = clock();
  const store = createGoalStore({ projectRoot: root, now: c.now });
  store.activateGoal({ id: "g1", objective: "x" });
  store.setGate("g1", "approval", { kind: "user_gate", question: "Approve scope?" });
  assert.equal(store.completeGoal("g1", { summary: "done" }).ok, false);

  const run = store.shouldRun("g1");
  assert.equal(run.eligible, false);
  assert.equal(run.fallbackAllowed, true);
  store.recordFallback("g1", { gate: "approval", note: "proceeded on non-dependent lane" });
  assert.ok(store.load().goals.g1.history.some((entry) => entry.kind === "fallback"));
});

test("goal state file rejects corrupt content and enforces workspace path", (t) => {
  const root = workspace(t);
  const file = goalStatePath(root, ".pi/runtime/goals");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "not json");
  assert.equal(loadGoalState(file), null);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 9, goals: {} }));
  assert.equal(loadGoalState(file), null);
  assert.equal(loadGoalState(path.join(root, "missing.json")), null);

  const outside = path.join(os.tmpdir(), "outside-goals");
  assert.throws(() => createGoalStore({ projectRoot: root, rootDir: outside }), /must stay inside the project root/);
});

test("saveGoalState round-trips through goalStatePath", (t) => {
  const root = workspace(t);
  const file = goalStatePath(root, ".pi/runtime/goals");
  const state = { schemaVersion: 1, activeGoalId: "g1", goals: { g1: { id: "g1", objective: "x" } } };
  saveGoalState(file, state);
  assert.equal(loadGoalState(file).goals.g1.objective, "x");
});
