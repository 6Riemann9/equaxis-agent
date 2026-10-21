import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CompanionStore } from "../src/companion-store.mjs";
import { parsePiUsage, runCompanionWorker } from "../src/companion-runtime.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-m11-"));
}

function seeded(root = tmpRoot()) {
  const store = CompanionStore.open(root);
  store.createTeammate({ name: "scout" });
  store.createTeammate({ name: "builder" });
  return store;
}

// ---- concurrency ----

test("m11 worker: concurrency runs tasks in parallel instead of serializing them", async () => {
  const store = seeded();
  store.enqueue("scout", "first");
  store.enqueue("builder", "second");

  const order = [];
  const started = [];
  const worker = runCompanionWorker({
    store,
    concurrency: 2,
    maxTasks: 2,
    executor: async (task) => {
      started.push(task.teammateId);
      order.push(`start:${task.instruction}`);
      // Every task yields, so a parallel pool gets both in flight; a serial
      // loop would still run them one after the other.
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push(`end:${task.instruction}`);
      return `did ${task.instruction}`;
    }
  });
  const summary = await worker;
  assert.equal(summary.completed, 2);
  assert.equal(order.filter((entry) => entry.startsWith("start:")).length, 2);
  // Both start before either ends: proof of parallellism.
  assert.deepEqual(order.slice(0, 2).sort(), ["start:first", "start:second"]);
});

test("m11 worker: concurrency 1 keeps the strictly serial order", async () => {
  const store = seeded();
  store.enqueue("scout", "first");
  store.enqueue("scout", "second");
  const order = [];
  await runCompanionWorker({
    store,
    concurrency: 1,
    maxTasks: 2,
    executor: async (task) => {
      order.push(task.instruction);
      return "ok";
    }
  });
  assert.deepEqual(order, ["first", "second"]);
});

test("m11 worker: --once claims exactly one task even with a wide pool", async () => {
  const store = seeded();
  for (const instruction of ["a", "b", "c"]) store.enqueue("scout", instruction);
  const seen = [];
  const summary = await runCompanionWorker({
    store,
    once: true,
    concurrency: 4,
    executor: async (task) => {
      seen.push(task.instruction);
      return "ok";
    }
  });
  assert.equal(seen.length, 1, "once must not fan out");
  assert.equal(summary.stoppedBy, "once");
  assert.equal(store.listTasks({}).filter((t) => t.status === "pending").length, 2);
});

test("m11 worker: maxTasks caps a batch regardless of pool width", async () => {
  const store = seeded();
  for (const instruction of ["1", "2", "3", "4", "5"]) store.enqueue("scout", instruction);
  const summary = await runCompanionWorker({
    store,
    concurrency: 3,
    maxTasks: 2,
    executor: async () => "ok"
  });
  assert.equal(summary.completed, 2);
  assert.equal(summary.stoppedBy, "maxTasks");
});

// ---- cancellation ----

test("m11 cancel: cancelling a running task aborts the subprocess and finalizes the status", async () => {
  const store = seeded();
  const task = store.enqueue("scout", "long running");

  let abortObserved = false;
  const run = runCompanionWorker({
    store,
    concurrency: 1,
    maxTasks: 1,
    executor: async (_task, ctx) => {
      // Mimic the real executor: resolve only when the signal aborts.
      return new Promise((resolve, reject) => {
        ctx.signal.addEventListener("abort", () => {
          abortObserved = true;
          reject(new Error("cancelled"));
        }, { once: true });
        // The operator cancels from another process/route while it runs.
        setTimeout(() => store.cancel(task.id), 20);
      });
    }
  });

  const summary = await run;
  assert.equal(abortObserved, true, "the worker must propagate the abort to the executor");
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.failed, 0, "a cancellation is not a failure");
  assert.equal(store.getTask(task.id).status, "cancelled");
  assert.match(store.getTask(task.id).error, /cancelled while running/);
});

test("m11 cancel: a running task is only marked cancelling until the worker confirms", () => {
  const store = seeded();
  const task = store.enqueue("scout", "work");
  store.next(); // claim → running
  const requested = store.cancel(task.id);
  assert.equal(requested.status, "cancelling", "the store must not claim a dead subprocess");
  assert.ok(requested.cancelRequestedAt);
  // The worker's confirmation is what finalizes it.
  const finalized = store.finishCancellation(task.id, "cancelled while running");
  assert.equal(finalized.status, "cancelled");
  assert.ok(finalized.finishedAt);
});

test("m11 cancel: cancelling a pending task finalizes immediately", () => {
  const store = seeded();
  const task = store.enqueue("scout", "queued");
  const cancelled = store.cancel(task.id);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.finishedAt);
});

// ---- usage accounting ----

const STREAM = [
  { type: "session", id: "s1" },
  { type: "turn_end", message: { role: "assistant", provider: "magpie", model: "deepworks/DeepSeek-V4-Flash", usage: { input: 1000, output: 100, cacheRead: 10, cacheWrite: 0, totalTokens: 1110, cost: { total: 0.001 } } } },
  { type: "turn_end", message: { role: "assistant", provider: "magpie", model: "deepworks/DeepSeek-V4-Flash", usage: { input: 2000, output: 200, cacheRead: 0, cacheWrite: 5, totalTokens: 2205, cost: { total: 0.002 } } } },
  { type: "agent_end", messages: [] }
].map((event) => JSON.stringify(event)).join("\n");

test("m11 usage: parsePiUsage sums provider-reported tokens and cost across turns", () => {
  const usage = parsePiUsage(STREAM);
  assert.equal(usage.turns, 2);
  assert.equal(usage.input, 3000);
  assert.equal(usage.output, 300);
  assert.equal(usage.cacheRead, 10);
  assert.equal(usage.cacheWrite, 5);
  assert.equal(usage.totalTokens, 3315);
  assert.equal(usage.costUsd, 0.003);
  assert.equal(usage.provider, "magpie");
  assert.equal(usage.model, "deepworks/DeepSeek-V4-Flash");
});

test("m11 usage: a stream without usage events reports null, not zero", () => {
  assert.equal(parsePiUsage(""), null);
  assert.equal(parsePiUsage("not json"), null);
  assert.equal(parsePiUsage(JSON.stringify({ type: "agent_end", messages: [] })), null);
  // Tolerates junk lines between valid events.
  assert.ok(parsePiUsage(`garbage\n${STREAM}\n{broken`) !== null);
});

test("m11 usage: recordUsage rolls cost into teammate totals and survives a reload", () => {
  const root = tmpRoot();
  const store = seeded(root);
  const task = store.enqueue("scout", "spendy");
  store.recordUsage(task.id, { turns: 1, input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, costUsd: 0.25, provider: "magpie", model: "m" });
  store.recordUsage(task.id, { turns: 1, totalTokens: 8, costUsd: 0.75 });

  const teammate = store.getTeammate("scout");
  assert.equal(teammate.stats.totalTokens, 20);
  assert.equal(teammate.stats.totalCostUsd, 1);

  const reloaded = CompanionStore.open(root);
  assert.equal(reloaded.getTeammate("scout").stats.totalCostUsd, 1, "totals persist");
  assert.equal(reloaded.getTask(task.id).usage.totalTokens, 8, "the task keeps the latest usage record");
});

test("m11 usage: usage is recorded even when the task later fails", () => {
  const store = seeded();
  const task = store.enqueue("scout", "will fail");
  store.next();
  store.recordUsage(task.id, { turns: 1, totalTokens: 5, costUsd: 0.5 });
  store.fail(task.id, "boom");
  const stored = store.getTask(task.id);
  assert.equal(stored.status, "failed");
  assert.equal(stored.usage.costUsd, 0.5, "burned tokens are still accounted");
  assert.equal(store.getTeammate("scout").stats.totalCostUsd, 0.5);
});

// ---- per-task logs ----

test("m11 logs: task logs are appended, tailed and bounded", () => {
  const store = seeded();
  const task = store.enqueue("scout", "logged");
  const file = store.taskLogFile(task.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ["line1", "line2", "line3", "line4"].join("\n"), "utf8");

  const tail = store.readTaskLog(task.id, { lines: 2 });
  assert.equal(tail.exists, true);
  assert.deepEqual(tail.lines, ["line3", "line4"]);
  assert.equal(tail.truncated, true);

  const missing = store.readTaskLog("does-not-exist");
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.lines, []);

  // The task id is sanitized into the filename: no traversal from a queue id.
  assert.ok(!store.taskLogFile("../../etc/passwd").includes(".."));
});

test("m11 usage: completion counters survive a restart too (they used to reset to 0)", () => {
  const root = tmpRoot();
  const store = seeded(root);
  const done = store.enqueue("scout", "ok one");
  store.complete(done.id, "fine");
  const failed = store.enqueue("scout", "bad one");
  store.fail(failed.id, "boom");
  assert.deepEqual(
    { completed: store.getTeammate("scout").stats.completed, failed: store.getTeammate("scout").stats.failed },
    { completed: 1, failed: 1 }
  );

  const reloaded = CompanionStore.open(root);
  assert.equal(reloaded.getTeammate("scout").stats.completed, 1, "completed must not reset on reload");
  assert.equal(reloaded.getTeammate("scout").stats.failed, 1, "failed must not reset on reload");
});

// ---- cross-process visibility (found by running the UI against a live serve) ----

test("m11 sync: a task queued by another process is visible to a running store", () => {
  const root = tmpRoot();
  const server = seeded(root);          // the long-running `companion serve` (scout + builder)
  server.listTasks({});                 // warm its cache

  // A separate process (the CLI) enqueues work.
  const cli = CompanionStore.open(root);
  const task = cli.enqueue("scout", "queued from another process");

  // The server must see it without a restart, or serve + CLI cannot coexist.
  assert.equal(server.getTask(task.id)?.instruction, "queued from another process");
  assert.equal(server.listTasks({}).length, 1);
  const claimed = server.next();
  assert.equal(claimed.id, task.id, "the running worker can claim it");

  // And the CLI sees the server's claim, so it cannot double-claim.
  assert.equal(cli.getTask(task.id).status, "running");
  assert.equal(cli.next(), null);
});

test("m11 sync: team and routine changes made elsewhere are picked up too", () => {
  const root = tmpRoot();
  const server = seeded(root);
  server.listTeammates();

  const cli = CompanionStore.open(root);
  cli.createTeammate({ name: "auditor", persona: "checks things" });
  cli.addRoutine({ teammate: "auditor", instruction: "nightly sweep", everyMs: 30 * 60_000 });

  assert.ok(server.getTeammate("auditor"), "a teammate created by the CLI is visible");
  assert.equal(server.listRoutines().length, 1);
  assert.equal(server.dueRoutines().length, 1, "the running worker can fire it");
});

test("m11 sync: our own writes are not re-read (no churn, no lost update)", () => {
  const root = tmpRoot();
  const store = seeded(root);
  const task = store.enqueue("scout", "mine");
  store.complete(task.id, "done");
  // Re-reading right after our own flush must still show our write.
  assert.equal(store.getTask(task.id).status, "done");
  assert.equal(store.getTask(task.id).result, "done");
  const reloaded = CompanionStore.open(root);
  assert.equal(reloaded.getTask(task.id).status, "done");
});
