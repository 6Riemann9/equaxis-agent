import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDocIndex,
  collectDocFiles,
  docGraphSearch,
  docIndexPath,
  extractWikiLinks,
  ingestDoc,
  loadDocIndex,
  parseDocFrontmatter,
  saveDocIndex,
  searchDocIndex,
  splitDocPages
} from "../src/doc-index.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doc-index-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const SAMPLE_DOC = `---
title: Agent Memory Guide
type: guide
sources: [docs/memory.md]
---

# Overview

Memory stores [[drawers]] and [[facts]].

# Drawers

Drawers hold durable long-term entries.

# Facts

Facts are [[triples]] in the knowledge graph.
`;

test("parseDocFrontmatter extracts meta and body", () => {
  const { meta, body } = parseDocFrontmatter(SAMPLE_DOC);
  assert.equal(meta.title, "Agent Memory Guide");
  assert.equal(meta.type, "guide");
  assert.deepEqual(meta.sources, ["docs/memory.md"]);
  assert.match(body, /^# Overview/);
  assert.deepEqual(parseDocFrontmatter("no frontmatter").meta, {});
});

test("splitDocPages splits at headings with preamble fallback", () => {
  const pages = splitDocPages("# One\n\nbody1\n\n## Two\n\nbody2", "fallback");
  assert.deepEqual(pages.map((page) => page.title), ["One", "Two"]);
  assert.equal(pages[0].level, 1);
  assert.equal(pages[0].body, "body1");
  assert.equal(pages[1].body, "body2");

  const preamble = splitDocPages("intro text\n\n# Heading", "doc");
  assert.equal(preamble[0].title, "doc");
  assert.equal(preamble[0].level, 0);
  assert.deepEqual(splitDocPages("", "empty"), []);
});

test("extractWikiLinks finds [[links]] and strips aliases", () => {
  assert.deepEqual(extractWikiLinks("see [[drawers]] and [[facts|the facts page]]"), ["drawers", "facts"]);
  assert.deepEqual(extractWikiLinks("no links here"), []);
});

test("ingestDoc splits pages and keeps raw link targets", () => {
  const ingested = ingestDoc(SAMPLE_DOC, { path: "docs/memory.md" });
  assert.equal(ingested.pages.length, 3);
  assert.deepEqual(ingested.pages.map((page) => page.title), ["Overview", "Drawers", "Facts"]);
  assert.equal(ingested.pages[0].path, "docs/memory.md");
  assert.equal(ingested.pages[0].type, "guide");
  assert.equal(ingested.pages[1].source, "docs/memory.md");
  assert.deepEqual(ingested.links[0].targets, ["drawers", "facts"]);
  assert.deepEqual(ingested.links[1].targets, []);
});

test("buildDocIndex resolves links globally, counts dangling, dedupes ids", () => {
  const index = buildDocIndex([{ text: SAMPLE_DOC, path: "docs/memory.md" }], { now: () => "2026-08-15T00:00:00.000Z" });
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.stats.pages, 3);
  // Overview -> Drawers, Facts resolved; Facts -> triples is dangling
  assert.deepEqual(index.linkEdges.map((edge) => edge.to).sort(), ["drawers", "facts"]);
  assert.equal(index.stats.dangling, 1);
  assert.equal(index.danglingCount, 1);

  // duplicate titles across docs get unique ids
  const dup = buildDocIndex([
    { text: "# Same\n\n[[other]]", path: "a.md" },
    { text: "# Same\n\n[[other]]", path: "b.md" }
  ]);
  assert.equal(dup.pages.length, 2);
  assert.equal(dup.pages[0].id, "same");
  assert.equal(dup.pages[1].id, "same-2");
  // both link to the FIRST same page (first match wins)
  assert.ok(dup.linkEdges.every((edge) => edge.to === "same"));
});

test("searchDocIndex ranks title matches above body matches", () => {
  const index = buildDocIndex([
    { text: "# Drawers\n\nDeep body about drawers storage.", path: "a.md" },
    { text: "# Overview\n\nIntro about memory.", path: "b.md" }
  ]);
  const results = searchDocIndex(index, "drawers", { limit: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Drawers");
  assert.equal(results[0].pageId, "drawers");
  assert.ok(results[0].snippet.length > 0);
  assert.deepEqual(searchDocIndex(index, "zzz-no-match"), []);
  assert.deepEqual(searchDocIndex(index, ""), []);
});

test("docGraphSearch walks link edges with decay and caps", () => {
  const index = buildDocIndex([
    { text: "# A\n\n[[B]]", path: "a.md" },
    { text: "# B\n\n[[C]]", path: "b.md" },
    { text: "# C\n\n[[D]]", path: "c.md" },
    { text: "# D\n\nunlinked", path: "d.md" },
    { text: "# E\n\nunlinked", path: "e.md" }
  ]);
  const result = docGraphSearch(index, ["a"], { maxHops: 2 });
  const nodes = new Map(result.nodes.map((node) => [node.name, node]));
  assert.equal(nodes.get("a").score, 1);
  assert.equal(nodes.get("b").score, 0.5);
  assert.equal(nodes.get("c").score, 0.25);
  assert.ok(!nodes.has("d"));
  assert.ok(!nodes.has("e"));

  const deeper = docGraphSearch(index, ["a"], { maxHops: 3 });
  assert.ok(deeper.nodes.some((node) => node.name === "d"));

  // undirected: from the middle reaches both directions
  const middle = docGraphSearch(index, ["b"], { maxHops: 1 });
  assert.deepEqual(middle.nodes.map((node) => node.name).sort(), ["a", "b", "c"]);

  assert.equal(docGraphSearch(index, []).visited, 0);
});

test("collectDocFiles walks includeDirs recursively with extensions", (t) => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, "docs", "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "a.md"), "# A");
  fs.writeFileSync(path.join(root, "docs", "sub", "b.markdown"), "# B");
  fs.writeFileSync(path.join(root, "docs", "c.txt"), "ignored");

  const files = collectDocFiles(root, { includeDirs: ["docs"] });
  assert.deepEqual(files.map((file) => path.relative(root, file).replaceAll("\\", "/")).sort(), ["docs/a.md", "docs/sub/b.markdown"]);
  assert.deepEqual(collectDocFiles(root, { includeDirs: ["nope"] }), []);
});

test("persistence round-trips and rejects corrupt files", (t) => {
  const root = workspace(t);
  const index = buildDocIndex([{ text: SAMPLE_DOC, path: "docs/memory.md" }]);
  const file = docIndexPath(root, ".pi/runtime/wiki");
  saveDocIndex(index, file);
  const restored = loadDocIndex(file);
  assert.deepEqual(restored.pages, index.pages);
  assert.deepEqual(restored.linkEdges, index.linkEdges);
  assert.equal(restored.stats.pages, 3);

  fs.writeFileSync(file, "not json");
  assert.equal(loadDocIndex(file), null);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 9, pages: [] }));
  assert.equal(loadDocIndex(file), null);
});
