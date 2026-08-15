import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readWisdom, recordWisdom, wisdomPreamble } from "../src/wisdom-store.mjs";
import { SubagentRuntime } from "../src/subagent-runtime.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-wisdom-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("recordWisdom persists a truncated summary and readWisdom returns it", (t) => {
  const root = workspace(t);
  const longResult = { summary: "x".repeat(2000) };
  const entry = recordWisdom({ projectRoot: root, taskId: "t1", label: "node-a", result: longResult });
  assert.equal(entry.status, "completed");
  assert.ok(entry.summary.length <= 601, "summary is truncated");
  const read = readWisdom({ projectRoot: root, taskId: "t1" });
  assert.equal(read.label, "node-a");
  assert.match(read.summary, /^x+/);
  assert.equal(readWisdom({ projectRoot: root, taskId: "missing" }), null);
});

test("wisdomPreamble joins dependency wisdom and honors max chars", (t) => {
  const root = workspace(t);
  recordWisdom({ projectRoot: root, taskId: "dep-1", label: "setup", result: { summary: "Use the --no-cache flag" } });
  recordWisdom({ projectRoot: root, taskId: "dep-2", label: "build", result: { summary: "Output lands in dist/" } });
  const preamble = wisdomPreamble({ projectRoot: root, taskIds: ["dep-1", "dep-2"] });
  assert.match(preamble, /--no-cache/);
  assert.match(preamble, /dist\//);
  const capped = wisdomPreamble({ projectRoot: root, taskIds: ["dep-1", "dep-2"], maxChars: 60 });
  assert.ok(capped.length <= 61);
});

test("runtime onTaskComplete fires after finalization", async (t) => {
  const root = workspace(t);
  let completed = null;
  const runtime = new SubagentRuntime({
    executor: async () => ({ ok: true, summary: "done the thing" }),
    onTaskComplete: (task) => { completed = task; },
    stateStore: null
  });
  runtime.spawn({ id: "w1", prompt: "x" });
  await runtime.wait("w1");
  assert.equal(completed.id, "w1");
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result, { ok: true, summary: "done the thing" });
});

test("schedule prepends dependency wisdom across batches", async (t) => {
  const root = workspace(t);
  const seen = [];
  const runtime = new SubagentRuntime({
    executor: async (task) => {
      seen.push(task.prompt);
      return { ok: true, summary: `result of ${task.label}` };
    },
    onTaskComplete: (task) => recordWisdom({ projectRoot: root, taskId: task.id, label: task.label, result: task.result })
  });
  // Batch 1: run the producer alone; its wisdom lands on disk.
  const first = runtime.schedule([{ name: "a", prompt: "do A" }], { wisdomRoot: root });
  await runtime.waitAll(first.map((s) => s.id));
  // Batch 2: a later task depends on a's finished task — its prompt now
  // carries a's wisdom (cross-batch spawn with dependencies + wisdomRoot).
  const second = runtime.spawn({
    id: "b",
    prompt: "do B using A's output",
    dependencies: [first[0].id],
    wisdomRoot: root
  });
  await runtime.wait("b");
  assert.match(seen[1], /\[wisdom from a \(completed\)\] result of a/);
  assert.match(seen[1], /do B using A's output/);
});
