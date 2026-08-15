import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createExtensionRuntimeServices } from "../../src/extension-runtime-services.mjs";
import { createGoalStore } from "../../src/goal-state.mjs";

interface GoalStateConfig {
  enabled: boolean;
  rootDir: string;
  defaultQuota: { tokenBudget: number; windowHours: number };
}

interface GoalStatus {
  activeGoalId: string | null;
  goalCount: number;
  active: {
    id: string;
    objective: string;
    openGates: Array<{ name: string; kind: string; question: string }>;
    todos: { open: number; claimed: number; done: number };
    evidenceCount: number;
    quota: { spent: number; budget: number; windowHours: number };
    completedAt: string | null;
  } | null;
  file: string;
}

interface GoalStore {
  load(): { schemaVersion: number; activeGoalId: string | null; goals: Record<string, unknown> };
  activateGoal(input: { id?: string; objective: string; quota?: { tokenBudget: number; windowHours: number } }): { id: string; objective: string };
  activeGoal(): { id: string; objective: string } | null;
  updateGoal(id: string, patch: { objective?: string; nextAction?: string }): unknown;
  setGate(id: string, name: string, input: { status?: string; resolution?: string; question?: string; kind?: string }): unknown;
  addTodo(id: string, input: { text: string }): { id: string; text: string };
  claimTodo(id: string, todoId: string, input: { owner?: string }): { ok: boolean; reason?: string; owner?: string };
  completeTodo(id: string, todoId: string, input?: { evidence?: string }): { ok: boolean; reason?: string };
  appendEvidence(id: string, input: { kind: string; detail: string; artifactPath?: string }): { id: string };
  spendTokens(id: string, tokens: number): { spent: number; budget: number; remaining: number };
  shouldRun(id: string): { eligible: boolean; reason: string; gate?: string; nextEligibleAt?: string | null; spent?: number; budget?: number };
  handoff(id: string, input: { to: string; note?: string }): { ok: boolean };
  recordFallback(id: string, input: { gate: string; note?: string }): { ok: boolean };
  completeGoal(id: string, input: { summary?: string }): { ok: boolean; openGates?: string[] };
  status(): GoalStatus;
}

function parseQuota(config: GoalStateConfig): { tokenBudget: number; windowHours: number } {
  const quota = config.defaultQuota ?? {};
  return {
    tokenBudget: Number(quota.tokenBudget) || 200000,
    windowHours: Number(quota.windowHours) || 24
  };
}

function activeOrThrow(store: GoalStore): { id: string; objective: string } {
  const active = store.activeGoal();
  if (!active) throw new Error("no active goal; activate one first (/equaxis-goal activate <id> <objective>)");
  return active;
}

/**
 * GoalState (huangruiteng/loopx minimal slice): durable goal registry +
 * active-goal state file reloaded at session start. The objective, gates,
 * todos with leases, evidence, quota and handoffs survive restarts as one
 * authoritative JSON packet; open gates block completion but non-dependent
 * lanes may continue with an audited fallback record.
 */
export default function equaxisGoalState(pi: ExtensionAPI): void {
  const services = createExtensionRuntimeServices({ cwd: process.cwd(), extensionId: "goal-state", pi });
  let config = services.config.goalState as GoalStateConfig;
  let store: GoalStore | null = null;

  function trace(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}): void {
    services.trace.record(ctx, event, data);
  }

  function ensureStore(): GoalStore {
    if (store) return store;
    store = createGoalStore({
      projectRoot: services.paths.workspace,
      rootDir: config.rootDir
    }) as GoalStore;
    return store;
  }

  pi.on("session_start", async (_event, ctx) => {
    services.configure(ctx.cwd);
    config = services.config.goalState as GoalStateConfig;
    if (!config.enabled) return;
    store = null;
    const current = ensureStore();
    const status = current.status();
    trace(ctx, "goal_state_loaded", {
      enabled: true,
      activeGoalId: status.activeGoalId,
      objective: status.active?.objective ?? null,
      openGates: status.active?.openGates.map((gate) => gate.name) ?? [],
      file: status.file
    });
  });

  pi.registerTool({
    name: "goal_status",
    label: "Goal Status",
    description: "Show the durable active goal: objective, open gates, todo counts, quota spent, evidence count, completion state.",
    promptSnippet: "Check the active goal",
    promptGuidelines: [
      "Use goal_status at the start of a long task to resume the durable objective instead of re-deriving it.",
      "Open gates block completion; record evidence with /equaxis-goal evidence before satisfying them."
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params): Promise<AgentToolResult<{ enabled: boolean; status: GoalStatus | null }>> {
      if (!config.enabled) {
        return { content: [{ type: "text", text: "Goal state is disabled (.pi/equaxis.json goalState.enabled)." }], details: { enabled: false, status: null } };
      }
      const status = ensureStore().status();
      const active = status.active;
      const text = active
        ? `Active goal: ${active.objective}\nGates: ${active.openGates.length ? active.openGates.map((gate) => `${gate.name} (${gate.kind}): ${gate.question}`).join(" | ") : "none open"}\nTodos: ${active.todos.open} open / ${active.todos.claimed} claimed / ${active.todos.done} done\nQuota: ${active.quota.spent}/${active.quota.budget} tokens (${active.quota.windowHours}h window)\nEvidence: ${active.evidenceCount}\nCompleted: ${active.completedAt ?? "no"}`
        : "No active goal. Create one with /equaxis-goal activate <id> <objective>.";
      return {
        content: [{ type: "text", text }],
        details: { enabled: true, status }
      };
    }
  });

  pi.registerCommand("equaxis-goal", {
    description:
      "Durable goal state: status | activate <id> <objective> | update <objective> | gate <name> <satisfy|block|open> [detail] | todo <text> | claim <todoId> | done <todoId> | evidence <kind> <detail> | spend <tokens> | should-run | handoff <to> [note] | complete [summary]",
    handler: async (args, ctx) => {
      if (!config.enabled) {
        ctx.ui.notify("Goal state is disabled (.pi/equaxis.json goalState.enabled)", "info");
        return;
      }
      const current = ensureStore();
      const [subcommand, ...rest] = args.trim().split(/\s+/);
      const active = (): { id: string; objective: string } => activeOrThrow(current);

      try {
        switch (subcommand ?? "status") {
          case "status": {
            const status = current.status();
            const goal = status.active;
            ctx.ui.notify(
              goal
                ? `Active goal: ${goal.objective}\nGates: ${goal.openGates.length ? goal.openGates.map((g) => `${g.name} (${g.kind})`).join(", ") : "none open"}\nTodos: ${goal.todos.open} open / ${goal.todos.claimed} claimed / ${goal.todos.done} done\nQuota: ${goal.quota.spent}/${goal.quota.budget}\nEvidence: ${goal.evidenceCount}`
                : "No active goal. /equaxis-goal activate <id> <objective>",
              "info"
            );
            return;
          }
          case "activate": {
            const id = rest[0] ?? "";
            const objective = rest.slice(1).join(" ") || id;
            if (!id) throw new Error("activate requires <id>");
            const goal = current.activateGoal({ id, objective, quota: parseQuota(config) });
            trace(ctx, "goal_activated", { goalId: goal.id, objective: goal.objective });
            ctx.ui.notify(`Goal activated: ${goal.id} — ${goal.objective}`, "info");
            return;
          }
          case "update": {
            const objective = rest.join(" ");
            if (!objective) throw new Error("update requires an objective");
            const goal = active();
            current.updateGoal(goal.id, { objective });
            trace(ctx, "goal_updated", { goalId: goal.id, objective });
            ctx.ui.notify(`Goal updated: ${objective}`, "info");
            return;
          }
          case "gate": {
            const [name, status, ...detail] = rest;
            if (!name || !status) throw new Error("gate requires <name> <satisfy|block|open> [detail]");
            if (!["satisfy", "block", "open"].includes(status)) throw new Error("gate status must be satisfy, block, or open");
            const goal = active();
            const gate = current.setGate(goal.id, name, {
              status: status === "open" ? "open" : status === "satisfy" ? "satisfied" : "blocked",
              resolution: status === "open" ? "" : detail.join(" "),
              question: status === "open" ? detail.join(" ") : ""
            }) as { name: string; kind: string; status: string };
            trace(ctx, "goal_gate_resolved", { goalId: goal.id, gate: gate.name, status: gate.status });
            ctx.ui.notify(`Gate ${gate.name} (${gate.kind}) → ${gate.status}`, "info");
            return;
          }
          case "todo": {
            const text = rest.join(" ");
            if (!text) throw new Error("todo requires text");
            const goal = active();
            const todo = current.addTodo(goal.id, { text });
            ctx.ui.notify(`Todo added: ${todo.id} — ${text}`, "info");
            return;
          }
          case "claim": {
            const todoId = rest[0] ?? "";
            if (!todoId) throw new Error("claim requires <todoId>");
            const goal = active();
            const result = current.claimTodo(goal.id, todoId, { owner: "agent" });
            if (!result.ok) throw new Error(`cannot claim ${todoId}: ${result.reason}${result.owner ? ` (leased by ${result.owner})` : ""}`);
            ctx.ui.notify(`Claimed ${todoId}`, "info");
            return;
          }
          case "done": {
            const todoId = rest[0] ?? "";
            if (!todoId) throw new Error("done requires <todoId>");
            const goal = active();
            const result = current.completeTodo(goal.id, todoId);
            if (!result.ok) throw new Error(`cannot complete ${todoId}: ${result.reason}`);
            ctx.ui.notify(`Todo completed: ${todoId}`, "info");
            return;
          }
          case "evidence": {
            const [kind, ...detail] = rest;
            if (!kind || !detail.length) throw new Error("evidence requires <kind> <detail>");
            const goal = active();
            const record = current.appendEvidence(goal.id, { kind, detail: detail.join(" ") });
            trace(ctx, "goal_evidence", { goalId: goal.id, kind, evidenceId: record.id });
            ctx.ui.notify(`Evidence recorded: ${record.id} (${kind})`, "info");
            return;
          }
          case "spend": {
            const tokens = Number(rest[0]);
            if (!Number.isFinite(tokens) || tokens < 0) throw new Error("spend requires a non-negative token count");
            const goal = active();
            const accounting = current.spendTokens(goal.id, tokens);
            ctx.ui.notify(`Quota spent: ${accounting.spent}/${accounting.budget} (${accounting.remaining} left)`, "info");
            return;
          }
          case "should-run": {
            const goal = active();
            const decision = current.shouldRun(goal.id);
            const detail = decision.reason === "gate_open"
              ? `blocked by gate ${decision.gate} (non-dependent lanes may continue)`
              : decision.reason === "quota_exhausted"
                ? `quota exhausted (${decision.spent}/${decision.budget}); next eligible ${decision.nextEligibleAt ?? "unknown"}`
                : `eligible (${decision.spent}/${decision.budget} spent)`;
            ctx.ui.notify(decision.eligible ? `Should run: yes — ${detail}` : `Should run: no — ${detail}`, decision.eligible ? "info" : "warning");
            return;
          }
          case "handoff": {
            const to = rest[0] ?? "";
            const note = rest.slice(1).join(" ");
            if (!to) throw new Error("handoff requires <to> [note]");
            const goal = active();
            current.handoff(goal.id, { to, note });
            trace(ctx, "goal_handoff", { goalId: goal.id, to });
            ctx.ui.notify(`Handoff recorded → ${to}`, "info");
            return;
          }
          case "complete": {
            const summary = rest.join(" ");
            const goal = active();
            const result = current.completeGoal(goal.id, { summary });
            if (!result.ok) throw new Error(`cannot complete: open gates ${(result.openGates ?? []).join(", ")}`);
            trace(ctx, "goal_completed", { goalId: goal.id, summary });
            ctx.ui.notify("Goal completed", "info");
            return;
          }
          default:
            throw new Error(`unknown subcommand: ${subcommand}`);
        }
      } catch (error) {
        ctx.ui.notify(`equaxis-goal: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  });
}
