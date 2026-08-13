import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { SubagentRuntime } from "../src/subagent-runtime.mjs";
import { SubagentStateStore } from "../src/subagent-state-store.mjs";
import { createPiJsonExecutor } from "../src/subagent-executor.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

function tempWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-subagent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createRuntime(root, options = {}) {
  const store = new SubagentStateStore({ projectRoot: root, rootDir: ".pi/runtime/subagents" });
  return {
    store,
    runtime: new SubagentRuntime({ stateStore: store, maxConcurrent: 2, ...options })
  };
}

test("DAG: dependent task blocks then runs after its dependency completes", async (t) => {
  const root = tempWorkspace(t);
  const calls = [];
  const { runtime } = createRuntime(root, {
    executor: async (task) => {
      calls.push(task.id);
      return { ok: true, id: task.id, label: task.label, output: `done:${task.id}`, stderr: "" };
    }
  });

  runtime.spawn({ id: "a", prompt: "first", label: "A" });
  runtime.spawn({ id: "b", prompt: "second", label: "B", dependencies: ["a"] });
  // With an instant executor "a" may already be running; "b" is deterministically blocked.
  assert.ok(["queued", "running"].includes(runtime.status("a").status));
  assert.equal(runtime.status("b").status, "blocked");

  const aStatus = await runtime.wait("a");
  assert.equal(aStatus.status, "completed");
  assert.equal(aStatus.result?.output, "done:a");

  const bStatus = await runtime.wait("b");
  assert.equal(bStatus.status, "completed");
  assert.deepEqual(calls, ["a", "b"]);
});

test("persists events and snapshots, restores completed work on a new runtime", async (t) => {
  const root = tempWorkspace(t);
  const { runtime } = createRuntime(root, {
    executor: async (task) => ({ ok: true, id: task.id, label: task.label, output: `out:${task.id}`, stderr: "" })
  });

  runtime.spawn({ id: "a", prompt: "work", label: "A" });
  await runtime.wait("a");

  const eventFile = path.join(root, ".pi", "runtime", "subagents", "events.jsonl");
  const snapshotDir = path.join(root, ".pi", "runtime", "subagents", "snapshots");
  assert.ok(fs.existsSync(eventFile), "events.jsonl written");
  assert.ok(fs.existsSync(path.join(snapshotDir, "a.json")), "snapshot written for a");
  const events = fs.readFileSync(eventFile, "utf8").split(/\r?\n/).filter(Boolean);
  assert.ok(events.some((line) => line.includes('"completed"')), "completion event recorded");

  // A fresh runtime over the same store restores the completed task.
  const { runtime: restored } = createRuntime(root, {
    executor: async (task) => ({ ok: true, id: task.id, label: task.label, output: "", stderr: "" })
  });
  const status = restored.status("a");
  assert.equal(status.status, "completed");
  assert.equal(status.result?.output, "out:a");
});

test("non-terminal snapshots restore as failed with a reason (no silent drop)", async (t) => {
  const root = tempWorkspace(t);
  // Simulate a crash while a task was running: seed a snapshot with a
  // non-terminal status, then restore into a fresh runtime.
  const snapshotDir = path.join(root, ".pi", "runtime", "subagents", "snapshots");
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, "in-flight.json"), JSON.stringify({
    id: "in-flight",
    label: "InFlight",
    status: "running",
    dependencies: [],
    traceId: "trace-1",
    timeoutMs: null,
    maxRetries: 0,
    attempts: 1,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    result: null,
    error: null
  }), "utf8");

  const { runtime: restored } = createRuntime(root, { executor: async () => ({ ok: true, output: "" }) });
  const status = restored.status("in-flight");
  assert.equal(status.status, "failed");
  assert.match(status.error ?? "", /interrupted by restart/);

  // Blocked dependents of the failed task are also failed, not orphaned.
  fs.writeFileSync(path.join(snapshotDir, "dependent.json"), JSON.stringify({
    id: "dependent",
    label: "Dependent",
    status: "blocked",
    dependencies: ["in-flight"],
    traceId: "trace-2",
    timeoutMs: null,
    maxRetries: 0,
    attempts: 0,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    result: null,
    error: null
  }), "utf8");
  const { runtime: restoredAgain } = createRuntime(root, { executor: async () => ({ ok: true, output: "" }) });
  assert.equal(restoredAgain.status("dependent").status, "failed");
});

test("pi json executor spawns the configured entry and returns its output", async (t) => {
  const root = tempWorkspace(t);
  const script = path.join(root, "fake-agent.mjs");
  fs.writeFileSync(script, "console.log(JSON.stringify({ ok: true, output: 'fake done' }));\n", "utf8");

  const executor = createPiJsonExecutor({
    projectRoot,
    piEntry: script,
    args: [],
    isolation: { enabled: false },
    env: { PI_OFFLINE: "1" }
  });
  const result = await executor({ id: "x", label: "X", prompt: "p", schema: null, traceId: "t", attempt: 1, timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.match(result.output, /fake done/);
});
