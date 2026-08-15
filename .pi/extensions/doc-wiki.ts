import fs from "node:fs";
import path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createExtensionRuntimeServices } from "../../src/extension-runtime-services.mjs";
import {
  buildDocIndex,
  collectDocFiles,
  docGraphSearch,
  docIndexPath,
  loadDocIndex,
  saveDocIndex,
  searchDocIndex
} from "../../src/doc-index.mjs";

interface WikiConfig {
  enabled: boolean;
  rootDir: string;
  includeDirs: string[];
  extensions: string[];
  maxFiles: number;
}

interface DocIndex {
  schemaVersion: number;
  builtAt: string;
  pages: Array<{ id: string; title: string; level: number; body: string; path: string; source: string; type: string }>;
  linkEdges: Array<{ from: string; to: string }>;
  danglingCount: number;
  stats: { pages: number; docs: number; linkEdges: number; dangling: number };
}

interface WikiDetails {
  enabled: boolean;
  stats: DocIndex["stats"] | null;
  builtAt: string | null;
  indexFile: string | null;
}

function isMarkdown(filePath: string, extensions: string[]): boolean {
  return extensions.some((ext) => filePath.toLowerCase().endsWith(ext.toLowerCase()));
}

function assertInside(projectRoot: string, target: string, label: string): void {
  const relative = path.relative(projectRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the workspace: ${target}`);
  }
}

/**
 * Wiki document index (TencentDB llm_wiki asset, deterministic slice):
 * markdown docs → structured pages + [[wikilinks]] graph, keyword search and
 * multi-hop link retrieval — queried on demand, never injected.
 */
export default function equaxisDocWiki(pi: ExtensionAPI): void {
  const services = createExtensionRuntimeServices({ cwd: process.cwd(), extensionId: "doc-wiki", pi });
  let config = services.config.wiki as WikiConfig;

  function trace(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}): void {
    services.trace.record(ctx, event, data);
  }

  function indexFile(): string {
    return docIndexPath(services.paths.workspace, config.rootDir);
  }

  function loadIndex(): DocIndex | null {
    if (!config.enabled) return null;
    return loadDocIndex(indexFile());
  }

  function buildFromPaths(paths: string[]): DocIndex {
    const docs = [];
    for (const relativePath of paths) {
      const absolute = path.resolve(services.paths.workspace, relativePath);
      assertInside(services.paths.workspace, absolute, "wiki ingest path");
      if (!isMarkdown(absolute, config.extensions)) throw new Error(`not a markdown file: ${relativePath}`);
      const text = fs.readFileSync(absolute, "utf8");
      docs.push({ text, path: relativePath.replaceAll("\\", "/") });
    }
    const index = buildDocIndex(docs) as DocIndex;
    saveDocIndex(index, indexFile());
    return index;
  }

  function ingestWorkspace(): DocIndex {
    const files = collectDocFiles(services.paths.workspace, {
      includeDirs: config.includeDirs,
      extensions: config.extensions,
      maxFiles: config.maxFiles
    });
    const docs = files.map((file) => ({ text: fs.readFileSync(file, "utf8"), path: path.relative(services.paths.workspace, file).replaceAll("\\", "/") }));
    const index = buildDocIndex(docs) as DocIndex;
    saveDocIndex(index, indexFile());
    return index;
  }

  pi.registerTool({
    name: "wiki_search",
    label: "Wiki Search",
    description:
      "Keyword-search the document index (markdown pages split at headings, [[wikilinks]] extracted): title matches outrank body matches. Rebuilds from the configured doc directories when the index is missing.",
    promptSnippet: "Search project documentation",
    promptGuidelines: [
      "Use wiki_search before re-reading a doc file — page titles and snippets usually answer the question.",
      "Use wiki_graph with a page title seed to follow [[wikilink]] relationships."
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Search query" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 }))
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<WikiDetails>> {
      if (!config.enabled) {
        return { content: [{ type: "text", text: "Wiki index is disabled (.pi/equaxis.json wiki.enabled)." }], details: { enabled: false, stats: null, builtAt: null, indexFile: null } };
      }
      let index = loadIndex();
      if (!index) {
        index = ingestWorkspace();
        trace({} as ExtensionContext, "wiki_built", { pages: index.stats.pages, docs: index.stats.docs, links: index.stats.linkEdges });
      }
      const results = searchDocIndex(index, params.query, { limit: params.limit ?? 5 });
      trace({} as ExtensionContext, "wiki_searched", { query: params.query, hits: results.length });
      const text = results.length
        ? results.map((hit) => `[${hit.pageId}] ${hit.title} (${hit.path}, score ${hit.score})\n  ${hit.snippet}`).join("\n")
        : "No matching pages.";
      return {
        content: [{ type: "text", text }],
        details: { enabled: true, stats: index.stats, builtAt: index.builtAt, indexFile: indexFile() }
      };
    }
  });

  pi.registerTool({
    name: "wiki_graph",
    label: "Wiki Graph",
    description: "Multi-hop [[wikilink]] graph retrieval over the document index with per-hop score decay: surface indirectly-related pages.",
    parameters: Type.Object({
      seeds: Type.Array(Type.String(), { description: "Seed page titles (e.g. ['overview']) or page ids" }),
      max_hops: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, default: 2 }))
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<WikiDetails>> {
      if (!config.enabled) {
        return { content: [{ type: "text", text: "Wiki index is disabled (.pi/equaxis.json wiki.enabled)." }], details: { enabled: false, stats: null, builtAt: null, indexFile: null } };
      }
      let index = loadIndex();
      if (!index) {
        index = ingestWorkspace();
        trace({} as ExtensionContext, "wiki_built", { pages: index.stats.pages, docs: index.stats.docs, links: index.stats.linkEdges });
      }
      const result = docGraphSearch(index, params.seeds, { maxHops: params.max_hops ?? 2 });
      const text = result.visited
        ? `Wiki graph: ${result.visited} page(s) visited\n` + result.nodes.map((node) => `${"  ".repeat(node.depth)}${node.title} (${node.path ?? "?"}, score ${node.score})`).join("\n")
        : "No pages found from the given seeds.";
      return {
        content: [{ type: "text", text }],
        details: { enabled: true, stats: index.stats, builtAt: index.builtAt, indexFile: indexFile() }
      };
    }
  });

  pi.registerTool({
    name: "wiki_ingest",
    label: "Wiki Ingest",
    description:
      "Rebuild the document index from the configured doc directories, or from explicit workspace-relative markdown paths. Returns index stats.",
    parameters: Type.Object({
      paths: Type.Optional(Type.Array(Type.String(), { description: "Optional explicit markdown paths; default: configured includeDirs" }))
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<WikiDetails>> {
      if (!config.enabled) {
        return { content: [{ type: "text", text: "Wiki index is disabled (.pi/equaxis.json wiki.enabled)." }], details: { enabled: false, stats: null, builtAt: null, indexFile: null } };
      }
      const index = params.paths?.length ? buildFromPaths(params.paths) : ingestWorkspace();
      trace({} as ExtensionContext, "wiki_ingested", { pages: index.stats.pages, docs: index.stats.docs, links: index.stats.linkEdges, dangling: index.stats.dangling });
      return {
        content: [{ type: "text", text: `Wiki index rebuilt: ${index.stats.docs} docs, ${index.stats.pages} pages, ${index.stats.linkEdges} links, ${index.stats.dangling} dangling` }],
        details: { enabled: true, stats: index.stats, builtAt: index.builtAt, indexFile: indexFile() }
      };
    }
  });

  pi.registerCommand("equaxis-wiki", {
    description: "Show wiki index status, or rebuild with: /equaxis-wiki rebuild",
    handler: async (args, ctx) => {
      if (!config.enabled) {
        ctx.ui.notify("Wiki index is disabled (.pi/equaxis.json wiki.enabled)", "info");
        return;
      }
      if (args.trim() === "rebuild") {
        const index = ingestWorkspace();
        trace(ctx, "wiki_ingested", { pages: index.stats.pages, docs: index.stats.docs, links: index.stats.linkEdges });
        ctx.ui.notify(`Wiki index rebuilt: ${index.stats.docs} docs, ${index.stats.pages} pages, ${index.stats.linkEdges} links`, "info");
        return;
      }
      const index = loadIndex();
      ctx.ui.notify(
        index
          ? `Wiki index: ${index.stats.pages} pages from ${index.stats.docs} docs, ${index.stats.linkEdges} links (${index.stats.dangling} dangling), built ${index.builtAt}\nFile: ${indexFile()}`
          : "Wiki index: not built (appears on first wiki_search, or run /equaxis-wiki rebuild)",
        "info"
      );
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    services.configure(ctx.cwd);
    config = services.config.wiki as WikiConfig;
    const index = loadIndex();
    trace(ctx, "wiki_status", {
      enabled: config.enabled,
      built: index !== null,
      stats: index?.stats ?? null,
      indexFile: indexFile()
    });
  });
}
