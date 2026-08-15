import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createCheckpoint, listCheckpoints, restoreCheckpoint, pruneCheckpoints, checkpointIdFor } from "../src/checkpoint-store.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-checkpoint-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("checkpoint snapshots files and restore rewinds them", (t) => {
  const root = workspace(t);
  const fileA = path.join(root, "src", "a.ts");
  fs.mkdirSync(path.dirname(fileA), { recursive: true });
  fs.writeFileSync(fileA, "version-1", "utf8");

  const created = createCheckpoint({ projectRoot: root, id: "cp-1", files: [fileA], reason: "before refactor" });
  assert.equal(created.files.length, 1);
  assert.match(created.files[0], /src\/a\.ts/);

  fs.writeFileSync(fileA, "version-2", "utf8");
  const restored = restoreCheckpoint({ projectRoot: root, id: "cp-1" });
  assert.deepEqual(restored.restored, ["src/a.ts"]);
  assert.equal(fs.readFileSync(fileA, "utf8"), "version-1");
});

test("checkpoints never escape the workspace and skip missing files", (t) => {
  const root = workspace(t);
  const outside = path.join(os.tmpdir(), "outside-checkpoint-test.txt");
  fs.writeFileSync(outside, "x", "utf8");
  t.after(() => fs.rmSync(outside, { force: true }));

  const created = createCheckpoint({ projectRoot: root, id: "cp-safe", files: [outside, path.join(root, "missing.md")] });
  assert.equal(created.files.length, 0);
  assert.equal(created.skipped, true);
});

test("listCheckpoints newest first and prune keeps only the ring", (t) => {
  const root = workspace(t);
  const file = path.join(root, "f.txt");
  fs.writeFileSync(file, "v", "utf8");
  for (let i = 0; i < 5; i += 1) {
    createCheckpoint({ projectRoot: root, id: `cp-${i}`, files: [file], reason: `r${i}` });
  }
  const listed = listCheckpoints(root, ".pi/runtime");
  assert.equal(listed.length, 5);
  assert.equal(listed[0].id, "cp-4", "newest first");

  const pruned = pruneCheckpoints(root, ".pi/runtime", 2);
  assert.equal(pruned.length, 3);
  assert.equal(listCheckpoints(root, ".pi/runtime").length, 2);
});

test("checkpoint ids are stable per tool call and distinct across calls", () => {
  assert.equal(checkpointIdFor("call-1"), checkpointIdFor("call-1"));
  assert.notEqual(checkpointIdFor("call-1"), checkpointIdFor("call-2"));
  assert.match(checkpointIdFor("call-1"), /^[0-9a-f]{12}$/);
});

test("checkpoint carries a conversation summary for context", (t) => {
  const root = workspace(t);
  const file = path.join(root, "a.txt");
  fs.writeFileSync(file, "v1", "utf8");
  const created = createCheckpoint({ projectRoot: root, id: "cp-sum", files: [file], reason: "edit", summary: "goal: refactor auth" });
  assert.equal(created.summary, "goal: refactor auth");
  const listed = listCheckpoints(root, ".pi/runtime");
  assert.equal(listed[0].summary, "goal: refactor auth");
  // summary is optional
  const plain = createCheckpoint({ projectRoot: root, id: "cp-plain", files: [file], reason: "edit" });
  assert.equal(plain.summary, "");
});
