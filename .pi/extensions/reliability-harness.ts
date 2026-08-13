import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import { createEvalEvent } from "../../src/eval-loop.mjs";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  approvalRoot,
  cleanupApprovals,
  readApprovalDecision,
  writeApprovalDecision as persistApprovalDecision,
  writeApprovalRequest as persistApprovalRequest
} from "../../src/approval-queue.mjs";
import { createExtensionRuntimeServices } from "../../src/extension-runtime-services.mjs";
import { RISK, classifyToolCall, containsSecretLikeInput, shouldBlockForLimits, validateToolInput } from "../../src/policy.mjs";
import { createToolInvocation, createToolOutcome, riskMetadataFromPolicy } from "../../src/tool-contract.mjs";
import { validateEditFreshness } from "../../src/stale-edit.mjs";
import { registerRepairAttempt, validationFeedback } from "../../src/tool-repair.mjs";

type HarnessMode = "enforce" | "audit" | "off";
type Phase = "idle" | "planning" | "executing" | "awaiting_approval" | "complete";

interface HarnessConfig {
  mode: HarnessMode;
  traceDir: string;
  trace: { maxFileBytes: number; maxFiles: number };
  protectPaths: string[];
  approval: {
    highRiskBash: boolean;
    writesOutsideWorkspace: boolean;
    externalEditPolicy: "prompt" | "auto" | "deny";
    externalEditRoots: string[];
    sessionFork: boolean;
    webQueue: { enabled: boolean; timeoutMs: number };
    denyRephrase: boolean;
    batchPerTurn: boolean;
  };
  limits: {
    maxToolCallsPerTurn: number;
    maxHighRiskCallsPerTurn: number;
    maxRepairAttemptsPerError: number;
    maxRepeatedCalls: number;
  };
  costBrake: {
    enabled: boolean;
    maxSessionCostUsd: number;
    warnAtFraction: number;
  };
}

interface MissionState {
  objective: string;
  startedAt: string;
  turns: number;
  lastOutcome: "ok" | "failed" | "none";
  status: "idle" | "active" | "complete";
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
  // Lightweight mission tracking: the current objective, its progress and
  // outcome. This is the harness-side analog of a task/goal state; it is
  // persisted with the session so forks and restarts keep the picture.
  mission: MissionState;
  failedCallsAtTurnStart: number;
  // Set when the user opted into approving the remaining high-risk calls
  // of this turn (approval.batchPerTurn); transient, never persisted.
  batchApprovedTurn: boolean;
  // Session cost brake state: once triggered, high-risk calls are blocked
  // until the budget is reset (/equaxis-budget reset). Persisted.
  costBrakeTriggered: boolean;
  costWarned: boolean;
}

interface PendingTool {
  startedAt: number;
  risk: string;
  reason: string;
  capability: string;
  toolName: string;
}

interface ActiveModel {
  provider: string;
  id: string;
}

interface PersistedState extends Omit<HarnessState, "toolCallsThisTurn" | "highRiskCallsThisTurn" | "failedCallsAtTurnStart" | "batchApprovedTurn"> {}

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
    lastRisk: RISK.LOW,
    mission: { objective: "", startedAt: "", turns: 0, lastOutcome: "none", status: "idle" },
    failedCallsAtTurnStart: 0,
    batchApprovedTurn: false,
    costBrakeTriggered: false,
    costWarned: false
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

function capabilityForTool(toolName: string): string {
  if (toolName === "read") return "repo-inspect";
  if (toolName === "write" || toolName === "edit") return "code-edit";
  if (toolName === "bash") return "command-execution";
  if (toolName === "web_crawl" || toolName === "search" || toolName === "scrape" || toolName === "crawl") return "web-research";
  if (toolName === "tool_search" || toolName === "tool_schedule") return "tool-orchestration";
  if (toolName === "advisor_consult") return "advisor-review";
  if (toolName === "lsp_probe") return "language-protocol";
  if (toolName === "dap_probe") return "debug-protocol";
  if (toolName === "memory_search" || toolName === "recall" || toolName === "memory_query_entity") return "memory-recall";
  if (toolName === "memory_remember" || toolName === "retain" || toolName === "memory_add_fact" || toolName === "learn" || toolName === "memory_edit") return "memory-write";
  if (toolName === "acp_delegate" || toolName === "workflow") return "subagent-orchestration";
  return "unlabeled";
}

function currentModelFromContext(ctx: ExtensionContext): ActiveModel {
  const model = ctx.model as { provider?: string; id?: string } | undefined;
  return {
    provider: model?.provider ?? "unknown",
    id: model?.id ?? "unknown"
  };
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
    lastRisk: state.lastRisk,
    mission: state.mission,
    costBrakeTriggered: state.costBrakeTriggered,
    costWarned: state.costWarned
  };
}

export default function reliabilityHarness(pi: ExtensionAPI): void {
  const services = createExtensionRuntimeServices({
    cwd: process.cwd(),
    extensionId: "reliability",
    pi
  });
  let config = services.config.reliability as HarnessConfig;
  let state = initialState(isMode(config.mode) ? config.mode : "enforce");
  let traceFile = services.paths.traceFile;
  const pending = new Map<string, PendingTool>();
  const repairAttempts = new Map<string, number>();
  // Loop stop condition: consecutive identical tool calls (same name and
  // argument hash) within a turn indicate a retry loop. Reset per turn.
  let consecutiveCalls: { signature: string; count: number } = { signature: "", count: 0 };
  // Eval outcomes are runtime facts and are written to the trace stream only
  // (eval_outcome_recorded). The offline eval ledger, dashboards and the
  // harbor export derive them from the trace; the runtime never imports the
  // evaluation core (see docs/ARCHITECTURE_REDUCTION_DIRECTIVE.md P5).
  let activeModel: ActiveModel = { provider: "unknown", id: "unknown" };

  pi.registerFlag("equaxis-mode", {
    description: "Equaxis governance mode: enforce, audit, or off",
    type: "string"
  });

  function trace(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}): void {
    services.trace.record(ctx, event, { mode: state.mode, phase: state.phase, ...data });
  }

  const approvalProjectRoot = () => services.paths.workspace;

  function writeApprovalRequest(cfg: HarnessConfig, requestId: string, toolName: string, summary: string, reason: string): string | null {
    const web = cfg.approval?.webQueue;
    if (!web?.enabled) return null;
    try {
      return persistApprovalRequest(approvalProjectRoot(), cfg.traceDir, { requestId, toolName, summary, reason });
    } catch {
      return null;
    }
  }

  function writeApprovalDecision(cfg: HarnessConfig, requestId: string, decision: "approve" | "deny"): boolean {
    const web = cfg.approval?.webQueue;
    if (!web?.enabled) return false;
    try {
      persistApprovalDecision(approvalProjectRoot(), cfg.traceDir, requestId, decision);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Wait for a web approval decision. Event-driven via fs.watch on the
   * decisions directory (wakes the waiter on file changes) with a bounded
   * poll fallback for platforms where fs.watch is unreliable. Resolves on
   * decision, timeout, or abort.
   */
  async function waitForWebApproval(cfg: HarnessConfig, requestId: string, signal?: AbortSignal): Promise<"approve" | "deny" | null> {
    const web = cfg.approval?.webQueue;
    if (!web?.enabled) return null;
    const timeoutMs = Math.max(1000, web.timeoutMs ?? 60_000);
    const deadline = Date.now() + timeoutMs;
    const decisionsDir = path.join(approvalRoot(approvalProjectRoot(), cfg.traceDir), "decisions");
    let watcher: fs.FSWatcher | null = null;
    let wake: (() => void) | null = null;
    const sleep = (ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => { clearTimeout(timer); resolve(); };
    });
    try {
      fs.mkdirSync(decisionsDir, { recursive: true });
      watcher = fs.watch(decisionsDir, { persistent: false }, () => wake?.());
    } catch {
      watcher = null; // fs.watch unavailable: fall back to plain polling
    }
    try {
      // With a watcher we are woken on changes; poll only as a safety net.
      const pollMs = watcher ? 5000 : 1000;
      while (Date.now() < deadline) {
        if (signal?.aborted) return null;
        const decision = readApprovalDecision(approvalProjectRoot(), cfg.traceDir, requestId);
        if (decision?.decision === "approve" || decision?.decision === "deny") return decision.decision;
        await sleep(pollMs);
      }
      return null;
    } finally {
      watcher?.close();
    }
  }

  function updateStatus(ctx: ExtensionContext): void {
    const risk = state.lastRisk === RISK.LOW ? "" : ` · ${state.lastRisk}`;
    services.status.set(
      ctx,
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
      highRiskCallsThisTurn: 0,
      failedCallsAtTurnStart: 0,
      batchApprovedTurn: false,
      costBrakeTriggered: latest.data.costBrakeTriggered ?? false,
      costWarned: latest.data.costWarned ?? false,
      // Snapshots from before mission tracking lack the field; keep a safe default.
      mission: latest.data.mission ?? { objective: "", startedAt: "", turns: 0, lastOutcome: "none", status: "idle" }
    };
  }

  /** Sum assistant-message usage cost across the current session branch. */
  function sessionCost(ctx: ExtensionContext): number {
    let cost = 0;
    try {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "message" && entry.message?.role === "assistant") {
          cost += Number(entry.message.usage?.cost?.total ?? 0);
        }
      }
    } catch {
      // session iteration is best-effort; a failure never blocks tool calls
    }
    return cost;
  }

  /** Warn at a fraction of the session budget, then hard-stop high-risk calls. */
  function applyCostBrake(ctx: ExtensionContext): void {
    const brake = config.costBrake;
    if (!brake?.enabled || state.mode === "off") return;
    const cost = sessionCost(ctx);
    const limit = brake.maxSessionCostUsd;
    if (state.costBrakeTriggered) return;
    if (!state.costWarned && limit > 0 && cost >= limit * brake.warnAtFraction) {
      state.costWarned = true;
      trace(ctx, "cost_brake_warning", { costUsd: Number(cost.toFixed(4)), limitUsd: limit });
      if (ctx.hasUI) ctx.ui.notify(`Session cost ${cost.toFixed(4)} USD approaching the ${limit} USD budget.`, "warning");
    }
    if (limit > 0 && cost >= limit) {
      state.costBrakeTriggered = true;
      trace(ctx, "cost_brake_triggered", { costUsd: Number(cost.toFixed(4)), limitUsd: limit });
      if (ctx.hasUI) ctx.ui.notify(`Session cost ${cost.toFixed(4)} USD reached the ${limit} USD budget. High-risk calls are now blocked; run /equaxis-budget reset to resume.`, "error");
    }
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
    config = services.configure(ctx.cwd).reliability as HarnessConfig;
    traceFile = services.paths.traceFile;
    try {
      cleanupApprovals(services.paths.workspace, config.traceDir);
    } catch {
      // best effort
    }
    restoreState(ctx);
    const cliMode = pi.getFlag("equaxis-mode");
    if (isMode(cliMode)) state.mode = cliMode;
    pending.clear();
    repairAttempts.clear();
    activeModel = currentModelFromContext(ctx);
    trace(ctx, "session_start", { reason: event.reason, traceFile, profile: services.config.runtime.profile });
    updateStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreState(ctx);
    trace(ctx, "state_reconstructed", { source: "session_tree" });
    updateStatus(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    trace(ctx, "agent_requested", { promptLength: event.prompt.length });
    // Track the current objective as a lightweight mission so long-running
    // work keeps a progress picture across turns and forks.
    if (!containsSecretLikeInput({ content: event.prompt })) {
      const objective = event.prompt.trim().slice(0, 160);
      if (objective && objective !== state.mission.objective) {
        state.mission.objective = objective;
        state.mission.startedAt = new Date().toISOString();
        state.mission.status = "active";
      }
    }
    if (state.mode === "off") return;
    return { systemPrompt: `${event.systemPrompt}${RELIABILITY_PROMPT}` };
  });

  pi.on("model_select", async (event) => {
    activeModel = { provider: event.model.provider, id: event.model.id };
  });

  pi.on("turn_start", async (event, ctx) => {
    state.turnCount += 1;
    state.phase = "planning";
    state.toolCallsThisTurn = 0;
    state.highRiskCallsThisTurn = 0;
    state.failedCallsAtTurnStart = state.failedCalls;
    state.batchApprovedTurn = false;
    consecutiveCalls = { signature: "", count: 0 };
    repairAttempts.clear();
    trace(ctx, "turn_start", { turnIndex: event.turnIndex });
    updateStatus(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (state.mode === "off") return;

    let classification: { risk: string; reason: string; approval: boolean };
    try {
      const validation = validateToolInput(event.toolName, event.input)
        ?? validateEditFreshness(event.toolName, event.input, { cwd: ctx.cwd });
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
        // Audit mode lets the call through but still counts it so the
        // per-turn tool limit applies to repeated invalid calls too.
        state.toolCallsThisTurn += 1;
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
    // Unified tool contract: the invocation envelope carries policy risk
    // metadata; trace consumers keep the legacy field names via spread.
    const invocation = createToolInvocation({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      arguments: compactInput(event, containsSecret),
      risk: classification.risk,
      reason: classification.reason
    });
    const decision = {
      ...invocation,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: compactInput(event, containsSecret),
      risk: classification.risk,
      reason: classification.reason
    };

    // Cost brake: once the session budget is exhausted, high-risk calls are
    // blocked until the user resets the budget (/equaxis-budget reset).
    if (state.costBrakeTriggered && classification.risk === RISK.HIGH && state.mode === "enforce") {
      state.blockedCalls += 1;
      trace(ctx, "tool_blocked", { ...decision, reason: "session cost budget exhausted" });
      updateStatus(ctx);
      return { block: true, reason: `Reliability Harness: session cost budget reached (${config.costBrake?.maxSessionCostUsd} USD); run /equaxis-budget reset to resume` };
    }

    // Loop stop condition: the same call repeated consecutively is a retry
    // loop. Block further repeats this turn and record the stop condition.
    const callSignature = `${event.toolName}:${createHash("sha256").update(JSON.stringify(event.input ?? {})).digest("hex").slice(0, 16)}`;
    if (callSignature === consecutiveCalls.signature) consecutiveCalls.count += 1;
    else consecutiveCalls = { signature: callSignature, count: 1 };
    const loopStopped = (config.limits.maxRepeatedCalls ?? 3) > 0 && consecutiveCalls.count >= config.limits.maxRepeatedCalls;
    if (loopStopped && state.mode === "enforce") {
      state.blockedCalls += 1;
      trace(ctx, "loop_stop_triggered", { ...decision, repeats: consecutiveCalls.count, limit: config.limits.maxRepeatedCalls });
      updateStatus(ctx);
      return { block: true, reason: `Reliability Harness: repeated identical ${event.toolName} call (${consecutiveCalls.count}x) suggests a loop; stop and reassess` };
    }

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

      const summary = event.toolName === "bash"
        ? String((event.input as Record<string, unknown>).command ?? "")
        : String((event.input as Record<string, unknown>).path ?? event.toolName);

      // Persist the request so the pi-web approvals panel can see it.
      let webRequestId: string | null = null;
      try {
        webRequestId = writeApprovalRequest(config, event.toolCallId, event.toolName, summary, classification.reason);
      } catch (error) {
        trace(ctx, "approval_queue_write_failed", { error: String(error) });
      }

      // TUI sessions decide interactively (structured options); headless
      // sessions poll the web decision queue for a bounded window instead of
      // blocking outright. A prior "approve the rest of this turn" choice
      // (approval.batchPerTurn) skips the dialog for later high-risk calls.
      let approved: boolean;
      let batchApproved = false;
      if (state.batchApprovedTurn && config.approval?.batchPerTurn) {
        approved = true;
        batchApproved = true;
        trace(ctx, "approval_batched", decision);
      } else if (ctx.hasUI) {
        // Show the detail first, then a structured choice: approve, deny,
        // deny+rephrase, or batch-approve the rest of the turn.
        ctx.ui.notify(`${classification.reason}\n\n${summary.slice(0, 1200)}`, "warning");
        const options = ["Approve this call", "Deny this call"];
        if (config.approval?.denyRephrase) options.push("Deny and rephrase this call");
        if (config.approval?.batchPerTurn) options.push("Approve this call and all remaining high-risk calls this turn");
        const dialogTimeout = Math.max(10000, config.approval?.webQueue?.timeoutMs ?? 60_000);
        const choice = await ctx.ui.select(
          `High-risk ${event.toolName} action: ${classification.reason}`,
          options,
          { signal: ctx.signal, timeout: dialogTimeout }
        );
        approved = choice?.startsWith("Approve") ?? false;
        if (choice?.startsWith("Approve this call and all")) {
          state.batchApprovedTurn = true;
          batchApproved = true;
        }
        if (!approved && choice?.startsWith("Deny and rephrase")) {
          // Tell the model what to change instead of blindly retrying the
          // same call (which the loop stop condition would then block).
          state.blockedCalls += 1;
          state.phase = "planning";
          const denyReason = `High-risk action denied; rephrase to avoid: ${classification.reason}`;
          trace(ctx, "approval_denied_rephrase", decision);
          updateStatus(ctx);
          return { block: true, reason: `Reliability Harness: ${denyReason}` };
        }
      } else if (!config.approval?.webQueue?.enabled) {
        state.blockedCalls += 1;
        state.phase = "planning";
        trace(ctx, "tool_blocked", { ...decision, reason: "high-risk action has no approval UI" });
        updateStatus(ctx);
        return { block: true, reason: "Reliability Harness: high-risk action blocked because approval UI is unavailable" };
      } else {
        const webDecision = await waitForWebApproval(config, event.toolCallId, ctx.signal);
        if (webDecision === null) {
          state.blockedCalls += 1;
          state.phase = "planning";
          trace(ctx, "tool_blocked", { ...decision, reason: `no web approval decision within ${config.approval.webQueue.timeoutMs}ms` });
          updateStatus(ctx);
          return { block: true, reason: "Reliability Harness: high-risk action blocked; no web approval decision arrived in time" };
        }
        approved = webDecision === "approve";
      }

      if (webRequestId) {
        try {
          writeApprovalDecision(config, event.toolCallId, approved ? "approve" : "deny");
        } catch {
          // best effort; the panel derives history from the trace stream too
        }
      }

      if (!approved) {
        state.blockedCalls += 1;
        state.phase = "planning";
        trace(ctx, "approval_denied", decision);
        updateStatus(ctx);
        return { block: true, reason: "Reliability Harness: high-risk action denied by user" };
      }
      state.approvedCalls += 1;
      trace(ctx, "approval_granted", { ...decision, batch: batchApproved });
    }

    state.toolCalls += 1;
    state.phase = "executing";
    pending.set(event.toolCallId, {
      startedAt: performance.now(),
      risk: classification.risk,
      reason: classification.reason,
      capability: capabilityForTool(event.toolName),
      toolName: event.toolName
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
    const latencyMs = call ? Number((performance.now() - call.startedAt).toFixed(2)) : undefined;
    // Runtime facts only: the outcome goes into the trace stream
    // (eval_outcome_recorded) so offline evaluation can rebuild full history.
    const evalEvent = createEvalEvent({
      provider: activeModel.provider,
      modelId: activeModel.id,
      toolName: event.toolName,
      capability: call?.capability ?? capabilityForTool(event.toolName),
      outcome: event.isError ? "failure" : "success",
      errorCode: event.isError ? "TOOL_ERROR" : null,
      latencyMs,
      traceId: event.toolCallId
    });
    trace(ctx, "eval_outcome_recorded", evalEvent);
    trace(ctx, "tool_result", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      risk: call?.risk ?? "unknown",
      capability: call?.capability ?? capabilityForTool(event.toolName),
      isError: event.isError,
      latencyMs,
      outcomeContract: createToolOutcome({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ok: !event.isError,
        error: event.isError ? "TOOL_ERROR" : null,
        retryable: false,
        evidence: call?.reason ? { risk: call.risk, reason: call.reason } : null
      }),
      riskMetadata: riskMetadataFromPolicy(call ? { risk: call.risk, reason: call.reason, approval: false } : undefined)
    });
    updateStatus(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    state.phase = "complete";
    // Tools that never delivered a tool_result (killed, timed out, aborted)
    // would otherwise leak in the pending map; report and drop them so the
    // next turn starts with a clean slate.
    for (const [toolCallId, call] of pending) {
      trace(ctx, "tool_pending_dropped", {
        toolCallId,
        toolName: call.toolName,
        risk: call.risk,
        reason: "no tool_result before turn end"
      });
    }
    pending.clear();
    state.mission.turns += 1;
    state.mission.lastOutcome = state.failedCalls > state.failedCallsAtTurnStart ? "failed" : "ok";
    applyCostBrake(ctx);
    trace(ctx, "turn_end", { turnIndex: event.turnIndex, evaluation: evalSnapshot(), mission: state.mission, costUsd: Number(sessionCost(ctx).toFixed(4)) });
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
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify({ reliability: evalSnapshot() }), "info")
  });

  pi.registerCommand("equaxis-mission", {
    description: "Show the current mission objective and progress",
    handler: async (_args, ctx) => {
      const mission = state.mission;
      if (!mission?.objective) {
        ctx.ui.notify("No mission tracked yet; start a new task to record one.", "info");
        return;
      }
      ctx.ui.notify(
        `Mission: ${mission.objective}\nstatus=${mission.status}; turns=${mission.turns}; lastOutcome=${mission.lastOutcome}; startedAt=${mission.startedAt}`,
        "info"
      );
    }
  });

  pi.registerCommand("equaxis-budget", {
    description: "Show the session cost budget and reset the brake",
    handler: async (args, ctx) => {
      const brake = config.costBrake;
      const cost = sessionCost(ctx);
      const action = args.trim().toLowerCase();
      if (action === "reset") {
        state.costBrakeTriggered = false;
        state.costWarned = false;
        saveState();
        trace(ctx, "cost_brake_reset", { costUsd: Number(cost.toFixed(4)), limitUsd: brake?.maxSessionCostUsd });
        ctx.ui.notify(`Cost brake reset. Session cost ${cost.toFixed(4)} USD.`, "info");
        return;
      }
      ctx.ui.notify(
        `Session cost: ${cost.toFixed(4)} USD${brake?.enabled ? ` of ${brake.maxSessionCostUsd} USD budget` : " (brake disabled)"}${state.costBrakeTriggered ? "; brake ACTIVE" : ""}`,
        "info"
      );
    }
  });
}
