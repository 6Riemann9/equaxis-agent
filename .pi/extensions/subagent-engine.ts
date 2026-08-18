import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createExtensionRuntimeServices } from "../../src/extension-runtime-services.mjs";
import { SubagentRuntime } from "../../src/subagent-runtime.mjs";
import { createPiJsonExecutor } from "../../src/subagent-executor.mjs";
import { SubagentStateStore } from "../../src/subagent-state-store.mjs";
import { createFileEvidenceVerifier } from "../../src/subagent-evidence.mjs";
import { recordWisdom, wisdomPreamble } from "../../src/wisdom-store.mjs";
import { buildRolePrompt } from "../../src/role-templates.mjs";
import { createDeferredResultDelivery } from "../../src/deferred-result-delivery.mjs";

interface SubagentEngineConfig {
  enabled: boolean;
  maxConcurrent: number;
  piEntry: string;
  jsonArgs: string[];
  budgets?: {
    timeoutMs?: number | null;
    maxRetries?: number;
  };
  modelConcurrency?: Record<string, number>;
  categoryRoutes?: Record<string, { model?: string }>;
  persistence?: {
    enabled?: boolean;
    rootDir?: string;
  };
  evidence?: {
    enabled?: boolean;
  };
  isolation?: {
    enabled?: boolean;
    scrubEnv?: boolean;
    outputRoot?: string;
    extraEnvAllowlist?: string[];
    worktree?: boolean;
  };
}

const resultSchemaParameter = Type.Optional(Type.Object({}, {
  additionalProperties: true,
  description: "Optional JSON result schema checked after the subagent finishes"
}));

// packageRoot: resolves the bundled Pi CLI entry point (always from this file's location).
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultPiEntry = path.join(
  packageRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js"
);

// Content truncation limit matching vendored subagent extension.
const RESULT_OUTPUT_MAX_BYTES = 24000;

interface SubagentResultSnap {
  id: string;
  label: string;
  status: string;
  error?: string | null;
  result?: unknown;
  evidence?: unknown;
  review?: unknown;
}

function truncateOutput(text: string | null | undefined): string {
  if (!text) return "";
  return text.length > RESULT_OUTPUT_MAX_BYTES
    ? `${text.slice(0, RESULT_OUTPUT_MAX_BYTES)}\n... [truncated, ${text.length} chars total]`
    : text;
}

function buildResultContent(snap: { label: string; status: string; error?: string | null; result?: unknown }): string {
  const statusLine = `Subagent "${snap.label}" ${snap.status}.`;
  const errorLine = snap.status === "failed" && snap.error ? `\nError: ${snap.error}` : "";
  const output = snap.result != null
    ? truncateOutput(typeof snap.result === "string" ? snap.result : JSON.stringify(snap.result, null, 2))
    : "";
  return `${statusLine}${errorLine}${output ? `\n${output}` : ""}`;
}

export default function subagentEngine(pi: ExtensionAPI): void {
  const services = createExtensionRuntimeServices({ cwd: process.cwd(), extensionId: "subagent-engine", pi });
  const config = services.config.subagents as SubagentEngineConfig | undefined;

  // workspaceRoot: resolved at session_start from the actual working directory.
  // Used for stateStore, evidence, wisdom, and goal integration — never for
  // locating the bundled Pi CLI (that's packageRoot).
  let workspaceRoot = process.cwd();

  const stateStore = config?.persistence?.enabled === false
    ? null
    : new SubagentStateStore({ projectRoot: workspaceRoot, rootDir: config?.persistence?.rootDir ?? ".pi/runtime/subagents" });
  const resultDelivery = createDeferredResultDelivery();
  let sessionCtx: ExtensionContext | null = null;

  const runtime = new SubagentRuntime({
    maxConcurrent: config?.maxConcurrent ?? 2,
    defaultTimeoutMs: config?.budgets?.timeoutMs === undefined ? undefined : config.budgets.timeoutMs,
    defaultMaxRetries: config?.budgets?.maxRetries ?? 0,
    modelConcurrency: config?.modelConcurrency,
    categoryRoutes: config?.categoryRoutes,
    stateStore,
    verifyEvidence: config?.evidence?.enabled === false ? null : createFileEvidenceVerifier({ projectRoot: workspaceRoot }),
    onTaskComplete: (task: { id: string; label: string; status: string; result?: unknown; error?: string | null; evidence?: unknown; review?: unknown }) => {
      // Wisdom accumulation: persist a compact summary so later DAG batches
      // (and later sessions) reuse what this node learned.
      try {
        recordWisdom({ projectRoot: workspaceRoot, taskId: task.id, label: task.label, status: task.status, result: task.result ?? task.error ?? null });
      } catch {
        // best effort
      }
      // Publish settled event for goal-state integration (Step 3).
      try {
        pi.events.emit("subagent:settled", { id: task.id, label: task.label, status: task.status, error: task.error ?? null, evidence: task.evidence ?? null });
      } catch {
        // best effort
      }
      // Buffer result for automatic delivery to the main agent (Step 2).
      try {
        const snap = {
          id: task.id,
          label: task.label,
          status: task.status,
          error: task.error ?? null,
          result: task.result ?? null,
          evidence: task.evidence ?? null,
          review: task.review ?? null,
        };
        resultDelivery.defer(snap);
        if (sessionCtx?.isIdle?.()) flushResults();
      } catch {
        // best effort — delivery failure must not break task finalization
      }
    },
    executor: createPiJsonExecutor({
      piEntry: config?.piEntry || defaultPiEntry,
      args: config?.jsonArgs ?? [],
      projectRoot: services.paths.workspace,
      isolation: {
        enabled: config?.isolation?.enabled !== false,
        scrubEnv: config?.isolation?.scrubEnv,
        outputRoot: config?.isolation?.outputRoot,
        extraEnvAllowlist: config?.isolation?.extraEnvAllowlist,
        worktree: config?.isolation?.worktree === true
      }
    }),
    trace: (event: string, data: Record<string, unknown>) => services.trace.record({} as ExtensionContext, `subagent_${event}`, data)
  });

  function trace(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}): void {
    services.trace.record(ctx, event, data);
  }

  /** Deliver a single result to the parent agent as a follow-up message. */
  function deliverResult(snap: SubagentResultSnap): void {
    try {
      pi.sendMessage(
        {
          customType: "subagent-result",
          content: buildResultContent(snap),
          display: true,
          details: { id: snap.id, label: snap.label, status: snap.status },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      // Session may be shutting down — swallow.
    }
  }

  /** Flush all buffered results to the parent agent. */
  function flushResults(): void {
    for (const snap of resultDelivery.drain() as SubagentResultSnap[]) {
      deliverResult(snap);
    }
  }

  // --- Lifecycle hooks ---

  pi.on("session_start", (_event, ctx) => {
    sessionCtx = ctx;
    workspaceRoot = services.paths.workspace;
  });

  pi.on("agent_settled", () => {
    flushResults();
  });

  pi.on("session_shutdown", async () => {
    // Cancel all running/blocked/queued subagents so they don't orphan.
    try {
      const tasks = runtime.list();
      const cancellable = tasks.filter((t) => t && ["running", "blocked", "queued"].includes(t.status));
      const promises: Promise<unknown>[] = [];
      for (const task of cancellable) {
        if (!task) continue;
        const status = runtime.cancel(task.id, "session ended");
        // cancel returns the status; the task's promise will settle shortly.
      }
      // Give cancelled tasks a moment to settle their process cleanup.
      // eslint-disable-next-line no-restricted-syntax -- timeout requires executor form
      await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch {
      // best effort
    }
    sessionCtx = null;
    resultDelivery.clear();
  });

  // --- Tools ---

  pi.registerTool({
    name: "subagent_schedule",
    label: "Subagent Schedule",
    description: "Declaratively schedule a DAG of subagents; independent nodes run in parallel, dependent nodes wait on their dependencies.",
    promptSnippet: "Schedule a graph of subagents with dependencies",
    promptGuidelines: [
      "Use subagent_schedule when multiple subagents should run, some in parallel and some depending on others.",
      "Each node has a name, prompt, and optional dependsOn referencing sibling names. Children run in isolated Pi JSON subprocesses.",
      "Dependent nodes wait until their dependency nodes complete; independent nodes run concurrently (bounded by maxConcurrent).",
      "Results are delivered automatically when the parent agent is idle. Use subagent_check to peek at progress, or subagent_wait to block until done."
    ],
    parameters: Type.Object({
      nodes: Type.Array(Type.Object({
        name: Type.String({ description: "Stable node name referenced by dependsOn" }),
        prompt: Type.String({ minLength: 1, description: "Self-contained subagent prompt" }),
        dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Node names this node waits for" })),
        model: Type.Optional(Type.String({ description: "Model bucket key for per-model concurrency limits (optional)" })),
        category: Type.Optional(Type.String({ description: "Work category routed to a model via the category table (optional)" })),
        role: Type.Optional(Type.String({ description: "Role template (architect/analyst/engineer/expert) wrapping the prompt (optional)" })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 600000, description: "Per-node timeout in milliseconds" })),
        maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "Per-node retry count after failures" })),
        traceId: Type.Optional(Type.String({ description: "Optional trace correlation id" })),
        schema: resultSchemaParameter
      }))
    }),
    async execute(_toolCallId, params) {
      const routedNodes = params.nodes.map((node) => node.role
        ? { ...node, prompt: buildRolePrompt(node.role, node.prompt) }
        : node);
      const spawned = runtime.schedule(routedNodes, { wisdomRoot: workspaceRoot }).map((status) => status!);
      trace({} as ExtensionContext, "subagent_schedule", { count: spawned.length });
      return {
        content: [{ type: "text", text: JSON.stringify(spawned, null, 2) }],
        details: { scheduled: spawned.length, nodes: spawned.map((s) => ({ name: s.label, id: s.id, status: s.status })) }
      };
    }
  });

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: "Spawn a single subagent in an isolated Pi JSON subprocess, optionally depending on other subagent ids.",
    promptSnippet: "Spawn one subagent",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Optional explicit subagent id" })),
      label: Type.Optional(Type.String({ description: "Human-readable label" })),
      prompt: Type.String({ minLength: 1, description: "Self-contained prompt" }),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Subagent ids this waits for" })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 600000, description: "Per-subagent timeout in milliseconds" })),
      maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "Retry count after failures" })),
      traceId: Type.Optional(Type.String({ description: "Optional trace correlation id" })),
      schema: resultSchemaParameter
    }),
    async execute(_toolCallId, params) {
      if (params.id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(params.id)) {
        throw new Error(`subagent id must be alphanumeric with . _ - (got ${JSON.stringify(params.id)})`);
      }
      const spawned = runtime.spawn({
        id: params.id,
        label: params.label,
        prompt: params.prompt,
        dependencies: params.dependsOn,
        timeoutMs: params.timeoutMs,
        maxRetries: params.maxRetries,
        traceId: params.traceId,
        schema: params.schema
      })!;
      trace({} as ExtensionContext, "subagent_spawn", { id: spawned.id, label: spawned.label });
      return {
        content: [{ type: "text", text: JSON.stringify(spawned, null, 2) }],
        details: spawned
      };
    }
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: "Wait for one or more subagents to settle and return their final statuses and results. Consumes buffered auto-delivery so results are not delivered twice.",
    promptSnippet: "Wait for subagents to finish",
    parameters: Type.Object({
      ids: Type.Array(Type.String({ minLength: 1 }), { description: "Subagent ids to wait for" })
    }),
    async execute(_toolCallId, params) {
      const statuses = (await runtime.waitAll(params.ids)).map((status) => status!);
      // Consume from delivery buffer so agent_settled won't re-deliver.
      resultDelivery.consume(params.ids);
      return {
        content: [{ type: "text", text: JSON.stringify(statuses, null, 2) }],
        details: statuses
      };
    }
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: "List all spawned subagents with their current status.",
    parameters: Type.Object({}),
    async execute() {
      const list = runtime.list().map((status) => status!);
      return {
        content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
        details: list
      };
    }
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: "Cancel one or more queued, blocked, or running subagents.",
    promptSnippet: "Cancel subagents",
    parameters: Type.Object({
      ids: Type.Array(Type.String({ minLength: 1 }), { description: "Subagent ids to cancel" }),
      reason: Type.Optional(Type.String({ description: "Optional cancel reason" }))
    }),
    async execute(_toolCallId, params) {
      const cancelled = params.ids.map((id) => runtime.cancel(id, params.reason)!).filter(Boolean);
      return {
        content: [{ type: "text", text: JSON.stringify(cancelled, null, 2) }],
        details: cancelled
      };
    }
  });

  pi.registerTool({
    name: "subagent_message",
    label: "Send Subagent Message",
    description: "Deliver a message to another subagent's inbox (peer messaging).",
    promptSnippet: "Message a subagent",
    parameters: Type.Object({
      to: Type.String({ minLength: 1, description: "Subagent id to message" }),
      message: Type.String({ minLength: 1, description: "Message body" })
    }),
    async execute(_toolCallId, params) {
      runtime.send(params.to, params.message);
      return {
        content: [{ type: "text", text: `message delivered to ${params.to}` }],
        details: { to: params.to }
      };
    }
  });

  pi.registerTool({
    name: "subagent_messages",
    label: "Read Subagent Messages",
    description: "Read and drain messages queued for a subagent.",
    promptSnippet: "Read a subagent's inbox",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: "Subagent id whose inbox to read" })
    }),
    async execute(_toolCallId, params) {
      const messages = runtime.messages(params.id);
      return {
        content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
        details: { id: params.id, messages }
      };
    }
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: "Non-blocking check on a subagent's current status, attempts, and recent error. Use this to peek at progress without blocking on subagent_wait.",
    promptSnippet: "Check subagent progress",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: "Subagent id to check" })
    }),
    async execute(_toolCallId, params) {
      const status = runtime.status(params.id);
      if (!status) {
        return {
          content: [{ type: "text", text: `Unknown subagent: ${params.id}` }],
          details: { id: params.id, found: false, status: null as unknown }
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        details: { id: params.id, found: true, status: status as unknown }
      };
    }
  });
}
