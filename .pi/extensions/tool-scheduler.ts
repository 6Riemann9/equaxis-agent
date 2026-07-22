import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { scheduleTools } from "../../src/tool-scheduler.mjs";

const TASK = Type.Object({
  id: Type.String({ minLength: 1 }),
  toolName: Type.String({ minLength: 1 }),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  readOnly: Type.Optional(Type.Boolean({ default: true })),
  risk: Type.Optional(Type.String()),
  priority: Type.Optional(Type.Number()),
  estimatedMs: Type.Optional(Type.Number({ minimum: 0 }))
});

export default function toolSchedulerExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "tool_schedule",
    label: "Tool Schedule",
    description: "Build a safe execution schedule for multiple tool tasks with dependencies and concurrency limits.",
    promptSnippet: "Plan dependent and parallel tool calls before executing a multi-step workflow",
    promptGuidelines: [
      "Use tool_schedule when a request requires two or more tool calls.",
      "Read-only independent tasks may run in parallel; writes and high-risk tasks are scheduled alone."
    ],
    parameters: Type.Object({
      tasks: Type.Array(TASK, { minItems: 1, maxItems: 50 }),
      maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 4 }))
    }),
    async execute(_toolCallId, params) {
      try {
        const schedule = scheduleTools(params.tasks, params);
        return {
          content: [{ type: "text", text: JSON.stringify(schedule, null, 2) }],
          details: schedule
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Schedule rejected: ${String(error)}` }],
          details: { waves: [], waveCount: 0, maxParallelism: 0, estimatedCriticalPathMs: 0, error: String(error) }
        };
      }
    }
  });
}
