import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defaultToolCatalog } from "../../src/tool-catalog.mjs";

export default function toolCatalogExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "tool_search",
    label: "Tool Search",
    description: "Search the smallest relevant set of available tools before choosing an unfamiliar tool.",
    promptSnippet: "Find candidate tools by task, namespace, or capability",
    promptGuidelines: [
      "Use tool_search when more than one tool could satisfy the request or the required tool is unfamiliar.",
      "Prefer the highest-scoring candidate, then inspect its full schema before execution."
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Task or capability to search for" }),
      namespace: Type.Optional(Type.String({ description: "Optional namespace such as workspace, memory, web, or execution" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
      maxTokens: Type.Optional(Type.Integer({ minimum: 50, maximum: 4000, default: 1200 }))
    }),
    async execute(_toolCallId, params) {
      const results = defaultToolCatalog.search(params.query, params);
      return {
        content: [{ type: "text", text: JSON.stringify({ query: params.query, candidates: results }, null, 2) }],
        details: { query: params.query, candidates: results, catalogSize: defaultToolCatalog.size }
      };
    }
  });
}
