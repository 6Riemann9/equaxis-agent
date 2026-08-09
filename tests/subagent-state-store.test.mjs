import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { SubagentRuntime } from "../src/subagent-runtime.mjs";
import { SubagentStateStore } from "../src/subagent-state-store.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-subagent-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("persists subagent snapshots and restores settled task status", async (t) => {
  const root = workspace(t);
  const store = new SubagentStateStore({ projectRoot: root, rootDir: ".pi/runtime/subagents" });
  const runtime = new SubagentRuntime({
    stateStore: store,
    executor: async () => ({ ok: true, score: 1 })
  });
  runtime.spawn({ id: "persisted", label: "persisted", prompt: "run", traceId: "trace-persist" });
  const done = await runtime.wait("persisted");
  assert.equal(done.status, "completed");
  assert.ok(done.completedAt);

  const snapshotPath = path.join(root, ".pi", "runtime", "subagents", "snapshots", "persisted.json");
  assert.equal(fs.existsSync(snapshotPath), true);
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.traceId, "trace-persist");
  assert.ok(snapshot.completedAt);

  const restored = new SubagentRuntime({ stateStore: store });
  const status = restored.status("persisted");
  assert.equal(status.status, "completed");
  assert.deepEqual(status.result, { ok: true, score: 1 });
  assert.equal((await restored.wait("persisted")).status, "completed");
});

test("writes state transition events and ignores corrupt snapshots", async (t) => {
  const root = workspace(t);
  const store = new SubagentStateStore({ projectRoot: root });
  const runtime = new SubagentRuntime({
    stateStore: store,
    executor: async () => ({ ok: true })
  });
  runtime.spawn({ id: "events", prompt: "run" });
  await runtime.wait("events");

  const eventFile = path.join(root, ".pi", "runtime", "subagents", "events.jsonl");
  const events = fs.readFileSync(eventFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(events.some((entry) => entry.event === "started" && entry.task.id === "events"));
  assert.ok(events.some((entry) => entry.event === "completed" && entry.task.completedAt));

  fs.writeFileSync(path.join(root, ".pi", "runtime", "subagents", "snapshots", "bad.json"), "not json", "utf8");
  const restored = new SubagentRuntime({ stateStore: store });
  assert.equal(restored.status("events").status, "completed");
});

test("rejects subagent state paths outside the workspace", (t) => {
  const root = workspace(t);
  assert.throws(() => new SubagentStateStore({ projectRoot: root, rootDir: "../outside" }), /must stay inside the workspace/);
});
