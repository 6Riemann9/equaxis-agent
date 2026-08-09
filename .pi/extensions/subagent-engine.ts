import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createExtensionRuntimeServices } from "../../src/extension-runtime-services.mjs";
import { SubagentRuntime } from "../../src/subagent-runtime.mjs";
import { createPiJsonExecutor } from "../../src/subagent-executor.mjs";

interface SubagentEngineConfig {
  enabled: boolean;
  maxConcurrent: number;
  piEntry: string;
  jsonArgs: string[];
  budgets?: {
    timeoutMs?: number | null;
    maxRetries?: number;
  };
}

const resultSchemaParameter = Type.Optional(Type.Object({}, {
  additionalProperties: true,
  description: "Optional JSON result schema checked after the subagent finishes"
}));

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultPiEntry = path.join(
  projectRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js"
);

export default function subagentEngine(pi: ExtensionAPI): void {
  const services = createExtensionRuntimeServices({
    cwd: process.cwd(),
    extensionId: "subagent-engine",
    pi
  });
  const config = services.config.subagents as SubagentEngineConfig | undefined;
  const runtime = new SubagentRuntime({
    maxConcurrent: config?.maxConcurrent ?? 2,
    defaultTimeoutMs: config?.budgets?.timeoutMs ?? null,
    defaultMaxRetries: config?.budgets?.maxRetries ?? 0,
    executor: createPiJsonExecutor({
      piEntry: config?.piEntry || defaultPiEntry,
      args: config?.jsonArgs ?? []
    }),
    trace: (event: string, data: Record<string, unknown>) => services.trace.record({} as ExtensionContext, `subagent_${event}`, data)
  });

  function trace(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}): void {
    services.trace.record(ctx, event, data);
  }

  pi.registerTool({
    name: "subagent_schedule",
    label: "Subagent Schedule",
    description: "Declaratively schedule a DAG of subagents; independent nodes run in parallel, dependent nodes wait on their dependencies.",
    promptSnippet: "Schedule a graph of subagents with dependencies",
    promptGuidelines: [
      "Use subagent_schedule when multiple subagents should run, some in parallel and some depending on others.",
      "Each node has a name, prompt, and optional dependsOn referencing sibling names. Children run in isolated Pi JSON subprocesses.",
      "Dependent nodes wait until their dependency nodes complete; independent nodes run concurrently (bounded by maxConcurrent)."
    ],
    parameters: Type.Object({
      nodes: Type.Array(Type.Object({
        name: Type.String({ description: "Stable node name referenced by dependsOn" }),
        prompt: Type.String({ minLength: 1, description: "Self-contained subagent prompt" }),
        dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Node names this node waits for" })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 600000, description: "Per-node timeout in milliseconds" })),
        maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "Per-node retry count after failures" })),
        traceId: Type.Optional(Type.String({ description: "Optional trace correlation id" })),
        schema: resultSchemaParameter
      }))
    }),
    async execute(_toolCallId, params) {
      const spawned = runtime.schedule(params.nodes).map((status) => status!);
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
    description: "Wait for one or more subagents to settle and return their final statuses and results.",
    promptSnippet: "Wait for subagents to finish",
    parameters: Type.Object({
      ids: Type.Array(Type.String({ minLength: 1 }), { description: "Subagent ids to wait for" })
    }),
    async execute(_toolCallId, params) {
      const statuses = (await runtime.waitAll(params.ids)).map((status) => status!);
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
}
