/**
 * Wiki document index (TencentDB-Agent-Memory llm_wiki asset, deterministic
 * slice — no LLM ingest).
 *
 * Ingests markdown docs into structured pages (frontmatter meta, heading
 * split, [[wikilinks]] extraction) with a link graph, then serves
 * keyword search (token-overlap scoring, name > heading > body) and
 * multi-hop link-graph retrieval with per-hop decay — the retrieval half
 * of TencentDB's wiki engine (BM25 seeds + graphology BFS) minus the
 * LLM/embedding dependencies. The KG multi-hop search (memory_graph_search)
 * already covers the graph half over facts; this covers docs.
 *
 * Persisted as deterministic JSON (<rootDir>/index.json), rebuilt on
 * ingest, queried on demand (never injected wholesale).
 */

import fs from "node:fs";
import path from "node:path";

export const DOC_INDEX_SCHEMA_VERSION = 1;

const DEFAULT_EXTENSIONS = [".md", ".markdown", ".mdx"];
const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "for", "with", "at", "by", "from",
  "is", "are", "was", "were", "be", "and", "or", "but", "not", "how", "what",
  "when", "why", "which", "this", "that", "it", "do", "does", "use", "using"
]);
const LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;

function tokenize(value) {
  return String(value ?? "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
}

function queryTokensFor(value) {
  return tokenize(value).filter((token) => !STOPWORDS.has(token));
}

function slugify(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "page";
}

function relative(cwd, filePath) {
  return path.relative(cwd, filePath).replaceAll("\\", "/") || path.basename(filePath);
}

/** Parse simple YAML-ish frontmatter (---\nkey: value\n---) like SKILL.md. */
export function parseDocFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text ?? ""));
  if (!match) return { meta: {}, body: String(text ?? "").trim() };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[key] = value.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      meta[key] = value;
    }
  }
  return { meta, body: (match[2] ?? "").trim() };
}

/**
 * Split markdown body into pages at heading boundaries. Returns
 * [{ title, level, body }]; content before the first heading becomes a
 * preamble page titled from `fallbackTitle`.
 */
export function splitDocPages(body, fallbackTitle) {
  const pages = [];
  let current = null;
  const lines = String(body ?? "").split(/\r?\n/);
  for (const line of lines) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      if (current) pages.push(current);
      current = { title: heading[2].trim(), level: heading[1].length, body: [] };
      continue;
    }
    if (!line.trim() && !current) continue;
    if (!current) current = { title: fallbackTitle, level: 0, body: [] };
    current.body.push(line);
  }
  if (current) pages.push(current);
  if (!pages.length && String(body ?? "").trim()) pages.push({ title: fallbackTitle, level: 0, body: lines });
  return pages.map((page) => ({ title: page.title, level: page.level, body: page.body.join("\n").trim() }));
}

/** Extract [[wikilink]] targets from page body (dangling links kept, resolved later). */
export function extractWikiLinks(body) {
  const links = [];
  LINK_RE.lastIndex = 0;
  let match;
  while ((match = LINK_RE.exec(String(body ?? ""))) !== null) {
    links.push(match[1].trim());
  }
  return links;
}

/** Recursively collect doc files under includeDirs (sorted, capped). */
export function collectDocFiles(cwd, { includeDirs = ["docs"], extensions = DEFAULT_EXTENSIONS, maxFiles = 2000 } = {}) {
  const extSet = new Set(extensions.map((ext) => ext.toLowerCase()));
  const roots = includeDirs.length ? includeDirs.map((dir) => path.resolve(cwd, dir)) : [cwd];
  const files = [];
  const ignored = new Set([".git", "node_modules", ".pi", ".equaxis", "dist", "build", "coverage", "pi-web", "vendor"]);
  const visit = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) visit(full);
        continue;
      }
      if (entry.isFile() && extSet.has(path.extname(full).toLowerCase())) files.push(full);
    }
  };
  for (const root of roots) if (fs.existsSync(root)) visit(root);
  return [...new Set(files)].sort().slice(0, maxFiles);
}

function uniqueIds(titles) {
  const counts = new Map();
  return titles.map((title) => {
    const base = slugify(title);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  });
}

/**
 * Ingest one markdown document: frontmatter meta + pages with raw (unresolved)
 * link targets. Link resolution happens globally in buildDocIndex so page ids
 * stay unique across documents.
 * @param {string} text
 * @param {{path: string, source?: string}} options
 */
export function ingestDoc(text, { path: docPath, source = "" } = {}) {
  const { meta, body } = parseDocFrontmatter(text);
  const fallbackTitle = path.basename(docPath, path.extname(docPath));
  const rawPages = splitDocPages(body, fallbackTitle);
  const ids = uniqueIds(rawPages.map((page) => page.title));
  const pages = rawPages.map((page, index) => ({
    id: ids[index],
    title: page.title,
    level: page.level,
    body: page.body,
    path: docPath,
    source: source || meta.sources?.[0] || docPath,
    type: meta.type ?? "doc"
  }));
  const links = pages.map((page) => ({
    pageId: page.id,
    targets: extractWikiLinks(page.body)
  }));
  return { meta, pages, links };
}

/**
 * Build a deterministic doc index from multiple documents. Page ids are
 * globally unique (title slug + suffix on collision); [[wikilinks]] resolve
 * against the global title→id map (dangling links counted, not dropped).
 * @param {Array<{text: string, path: string, source?: string}>} docs
 */
export function buildDocIndex(docs, { now = () => new Date().toISOString() } = {}) {
  const rawPages = [];
  const rawLinks = [];
  let danglingCount = 0;
  for (const doc of docs ?? []) {
    const ingested = ingestDoc(doc.text, { path: doc.path, source: doc.source });
    rawPages.push(...ingested.pages);
    rawLinks.push(...ingested.links);
  }
  // global unique ids
  const seen = new Set();
  const finalPages = rawPages.map((page) => {
    let id = page.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${page.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...page, id };
  });
  const idByTitleSlug = new Map();
  for (const page of finalPages) {
    const slug = slugify(page.title);
    if (!idByTitleSlug.has(slug)) idByTitleSlug.set(slug, page.id);
  }
  const originalIdToFinal = new Map(rawPages.map((page, index) => [page.id, finalPages[index].id]));
  const linkEdges = [];
  for (const link of rawLinks) {
    const from = originalIdToFinal.get(link.pageId);
    for (const target of link.targets) {
      const resolved = idByTitleSlug.get(slugify(target));
      if (resolved) linkEdges.push({ from, to: resolved });
      else danglingCount += 1;
    }
  }
  return {
    schemaVersion: DOC_INDEX_SCHEMA_VERSION,
    builtAt: now(),
    pages: finalPages,
    linkEdges,
    danglingCount,
    stats: { pages: finalPages.length, docs: docs?.length ?? 0, linkEdges: linkEdges.length, dangling: danglingCount }
  };
}

/**
 * Keyword search over pages: title ×5 > heading-level (title) tokens, body ×1.
 * @param {object} index
 * @param {string} query
 * @param {{limit?: number}} [options]
 * @returns {Array<{pageId: string, title: string, path: string, score: number, snippet: string}>}
 */
export function searchDocIndex(index, query, { limit = 5 } = {}) {
  const queryTokens = queryTokensFor(query);
  if (!queryTokens.length) return [];
  const scored = index.pages
    .map((page) => {
      const titleTokens = tokenize(page.title.replaceAll("-", " "));
      const titleSet = new Set(titleTokens);
      const bodyTokens = tokenize(page.body);
      let score = 0;
      for (const token of queryTokens) {
        if (titleSet.has(token)) score += 5;
        else if (bodyTokens.includes(token)) score += 1;
      }
      return { page, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title));
  return scored.slice(0, limit).map(({ page, score }) => ({
    pageId: page.id,
    title: page.title,
    path: page.path,
    score,
    snippet: page.body.slice(0, 160)
  }));
}

/**
 * Multi-hop link-graph retrieval with per-hop decay (undirected, capped).
 * @param {object} index
 * @param {string[]} seeds
 * @param {{maxHops?: number, hopDecay?: number, minScore?: number, maxNodes?: number}} [options]
 * @returns {{nodes: Array<{name: string, score: number, depth: number, title: string|null, path: string|null}>, edges: Array<{from: string, to: string, depth: number}>, visited: number}}
 */
export function docGraphSearch(index, seeds, { maxHops = 2, hopDecay = 0.5, minScore = 0.05, maxNodes = 100 } = {}) {
  const seedIds = (seeds ?? []).map((seed) => String(seed).trim().toLowerCase()).filter(Boolean);
  const byId = new Set(index.pages.map((page) => page.id));
  const adjacency = new Map();
  for (const edge of index.linkEdges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from).push(edge.to);
    adjacency.get(edge.to).push(edge.from);
  }
  const visited = new Map();
  const edges = [];
  const queue = seedIds.map((seed) => ({ id: seed, depth: 0 }));
  const queued = new Set(seedIds);
  while (queue.length && visited.size < maxNodes) {
    const { id, depth } = queue.shift();
    if (visited.has(id) || depth > maxHops) continue;
    const score = hopDecay ** depth;
    if (score < minScore) continue;
    visited.set(id, { name: id, score: Math.round(score * 10000) / 10000, depth });
    for (const neighbor of adjacency.get(id) ?? []) {
      edges.push({ from: id, to: neighbor, depth: depth + 1 });
      if (!visited.has(neighbor) && !queued.has(neighbor) && byId.has(neighbor)) {
        queued.add(neighbor);
        queue.push({ id: neighbor, depth: depth + 1 });
      }
    }
  }
  const pageById = new Map(index.pages.map((page) => [page.id, page]));
  return {
    nodes: [...visited.values()]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .map((node) => ({ ...node, title: pageById.get(node.name)?.title ?? node.name, path: pageById.get(node.name)?.path ?? null })),
    edges: edges.slice(0, maxNodes * 8),
    visited: visited.size
  };
}

export function docIndexPath(projectRoot, rootDir) {
  return path.join(path.resolve(projectRoot), rootDir, "index.json");
}

export function saveDocIndex(index, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index), "utf8");
  fs.renameSync(tmp, filePath);
  return filePath;
}

export function loadDocIndex(filePath) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  if (!record || record.schemaVersion !== DOC_INDEX_SCHEMA_VERSION || !Array.isArray(record.pages)) return null;
  return record;
}
