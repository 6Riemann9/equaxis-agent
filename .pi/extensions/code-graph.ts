import path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createExtensionRuntimeServices } from "../../src/extension-runtime-services.mjs";
import {
  buildCodeIndex,
  codeIndexPath,
  deadCodeReport,
  findSymbols,
  impactClosure,
  isIndexFresh,
  loadCodeIndex,
  queryCallees,
  queryCallers,
  queryExports,
  queryImporters,
  saveCodeIndex
} from "../../src/code-index.mjs";

interface CodeGraphConfig {
  enabled: boolean;
  rootDir: string;
  includeDirs: string[];
  maxFiles: number;
  rebuildIfStaleMs: number;
}

interface CodeSymbol {
  id: string;
  name: string;
  kind: string;
  qualifiedName: string;
  file: string;
  startLine: number;
  endLine: number;
  doc: string;
  exported: boolean;
}

interface CodeGraphIndex {
  schemaVersion: number;
  cwd: string;
  builtAt: string;
  files: Array<{
    path: string;
    imports: Array<{ target: string; external: boolean; unresolved?: boolean }>;
    importsExternal: string[];
    exports: string[];
  }>;
  symbols: CodeSymbol[];
  calls: Array<{ from: string | null; to: string; resolved: string[]; line: number; ambiguous: boolean; fromFile: string }>;
  stats: { files: number; symbols: number; importEdges: number; callEdges: number; externalImports: number };
}

const QUERY_KINDS = ["callers", "callees", "importers", "exports", "find", "impact", "dead_code"] as const;
type QueryKind = (typeof QUERY_KINDS)[number];

interface CodeGraphStats {
  files: number;
  symbols: number;
  importEdges: number;
  callEdges: number;
  externalImports: number;
}

interface QueryDetails {
  enabled: boolean;
  rebuilt: boolean;
  stats: CodeGraphStats | null;
}

interface RebuildDetails {
  enabled: boolean;
  stats: CodeGraphStats | null;
  file: string | null;
}

function isQueryKind(value: string): value is QueryKind {
  return (QUERY_KINDS as readonly string[]).includes(value);
}

/**
 * CodeGraph (TencentDB-Agent-Memory CodeGraph asset + code-graph-rag minimal
 * slice): a persistent symbol/import/call index over the workspace, queried
 * on demand instead of injected. The index is a deterministic JSON file
 * rebuilt from the TypeScript compiler API; queries are pure reachability
 * walks (callers/callees, importers, change-impact closure, dead-code).
 *
 * Knowledge is called on demand as tools, not injected wholesale — the same
 * InjectionMode=reference choice TencentDB's loadout resolver makes.
 */
export default function equaxisCodeGraph(pi: ExtensionAPI): void {
  const services = createExtensionRuntimeServices({ cwd: process.cwd(), extensionId: "code-graph", pi });
  let config = services.config.codeGraph as CodeGraphConfig;

  function trace(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}): void {
    services.trace.record(ctx, event, data);
  }

  function indexFile(): string {
    return codeIndexPath(services.paths.workspace, config.rootDir);
  }

  function loadOrBuild(): { index: CodeGraphIndex | null; rebuilt: boolean } {
    if (!config.enabled) return { index: null, rebuilt: false };
    const file = indexFile();
    const existing = loadCodeIndex(file);
    if (existing && isIndexFresh(existing, { maxAgeMs: config.rebuildIfStaleMs })) {
      return { index: existing, rebuilt: false };
    }
    const index = buildCodeIndex({
      cwd: services.paths.workspace,
      includeDirs: config.includeDirs,
      maxFiles: config.maxFiles
    }) as unknown as CodeGraphIndex;
    saveCodeIndex(index, file);
    return { index, rebuilt: true };
  }

  function runQuery(index: CodeGraphIndex, kind: string, target: string, entryRoots: string[]): Record<string, unknown> {
    switch (kind) {
      case "callers": {
        if (!target) throw new Error("callers requires target (symbol name or file::Name id)");
        return { callers: queryCallers(index, target) };
      }
      case "callees": {
        if (!target) throw new Error("callees requires target (symbol name or file::Name id)");
        return { callees: queryCallees(index, target) };
      }
      case "importers": {
        if (!target) throw new Error("importers requires target (workspace-relative file path)");
        return { importers: queryImporters(index, target) };
      }
      case "exports": {
        if (!target) throw new Error("exports requires target (workspace-relative file path)");
        return { exports: queryExports(index, target) };
      }
      case "find": {
        if (!target) throw new Error("find requires target (symbol name substring)");
        const symbols = index.symbols
          .filter((symbol) => symbol.name.includes(target))
          .slice(0, 50)
          .map((symbol) => ({ id: symbol.id, name: symbol.name, kind: symbol.kind, qualifiedName: symbol.qualifiedName, file: symbol.file, startLine: symbol.startLine, endLine: symbol.endLine, doc: symbol.doc, exported: symbol.exported }));
        return { symbols };
      }
      case "impact": {
        if (!target) throw new Error("impact requires target (symbol name, file::Name id, or file path)");
        const bySymbol = impactClosure(index, target);
        if (bySymbol.found) return { impact: bySymbol };
        const file = index.files.find((entry) => entry.path === target);
        if (!file) throw new Error(`target not found in index: ${target}`);
        return { impact: { found: true, symbols: [], files: [{ file: target, depth: 0 }], depth: 0 } };
      }
      case "dead_code": {
        return deadCodeReport(index, { entryRoots });
      }
      default:
        throw new Error(`unknown query kind: ${kind}`);
    }
  }

  function summary(prefix: string, index: CodeGraphIndex | null): string {
    if (!index) return `${prefix}: disabled`;
    return `${prefix}: ${index.stats.files} files, ${index.stats.symbols} symbols, ${index.stats.importEdges} import edges, ${index.stats.callEdges} call edges (built ${index.builtAt})`;
  }

  pi.registerTool({
    name: "code_graph_query",
    label: "Code Graph Query",
    description:
      "Query the workspace code knowledge graph. Kinds: callers/callees of a symbol (by name or file::Name id), importers/exports of a file, find symbols by name, impact closure (what transitively depends on a symbol or file), dead_code report from entry roots. Rebuilds the index when stale.",
    promptSnippet: "Query the code graph",
    promptGuidelines: [
      "Use code_graph_query before refactoring a symbol to learn what depends on it (kind=impact).",
      "Use kind=dead_code with entryRoots to find unreachable files and unused symbols."
    ],
    parameters: Type.Object({
      kind: Type.String({ description: `One of: ${QUERY_KINDS.join(", ")}` }),
      target: Type.Optional(Type.String({ description: "Symbol name, symbol id (file::Name), or workspace-relative file path" })),
      entryRoots: Type.Optional(Type.Array(Type.String(), { description: "Entry files (workspace-relative) for dead-code analysis" }))
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<QueryDetails>> {
      const { index, rebuilt } = loadOrBuild();
      if (!index) {
        return { content: [{ type: "text", text: "Code graph is disabled (.pi/equaxis.json codeGraph.enabled)." }], details: { enabled: false, rebuilt: false, stats: null } };
      }
      if (!isQueryKind(params.kind)) {
        throw new Error(`unknown query kind: ${params.kind}; expected one of ${QUERY_KINDS.join(", ")}`);
      }
      const result = runQuery(index, params.kind, params.target ?? "", params.entryRoots ?? []);
      trace({} as ExtensionContext, "code_graph_queried", { kind: params.kind, target: params.target ?? "", rebuilt });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { enabled: true, rebuilt, stats: index.stats }
      };
    }
  });

  pi.registerTool({
    name: "code_graph_rebuild",
    label: "Code Graph Rebuild",
    description: "Force a full rebuild of the workspace code knowledge graph index.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params): Promise<AgentToolResult<RebuildDetails>> {
      if (!config.enabled) {
        return { content: [{ type: "text", text: "Code graph is disabled (.pi/equaxis.json codeGraph.enabled)." }], details: { enabled: false, stats: null, file: null } };
      }
      const index = buildCodeIndex({
        cwd: services.paths.workspace,
        includeDirs: config.includeDirs,
        maxFiles: config.maxFiles
      }) as unknown as CodeGraphIndex;
      const file = saveCodeIndex(index, indexFile());
      trace({} as ExtensionContext, "code_graph_rebuilt", { files: index.stats.files, symbols: index.stats.symbols, calls: index.stats.callEdges });
      return {
        content: [{ type: "text", text: summary("Code graph rebuilt", index) }],
        details: { enabled: true, stats: index.stats, file }
      };
    }
  });

  pi.registerCommand("equaxis-code-graph", {
    description: "Show code graph status, or rebuild with: /equaxis-code-graph rebuild",
    handler: async (args, ctx) => {
      if (args.trim() === "rebuild") {
        if (!config.enabled) {
          ctx.ui.notify("Code graph is disabled (.pi/equaxis.json codeGraph.enabled)", "info");
          return;
        }
        const index = buildCodeIndex({
          cwd: services.paths.workspace,
          includeDirs: config.includeDirs,
          maxFiles: config.maxFiles
        }) as unknown as CodeGraphIndex;
        saveCodeIndex(index, indexFile());
        trace(ctx, "code_graph_rebuilt", { files: index.stats.files, symbols: index.stats.symbols, calls: index.stats.callEdges });
        ctx.ui.notify(summary("Code graph rebuilt", index), "info");
        return;
      }
      if (!config.enabled) {
        ctx.ui.notify("Code graph is disabled (.pi/equaxis.json codeGraph.enabled)", "info");
        return;
      }
      const existing = loadCodeIndex(indexFile());
      ctx.ui.notify(
        existing
          ? `${summary("Code graph", existing)}\nFile: ${indexFile()}\nStale: ${isIndexFresh(existing, { maxAgeMs: config.rebuildIfStaleMs }) ? "no" : "yes (rebuild with /equaxis-code-graph rebuild)"}`
          : `Code graph: not built yet (index appears on first code_graph_query, or run /equaxis-code-graph rebuild)`,
        "info"
      );
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    services.configure(ctx.cwd);
    config = services.config.codeGraph as CodeGraphConfig;
    const existing = loadCodeIndex(indexFile());
    trace(ctx, "code_graph_status", {
      enabled: config.enabled,
      built: existing !== null,
      stale: existing ? !isIndexFresh(existing, { maxAgeMs: config.rebuildIfStaleMs }) : null,
      stats: existing?.stats ?? null,
      indexFile: indexFile()
    });
  });
}
