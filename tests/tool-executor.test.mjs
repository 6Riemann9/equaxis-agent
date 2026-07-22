import test from "node:test";
import assert from "node:assert/strict";
import { executeToolPlan, IdempotencyStore } from "../src/tool-executor.mjs";
import { createResultMiddleware } from "../src/result-middleware.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("runs independent tasks with a bounded worker pool", async () => {
  let active = 0;
  let peak = 0;
  const result = await executeToolPlan(
    [{ id: "a", toolName: "read" }, { id: "b", toolName: "read" }, { id: "c", toolName: "read" }],
    async () => { active += 1; peak = Math.max(peak, active); await sleep(10); active -= 1; return "ok"; },
    { maxConcurrency: 2 }
  );
  assert.equal(result.status, "completed");
  assert.equal(peak, 2);
});

test("propagates parent cancellation to running nodes", async () => {
  const controller = new AbortController();
  const promise = executeToolPlan([{ id: "slow", toolName: "read" }], async (_task, { signal }) => {
    await new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
    resolve();
  }, { signal: controller.signal });
  setTimeout(() => controller.abort("user cancelled"), 10);
  const result = await promise;
  assert.equal(result.status, "cancelled");
  assert.equal(result.failed[0].status, "cancelled");
});

test("deduplicates completed work with a stable idempotency key", async () => {
  const store = new IdempotencyStore();
  let calls = 0;
  const executor = async () => { calls += 1; return { value: 42 }; };
  const task = { id: "same", toolName: "read", args: { path: "a.txt" } };
  await executeToolPlan([task], executor, { idempotency: store });
  const second = await executeToolPlan([task], executor, { idempotency: store });
  assert.equal(calls, 1);
  assert.equal(second.completed[0].status, "deduplicated");
});

test("runs compensators in reverse order after a later failure", async () => {
  const compensated = [];
  const result = await executeToolPlan([
    { id: "create", toolName: "write", readOnly: false, compensationKey: "delete" },
    { id: "verify", toolName: "bash", readOnly: true, dependsOn: ["create"] }
  ], async (task) => {
    if (task.id === "verify") throw new Error("verification failed");
    return "created";
  }, { compensators: { delete: async (task) => compensated.push(task.id) } });
  assert.equal(result.status, "failed");
  assert.deepEqual(compensated, ["create"]);
  assert.equal(result.compensation[0].status, "completed");
});

test("can add tasks after a wave through dynamic replanning", async () => {
  const result = await executeToolPlan([{ id: "discover", toolName: "read" }], async () => "ok", {
    replan: ({ wave }) => wave.some((item) => item.task.id === "discover") ? [{ id: "follow-up", toolName: "read", dependsOn: ["discover"] }] : []
  });
  assert.equal(result.status, "completed");
  assert.equal(result.completed.length, 2);
});

test("does not treat transport success as usable business output", async () => {
  const result = await executeToolPlan(
    [{ id: "search", toolName: "search" }],
    async () => ({ ok: true, data: {} }),
    { resultMiddleware: createResultMiddleware({ search: { required: ["data.documents"] } }) }
  );
  assert.equal(result.status, "failed");
  assert.match(result.failed[0].error, /RESULT_INCOMPLETE/);
});
