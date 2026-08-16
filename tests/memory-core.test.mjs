import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { dispatchMemoryAction, NativeMemoryBackend, NativeMemoryCore } from "../src/memory-core.mjs";

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-native-memory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("record/search/remember/update/delete round-trip with semantic search", async (t) => {
  const root = tempRoot(t);
  const core = new NativeMemoryCore({ rootDir: root });
  core.recordUser("s1", "用户说：请使用 markdown 写文档");
  assert.equal(core.status().config.history_entries, 1);

  const remembered = await core.remember({ wing: "equaxis", room: "prefs", content: "用户偏好 markdown 文档输出", source_file: "test", hall: "hall_preferences" });
  assert.match(remembered.record.drawer_id, /^drawer_equaxis_prefs_/);

  const search = await core.searchAsync({ query: "文档输出偏好", limit: 3 });
  assert.equal(search.matches.length, 1);
  assert.ok(search.matches[0].score > 0.5, `semantic score high: ${search.matches[0].score}`);

  const updated = core.updateMemory({ drawer_id: remembered.record.drawer_id, content: "用户偏好 markdown 和 PDF 输出", room: "prefs" });
  assert.equal(updated.record.content, "用户偏好 markdown 和 PDF 输出");
  assert.equal(core.drawers.length, 1);

  const deleted = core.deleteMemory(remembered.record.drawer_id);
  assert.equal(deleted.deleted, true);
  assert.equal(core.drawers.length, 0);
});

test("knowledge graph facts with entity normalization and query", async (t) => {
  const root = tempRoot(t);
  const core = new NativeMemoryCore({ rootDir: root });
  const fact = core.addFact({ subject: "DeepSeek", predicate: "provides_model_for", object: "equaxis-agent" });
  assert.equal(fact.triple.subject, "deepseek", "entity names normalized");
  const queried = core.queryEntity("DeepSeek");
  assert.equal(queried.facts.length, 1);
  assert.equal(queried.facts[0].predicate, "provides_model_for");
  assert.equal(core.status().knowledge_graph.triples, 1);
  assert.equal(core.status().knowledge_graph.current_facts, 1);
});

test("visualize and export include drawers, facts and history", async (t) => {
  const root = tempRoot(t);
  const core = new NativeMemoryCore({ rootDir: root });
  core.recordUser("s1", "hello");
  await core.remember({ wing: "equaxis", room: "general", content: "a durable fact", source_file: "t" });
  core.addFact({ subject: "a", predicate: "relates", object: "b" });

  const visualization = core.visualize({ limit: 50 });
  assert.equal(visualization.drawers.length, 1);
  assert.equal(visualization.facts.length, 1);
  assert.equal(visualization.status.config.history_entries, 1);
  assert.deepEqual(visualization.status.wings, { equaxis: 1 });

  const exported = core.exportMemory({ limit: 50 });
  assert.equal(exported.history.length, 1);
  assert.equal(exported.drawers.length, 1);
  assert.equal(exported.facts.length, 1);
});

test("export/import round-trip into a fresh store (migration path)", async (t) => {
  const sourceRoot = tempRoot(t);
  const targetRoot = tempRoot(t);
  const source = new NativeMemoryCore({ rootDir: sourceRoot });
  await source.remember({ wing: "equaxis", room: "prefs", content: "migrated drawer content", source_file: "src" });
  source.addFact({ subject: "migrated", predicate: "contains", object: "drawer" });

  const dump = source.exportMemory({ limit: 100 });
  const target = new NativeMemoryCore({ rootDir: targetRoot });
  const result = target.importExport(dump);
  assert.equal(result.imported, 1);
  assert.equal(target.drawers.length, 1);
  assert.equal(target.queryEntity("migrated").facts.length, 1);
});

test("pending history and dream cursor", async (t) => {
  const root = tempRoot(t);
  const core = new NativeMemoryCore({ rootDir: root });
  core.recordUser("s1", "first");
  core.recordUser("s1", "second");
  assert.equal(core.pendingHistory({ limit: 10 }).entries.length, 2);
  core.setDreamCursor(1);
  const pending = core.pendingHistory({ limit: 10 });
  assert.equal(pending.dream_cursor, 1);
  assert.equal(pending.entries.length, 1);
  assert.equal(pending.entries[0].content, "[user] second");
});

test("repair rebuilds a corrupt cursor and reports damage", (t) => {
  const root = tempRoot(t);
  const core = new NativeMemoryCore({ rootDir: root });
  core.recordUser("s1", "entry");
  fs.writeFileSync(path.join(root, "history", ".cursor"), "\u0000\u0000\u0000\u0000", "utf8");
  const report = core.repair();
  assert.equal(report.cursor.repaired, true);
  assert.equal(report.cursor.rebuilt, 1);
  assert.equal(report.history.lines, 1);
});

test("backend adapter exposes the same request surface", async (t) => {
  const root = tempRoot(t);
  const backend = new NativeMemoryBackend({ rootDir: root });
  await backend.start();
  assert.equal(backend.started, true);
  const ping = await backend.request("ping");
  assert.match(ping.version, /native/);
  await backend.request("remember", { wing: "equaxis", room: "general", content: "via adapter", source_file: "t" });
  const status = await backend.request("status");
  assert.equal(status.wings.equaxis, 1);
  await backend.stop();
  assert.equal(backend.started, false);
});

test("dispatch covers the full action surface", async (t) => {
  const root = tempRoot(t);
  const core = new NativeMemoryCore({ rootDir: root });
  assert.equal((await dispatchMemoryAction(core, "ping")).version.includes("native"), true);
  assert.deepEqual(await dispatchMemoryAction(core, "record_user", { session_id: "s", content: "x" }), { recorded: true });
  const record = await dispatchMemoryAction(core, "remember", { wing: "w", room: "r", content: "c" });
  assert.ok(record.record.drawer_id);
  assert.equal((await dispatchMemoryAction(core, "search", { query: "c" })).matches.length, 1);
  assert.ok((await dispatchMemoryAction(core, "delete_memory", { drawer_id: record.record.drawer_id })).deleted);
  assert.ok((await dispatchMemoryAction(core, "set_dream_cursor", { cursor: 3 })).ok);
  assert.equal((await dispatchMemoryAction(core, "pending_history", {})).dream_cursor, 3);
  assert.equal((await dispatchMemoryAction(core, "repair", {})).drawers, 0);
  await assert.rejects(dispatchMemoryAction(core, "nope"), /Unknown memory action/);
});
