import test from "node:test";
import assert from "node:assert/strict";
import { SubagentRuntime } from "../src/subagent-runtime.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("runs subagents through queued, running and completed states", async () => {
  const events = [];
  const runtime = new SubagentRuntime({
    trace: (event, data) => events.push([event, data.id]),
    executor: async (task) => ({ ok: true, label: task.label })
  });
  const created = runtime.spawn({ id: "a", label: "review", prompt: "review this" });
  assert.equal(created.status, "running");
  const done = await runtime.wait("a");
  assert.equal(done.status, "completed");
  assert.deepEqual(done.result, { ok: true, label: "review" });
  assert.deepEqual(events.map(([event]) => event), ["subagent_queued", "subagent_started", "subagent_completed"]);
});

test("respects max concurrency and starts queued agents later", async () => {
  let active = 0;
  let peak = 0;
  const runtime = new SubagentRuntime({
    maxConcurrent: 1,
    executor: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(10);
      active -= 1;
      return { ok: true };
    }
  });
  runtime.spawn({ id: "a", prompt: "one" });
  const second = runtime.spawn({ id: "b", prompt: "two" });
  assert.equal(second.status, "queued");
  await runtime.wait("a");
  const done = await runtime.wait("b");
  assert.equal(done.status, "completed");
  assert.equal(peak, 1);
});

test("cancels queued and running subagents", async () => {
  const runtime = new SubagentRuntime({
    maxConcurrent: 1,
    executor: async (_task, { signal }) => {
      await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
  });
  runtime.spawn({ id: "running", prompt: "run" });
  runtime.spawn({ id: "queued", prompt: "wait" });
  assert.equal(runtime.cancel("queued", "not needed").status, "cancelled");
  runtime.cancel("running", "stop");
  assert.equal((await runtime.wait("running")).status, "cancelled");
  assert.equal((await runtime.wait("queued")).error, "not needed");
});

test("fails subagents whose result violates schema", async () => {
  const runtime = new SubagentRuntime({ executor: async () => ({ ok: true }) });
  runtime.spawn({
    id: "schema",
    prompt: "return score",
    schema: { type: "object", required: ["score"], properties: { score: { type: "number" } } }
  });
  const result = await runtime.wait("schema");
  assert.equal(result.status, "failed");
  assert.match(result.error, /missing required result field: score/);
});

test("holds a dependent subagent blocked until its dependency completes", async () => {
  const events = [];
  const runtime = new SubagentRuntime({
    executor: async (task) => ({ ok: true, label: task.label }),
    trace: (event, data) => events.push([event, data.id])
  });
  const base = runtime.spawn({ id: "base", prompt: "base", label: "base" });
  assert.equal(base.status, "running");
  const dep = runtime.spawn({ id: "dep", prompt: "dep", label: "dep", dependencies: ["base"] });
  assert.equal(dep.status, "blocked");
  assert.deepEqual(dep.dependencies, ["base"]);
  await runtime.wait("base");
  const done = await runtime.wait("dep");
  assert.equal(done.status, "completed");
  const eventNames = events.map(([event]) => event);
  assert.ok(eventNames.includes("subagent_blocked"));
  assert.ok(eventNames.includes("subagent_unblocked"));
  const depStarted = events.findIndex(([event, id]) => event === "subagent_started" && id === "dep");
  const depUnblocked = events.findIndex(([event, id]) => event === "subagent_unblocked" && id === "dep");
  assert.ok(depUnblocked >= 0 && depStarted >= 0);
  assert.ok(depUnblocked < depStarted, "dep must unblock before it starts");
});

test("rejects unknown dependencies at spawn time", () => {
  const runtime = new SubagentRuntime();
  assert.throws(() => runtime.spawn({ id: "x", prompt: "x", dependencies: ["missing"] }), /unknown dependency/);
});

test("schedules a DAG running independent nodes in parallel and dependents after", async () => {
  const order = [];
  const runtime = new SubagentRuntime({
    maxConcurrent: 4,
    executor: async (task) => {
      order.push(task.label);
      return { ok: true, label: task.label };
    }
  });
  const statuses = runtime.schedule([
    { name: "scout", prompt: "look around" },
    { name: "parse", prompt: "parse", dependsOn: ["scout"] },
    { name: "build", prompt: "build", dependsOn: ["scout"] },
    { name: "verify", prompt: "verify", dependsOn: ["parse", "build"] }
  ]);
  assert.equal(statuses.length, 4);
  assert.equal(statuses[1].status, "blocked"); // parse waits on scout
  assert.equal(statuses[3].status, "blocked"); // verify waits on parse+build
  const results = await Promise.all(statuses.map((s) => runtime.wait(s.id)));
  assert.ok(results.every((r) => r.status === "completed"));
  // scout starts first; verify must start after both parse and build.
  assert.ok(order.indexOf("scout") < order.indexOf("parse"));
  assert.ok(order.indexOf("scout") < order.indexOf("build"));
  assert.ok(order.indexOf("verify") > order.indexOf("parse"));
  assert.ok(order.indexOf("verify") > order.indexOf("build"));
});

test("delivers and drains peer messages between subagents", async () => {
  const runtime = new SubagentRuntime({ executor: async () => ({ ok: true }) });
  runtime.spawn({ id: "a", prompt: "a" });
  runtime.spawn({ id: "b", prompt: "b" });
  assert.equal(runtime.messages("a").length, 0);
  runtime.send("a", "please return schema");
  const inbox = runtime.messages("a");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].message, "please return schema");
  assert.equal(runtime.messages("a").length, 0, "inbox is drained after read");
  assert.throws(() => runtime.send("unknown", "hi"), /unknown subagent/);
});

test("cancels a blocked subagent waiting on dependencies", async () => {
  const runtime = new SubagentRuntime({
    maxConcurrent: 1,
    executor: async (task, { signal }) => {
      await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
  });
  runtime.spawn({ id: "running", prompt: "run" });
  runtime.spawn({ id: "blocked", prompt: "wait", dependencies: ["running"] });
  assert.equal(runtime.cancel("blocked", "drop").status, "cancelled");
  assert.equal((await runtime.wait("blocked")).error, "drop");
  runtime.cancel("running", "stop");
  assert.equal((await runtime.wait("running")).status, "cancelled");
});
