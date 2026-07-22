import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/config.mjs";
import { RISK, classifyToolCall, shouldBlockForLimits, validateToolInput } from "../../src/policy.mjs";
import { registerRepairAttempt, validationFeedback } from "../../src/tool-repair.mjs";

type HarnessMode = "enforce" | "audit" | "off";
type Phase = "idle" | "planning" | "executing" | "awaiting_approval" | "complete";

interface HarnessConfig {
  mode: HarnessMode;
  traceDir: string;
  protectPaths: string[];
  approval: {
    highRiskBash: boolean;
    writesOutsideWorkspace: boolean;
    sessionFork: boolean;
  };
  limits: {
    maxToolCallsPerTurn: number;
    maxHighRiskCallsPerTurn: number;
    maxRepairAttemptsPerError: number;
  };
}

interface HarnessState {
  mode: HarnessMode;
  phase: Phase;
  turnCount: number;
  toolCalls: number;
  blockedCalls: number;
  approvedCalls: number;
  failedCalls: number;
  toolCallsThisTurn: number;
  highRiskCallsThisTurn: number;
  lastRisk: string;
}

interface PendingTool {
  startedAt: number;
  risk: string;
  reason: string;
}

interface PersistedState extends Omit<HarnessState, "toolCallsThisTurn" | "highRiskCallsThisTurn"> {}

const STATE_ENTRY = "equaxis-reliability-state";
const STATUS_KEY = "equaxis";
const RELIABILITY_PROMPT = `

## Equaxis Reliability Harness
You are running inside Equaxis, a Pi-powered agent governed by a Reliability Harness. Preserve normal Pi behavior while following these controls:
- Inspect evidence before proposing or executing changes.
- Prefer reversible, scoped operations and verify material changes after execution.
- Never bypass a blocked tool call, split it into evasive commands, or expose credentials.
- High-risk actions require explicit human approval; a denial is final for that action.
- Treat tool errors as evidence, explain uncertainty, and stop when safe execution cannot be established.
- When the tool set is large or the capability is unfamiliar, use the tool_search tool first and choose from the returned candidates; never guess a tool name from memory.
- When a request needs multiple tool calls, use the tool_schedule tool to express dependencies and parallel-safe read tasks before execution.
`;

function initialState(mode: HarnessMode): HarnessState {
  return {
    mode,
    phase: "idle",
    turnCount: 0,
    toolCalls: 0,
    blockedCalls: 0,
    approvedCalls: 0,
    failedCalls: 0,
    toolCallsThisTurn: 0,
    highRiskCallsThisTurn: 0,
    lastRisk: RISK.LOW
  };
}

function isMode(value: unknown): value is HarnessMode {
  return value === "enforce" || value === "audit" || value === "off";
}

function compactInput(event: ToolCallEvent, redact = false): Record<string, unknown> {
  const input = event.input && typeof event.input === "object"
    ? event.input as Record<string, unknown>
    : {};
  if (redact) return { redacted: true, keys: Object.keys(input) };
  if (event.toolName === "bash") {
    return { command: String(input.command ?? "").slice(0, 800) };
  }
  if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "read") {
    return { path: String(input.path ?? ""), keys: Object.keys(input) };
  }
  return { keys: Object.keys(input) };
}

function persisted(state: HarnessState): PersistedState {
  return {
    mode: state.mode,
    phase: state.phase,
    turnCount: state.turnCount,
    toolCalls: state.toolCalls,
    blockedCalls: state.blockedCalls,
    approvedCalls: state.approvedCalls,
    failedCalls: state.failedCalls,
    lastRisk: state.lastRisk
  };
}

export default function reliabilityHarness(pi: ExtensionAPI): void {
  let config = loadConfig(process.cwd()) as HarnessConfig;
  let state = initialState(isMode(config.mode) ? config.mode : "enforce");
  let traceFile = path.resolve(process.cwd(), config.traceDir, "traces.jsonl");
  const pending = new Map<string, PendingTool>();
  const repairAttempts = new Map<string, number>();

  pi.registerFlag("equaxis-mode", {
    description: "Equaxis governance mode: enforce, audit, or off",
    type: "string"
  });

  function trace(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}): void {
    const record = {
      timestamp: new Date().toISOString(),
      sessionId: ctx.sessionManager.getSessionId(),
      mode: state.mode,
      phase: state.phase,
      event,
      ...data
    };
    try {
      fs.mkdirSync(path.dirname(traceFile), { recursive: true });
      fs.appendFileSync(traceFile, `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Harness trace failed: ${String(error)}`, "error");
    }
  }

  function updateStatus(ctx: ExtensionContext): void {
    const risk = state.lastRisk === RISK.LOW ? "" : ` · ${state.lastRisk}`;
    ctx.ui.setStatus(
      STATUS_KEY,
      `Equaxis ${state.mode} · ${state.phase}${risk} · blocked ${state.blockedCalls}`
    );
  }

  function saveState(): void {
    pi.appendEntry(STATE_ENTRY, persisted(state));
  }

  function restoreState(ctx: ExtensionContext): void {
    const latest = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY)
      .pop() as { data?: Partial<PersistedState> } | undefined;

    const configuredMode = isMode(config.mode) ? config.mode : "enforce";
    state = initialState(configuredMode);
    if (!latest?.data) return;

    const restoredMode = isMode(latest.data.mode) ? latest.data.mode : configuredMode;
    state = {
      ...state,
      ...latest.data,
      mode: restoredMode,
      phase: "idle",
      toolCallsThisTurn: 0,
      highRiskCallsThisTurn: 0
    };
  }

  function evalSnapshot(): Record<string, number> {
    const attempted = state.toolCalls + state.blockedCalls;
    return {
      attemptedCalls: attempted,
      executedCalls: state.toolCalls,
      blockedCalls: state.blockedCalls,
      approvedCalls: state.approvedCalls,
      failedCalls: state.failedCalls,
      failureRate: state.toolCalls === 0 ? 0 : Number((state.failedCalls / state.toolCalls).toFixed(4)),
      guardrailRate: attempted === 0 ? 0 : Number((state.blockedCalls / attempted).toFixed(4))
    };
  }

  pi.on("session_start", async (event, ctx) => {
    config = loadConfig(ctx.cwd) as HarnessConfig;
    traceFile = path.resolve(ctx.cwd, config.traceDir, "traces.jsonl");
    restoreState(ctx);
    const cliMode = pi.getFlag("equaxis-mode");
    if (isMode(cliMode)) state.mode = cliMode;
    pending.clear();
    repairAttempts.clear();
    trace(ctx, "session_start", { reason: event.reason, traceFile });
    updateStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreState(ctx);
    trace(ctx, "state_reconstructed", { source: "session_tree" });
    updateStatus(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    trace(ctx, "agent_requested", { promptLength: event.prompt.length });
    if (state.mode === "off") return;
    return { systemPrompt: `${event.systemPrompt}${RELIABILITY_PROMPT}` };
  });

  pi.on("turn_start", async (event, ctx) => {
    state.turnCount += 1;
    state.phase = "planning";
    state.toolCallsThisTurn = 0;
    state.highRiskCallsThisTurn = 0;
    repairAttempts.clear();
    trace(ctx, "turn_start", { turnIndex: event.turnIndex });
    updateStatus(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (state.mode === "off") return;

    let classification: { risk: string; reason: string; approval: boolean };
    try {
      const validation = validateToolInput(event.toolName, event.input);
      if (validation) {
        const repair = registerRepairAttempt(
          repairAttempts,
          event.toolName,
          validation,
          config.limits.maxRepairAttemptsPerError
        );
        const feedback = validationFeedback(event.toolName, validation, repair);
        const reason = repair.allowed
          ? `INVALID_ARGUMENT: ${JSON.stringify(feedback)}`
          : `REPAIR_EXHAUSTED: ${JSON.stringify(feedback)}`;
        trace(ctx, "tool_validation_failed", {
          toolName: event.toolName,
          field: "field" in validation ? validation.field : undefined,
          errorCode: validation.code,
          retryable: validation.retryable,
          repairAttempt: repair.attempt,
          maxRepairAttempts: repair.maxAttempts,
          repairAllowed: repair.allowed,
          input: compactInput(event, true)
        });
        if (state.mode === "enforce") {
          state.blockedCalls += 1;
          updateStatus(ctx);
          return { block: true, reason: `Reliability Harness: ${reason}` };
        }
      }
      classification = classifyToolCall(event.toolName, event.input, config, ctx.cwd);
    } catch (error) {
      const dangerousTool = event.toolName === "bash" || event.toolName === "write" || event.toolName === "edit";
      trace(ctx, "policy_error", { toolName: event.toolName, error: String(error), failClosed: dangerousTool });
      if (dangerousTool && state.mode === "enforce") {
        state.blockedCalls += 1;
        updateStatus(ctx);
        return { block: true, reason: "Reliability policy failed; dangerous tool blocked fail-closed" };
      }
      return;
    }

    state.lastRisk = classification.risk;
    const limitReason = shouldBlockForLimits(state, config, classification);
    state.toolCallsThisTurn += 1;
    if (classification.risk === RISK.HIGH) state.highRiskCallsThisTurn += 1;
    const containsSecret = classification.reason === "possible raw secret in tool arguments";
    const decision = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: compactInput(event, containsSecret),
      risk: classification.risk,
      reason: classification.reason
    };

    if (limitReason && state.mode === "enforce") {
      state.blockedCalls += 1;
      trace(ctx, "tool_blocked", { ...decision, reason: limitReason });
      updateStatus(ctx);
      return { block: true, reason: `Reliability Harness: ${limitReason}` };
    }

    const policyBlocked = classification.risk === RISK.BLOCKED;
    if (policyBlocked && (state.mode === "enforce" || containsSecret)) {
      state.blockedCalls += 1;
      trace(ctx, "tool_blocked", decision);
      if (ctx.hasUI) ctx.ui.notify(`Harness blocked ${event.toolName}: ${classification.reason}`, "warning");
      updateStatus(ctx);
      return { block: true, reason: `Reliability Harness: ${classification.reason}` };
    }

    if (classification.approval && state.mode === "enforce") {
      state.phase = "awaiting_approval";
      trace(ctx, "approval_requested", decision);
      updateStatus(ctx);

      if (!ctx.hasUI) {
        state.blockedCalls += 1;
        state.phase = "planning";
        trace(ctx, "tool_blocked", { ...decision, reason: "high-risk action has no approval UI" });
        updateStatus(ctx);
        return { block: true, reason: "Reliability Harness: high-risk action blocked because approval UI is unavailable" };
      }

      const summary = event.toolName === "bash"
        ? String((event.input as Record<string, unknown>).command ?? "")
        : String((event.input as Record<string, unknown>).path ?? event.toolName);
      const approved = await ctx.ui.confirm(
        `High-risk ${event.toolName} action`,
        `${classification.reason}\n\n${summary.slice(0, 1200)}\n\nAllow this single tool call?`
      );
      if (!approved) {
        state.blockedCalls += 1;
        state.phase = "planning";
        trace(ctx, "approval_denied", decision);
        updateStatus(ctx);
        return { block: true, reason: "Reliability Harness: high-risk action denied by user" };
      }
      state.approvedCalls += 1;
      trace(ctx, "approval_granted", decision);
    }

    state.toolCalls += 1;
    state.phase = "executing";
    pending.set(event.toolCallId, {
      startedAt: performance.now(),
      risk: classification.risk,
      reason: classification.reason
    });
    trace(ctx, state.mode === "audit" && (policyBlocked || limitReason) ? "tool_audit_violation" : "tool_allowed", {
      ...decision,
      limitReason
    });
    updateStatus(ctx);
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    if (state.mode === "off") return;
    const call = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (event.isError) state.failedCalls += 1;
    state.phase = "planning";
    trace(ctx, "tool_result", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      risk: call?.risk ?? "unknown",
      isError: event.isError,
      latencyMs: call ? Number((performance.now() - call.startedAt).toFixed(2)) : undefined
    });
    updateStatus(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    state.phase = "complete";
    trace(ctx, "turn_end", { turnIndex: event.turnIndex, evaluation: evalSnapshot() });
    saveState();
    updateStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    trace(ctx, "agent_end", { evaluation: evalSnapshot() });
  });

  pi.on("session_before_fork", async (event, ctx) => {
    if (!config.approval.sessionFork || state.mode !== "enforce") return;
    if (!ctx.hasUI) {
      trace(ctx, "fork_blocked", { entryId: event.entryId, reason: "approval UI unavailable" });
      return { cancel: true };
    }
    const approved = await ctx.ui.confirm(
      "Fork governed session?",
      "The Harness state will be reconstructed from the selected branch. Continue?"
    );
    trace(ctx, approved ? "fork_approved" : "fork_blocked", { entryId: event.entryId });
    if (!approved) return { cancel: true };
  });

  pi.registerCommand("equaxis", {
    description: "Show Equaxis governance status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Equaxis ${state.mode}; phase=${state.phase}; turns=${state.turnCount}; tools=${state.toolCalls}; blocked=${state.blockedCalls}; failed=${state.failedCalls}`,
        "info"
      );
    }
  });

  pi.registerCommand("equaxis-mode", {
    description: "Set Equaxis mode: enforce, audit, or off",
    getArgumentCompletions: (prefix) => ["enforce", "audit", "off"]
      .filter((mode) => mode.startsWith(prefix.trim().toLowerCase()))
      .map((mode) => ({ value: mode, label: mode })),
    handler: async (args, ctx) => {
      const nextMode = args.trim().toLowerCase();
      if (!isMode(nextMode)) {
        ctx.ui.notify("Usage: /equaxis-mode enforce|audit|off", "warning");
        return;
      }
      state.mode = nextMode;
      state.phase = "idle";
      saveState();
      trace(ctx, "mode_changed", { mode: nextMode });
      updateStatus(ctx);
      ctx.ui.notify(`Equaxis mode: ${nextMode}`, "info");
    }
  });

  pi.registerCommand("equaxis-policy", {
    description: "Show active Equaxis policy",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Mode=${state.mode}; protected=${config.protectPaths.join(", ")}; maxTools/turn=${config.limits.maxToolCallsPerTurn}; maxHighRisk/turn=${config.limits.maxHighRiskCallsPerTurn}`,
        "info"
      );
    }
  });

  pi.registerCommand("equaxis-trace", {
    description: "Show the JSONL audit trace path",
    handler: async (_args, ctx) => ctx.ui.notify(traceFile, "info")
  });

  pi.registerCommand("equaxis-eval", {
    description: "Show the current reliability evaluation snapshot",
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(evalSnapshot()), "info")
  });
}
