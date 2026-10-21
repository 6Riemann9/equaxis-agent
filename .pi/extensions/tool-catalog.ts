import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defaultToolCatalog } from "../../src/tool-catalog.mjs";

export default function toolCatalogExtension(pi: ExtensionAPI): void {
  /** Live MCP tools (mcp__server__tool) from the kernel's registry. Pi < 1.x
   * has no dynamic MCP registration; the guard keeps the dual-kernel build
   * working. Deferred/codemode MCP tools are invisible to the static catalog
   * — without this merge, tool_search can never discover them, which defeats
   * the deferred exposure model (skill-embedded MCP included). */
  function liveMcpCandidates(query: string, namespaceFilter?: string): Array<{ name: string; namespace: string; summary: string; score: number; kind: string }> {
    const getAllTools = (pi as unknown as { getAllTools?: () => Array<{ name: string; namespace?: string; description?: string; exposure?: string }> }).getAllTools;
    if (typeof getAllTools !== "function") return [];
    let tools: Array<{ name: string; namespace?: string; description?: string; exposure?: string }>;
    try {
      tools = getAllTools.call(pi) ?? [];
    } catch {
      return [];
    }
    const queryTokens = String(query ?? "").toLowerCase().split(/[^a-z0-9_.-]+/).filter((token) => token.length > 1);
    const candidates: Array<{ name: string; namespace: string; summary: string; score: number; kind: string }> = [];
    for (const tool of tools) {
      if (!tool?.name?.startsWith("mcp__")) continue;
      if (tool.exposure === "hidden") continue;
      const server = tool.name.split("__")[1] ?? "";
      const shortName = tool.name.split("__").slice(2).join("__") || tool.name;
      if (namespaceFilter && namespaceFilter !== `mcp__${server}` && namespaceFilter !== server) continue;
      const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
      let score = 0;
      for (const token of queryTokens) {
        if (haystack.includes(token)) score += 1;
        if (shortName.toLowerCase().includes(token)) score += 1;
        if (server.toLowerCase().includes(token)) score += 1;
      }
      if (score === 0 && queryTokens.length) continue;
      candidates.push({
        name: tool.name,
        namespace: `mcp__${server}`,
        summary: `${tool.description ? String(tool.description).slice(0, 160) : "MCP tool from " + server} (server: ${server}, tool: ${shortName})`,
        score,
        kind: "mcp"
      });
    }
    return candidates.sort((a, b) => b.score - a.score);
  }

  /** Deferred-load semantics: activate matched MCP tools (additive only) so
   * the model can call them on the next turn. Unknown/hidden names are
   * ignored by the kernel; failures degrade to a no-op. */
  function activateMatchedMcpTools(pi: ExtensionAPI, candidates: Array<{ name: string; kind: string }>): string[] {
    if (!candidates.length) return [];
    const controller = pi as unknown as { getActiveTools?: () => string[]; setActiveTools?: (names: string[]) => void };
    if (typeof controller.getActiveTools !== "function" || typeof controller.setActiveTools !== "function") return [];
    try {
      const active = controller.getActiveTools.call(pi) ?? [];
      const additions = candidates.map((candidate) => candidate.name).filter((name) => !active.includes(name));
      if (!additions.length) return [];
      controller.setActiveTools.call(pi, [...active, ...additions]);
      return additions;
    } catch {
      return [];
    }
  }

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
      const mcpResults = liveMcpCandidates(params.query, params.namespace);
      // Merge: MCP candidates first (they are the live, session-specific
      // surface the static catalog cannot know), then static catalog hits.
      const merged = [...mcpResults, ...results].slice(0, params.limit ?? 5);
      // Deferred-exposure load semantics (the built-in tool_search does the
      // same): activate matched MCP tools for the next model call. Only
      // additions — never remove tools the model already has.
      const activated = activateMatchedMcpTools(pi, mcpResults);
      return {
        content: [{ type: "text", text: JSON.stringify({ query: params.query, candidates: merged, activated }, null, 2) }],
        details: { query: params.query, candidates: merged, activated, catalogSize: defaultToolCatalog.size, mcpCandidates: mcpResults.length }
      };
    }
  });
}
