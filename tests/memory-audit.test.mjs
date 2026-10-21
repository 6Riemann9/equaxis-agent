import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeMemoryCore, dispatchMemoryAction } from "../src/memory-core.mjs";

function makeCore() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-audit-test-"));
  return { core: new NativeMemoryCore({ rootDir }), rootDir };
}

test("mutations append audit entries with actor and previews", async () => {
  const { core, rootDir } = makeCore();
  const { record } = await core.remember({ wing: "w", room: "r", content: "audit me please", source_file: "test-suite" });
  await core.updateMemory({ drawer_id: record.drawer_id, content: "updated content", source_file: "test-suite" });
  core.addFact({ subject: "alpha", predicate: "knows", object: "beta", metadata: { source: "test-suite" } });
  core.deleteMemory(record.drawer_id);

  const log = core.auditLog({ limit: 10 });
  assert.equal(log.total, 4);
  const actions = log.entries.map((entry) => entry.action);
  assert.deepEqual(actions, ["delete", "add_fact", "update", "remember"]); // newest first

  const rememberEntry = log.entries.find((entry) => entry.action === "remember");
  assert.equal(rememberEntry.actor, "test-suite");
  assert.equal(rememberEntry.drawer_id, record.drawer_id);
  assert.match(rememberEntry.preview, /audit me/);

  const updateEntry = log.entries.find((entry) => entry.action === "update");
  assert.match(updateEntry.before.preview, /audit me/);
  assert.match(updateEntry.after.preview, /updated content/);

  const deleteEntry = log.entries.find((entry) => entry.action === "delete");
  assert.match(deleteEntry.before.preview, /updated content/);

  const factEntry = log.entries.find((entry) => entry.action === "add_fact");
  assert.equal(factEntry.subject, "alpha");
  assert.equal(factEntry.predicate, "knows");

  // The file lives inside the memory root and survives a reload.
  assert.ok(fs.existsSync(path.join(rootDir, "audit.jsonl")));
  const reloaded = new NativeMemoryCore({ rootDir });
  assert.equal(reloaded.auditLog({ limit: 10 }).total, 4);
});

test("audit_log paginates and is reachable through the action dispatcher", async () => {
  const { core } = makeCore();
  for (let i = 0; i < 7; i += 1) {
    await core.remember({ wing: "w", room: "r", content: `entry ${i}` });
  }
  const page = await dispatchMemoryAction(core, "audit_log", { limit: 3, offset: 3 });
  assert.equal(page.entries.length, 3);
  assert.equal(page.total, 7);
  const tail = await dispatchMemoryAction(core, "audit_log", { limit: 3, offset: 6 });
  assert.equal(tail.entries.length, 1);
});

test("audit failures never break memory operations", async () => {
  const { core, rootDir } = makeCore();
  // Make the audit path unwritable by pointing it at a directory.
  fs.mkdirSync(path.join(rootDir, "audit.jsonl"), { recursive: true });
  const { record } = await core.remember({ wing: "w", room: "r", content: "still works" });
  assert.ok(record.drawer_id);
  assert.equal(core.drawers.length, 1);
});
