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
  assert.match(result.error, /result does not match schema: must have required properties score/);
});

test("retries failed subagents within their retry budget", async () => {
  const events = [];
  let attempts = 0;
  const runtime = new SubagentRuntime({
    trace: (event, data) => events.push([event, data]),
    executor: async (task) => {
      attempts += 1;
      assert.equal(task.attempt, attempts);
      assert.equal(task.traceId, "trace-retry");
      if (attempts === 1) throw new Error("transient failure");
      return { ok: true, attempts };
    }
  });
  runtime.spawn({ id: "retry", prompt: "retry", maxRetries: 1, traceId: "trace-retry" });
  const result = await runtime.wait("retry");
  assert.equal(result.status, "completed");
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.result, { ok: true, attempts: 2 });
  assert.ok(events.some(([event, data]) => event === "subagent_retry" && data.traceId === "trace-retry"));
});

test("fails subagents when retry budget is exhausted", async () => {
  const runtime = new SubagentRuntime({
    defaultMaxRetries: 1,
    executor: async () => {
      throw new Error("always fails");
    }
  });
  runtime.spawn({ id: "exhausted", prompt: "fail" });
  const result = await runtime.wait("exhausted");
  assert.equal(result.status, "failed");
  assert.equal(result.attempts, 2);
  assert.match(result.error, /always fails/);
});

test("times out subagents that exceed their timeout budget", async () => {
  const runtime = new SubagentRuntime({
    executor: async (_task, { signal }) => {
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted by timeout")), { once: true });
      });
    }
  });
  runtime.spawn({ id: "timeout", prompt: "slow", timeoutMs: 100 });
  const result = await runtime.wait("timeout");
  assert.equal(result.status, "failed");
  assert.equal(result.attempts, 1);
  assert.match(result.error, /timed out after 100ms/);
});

test("fails blocked dependents when a dependency fails", async () => {
  const runtime = new SubagentRuntime({ executor: async () => ({ ok: true }) });
  runtime.spawn({
    id: "base",
    prompt: "base",
    schema: { type: "object", required: ["score"], properties: { score: { type: "number" } } }
  });
  runtime.spawn({ id: "dep", prompt: "dep", dependencies: ["base"] });
  assert.equal((await runtime.wait("base")).status, "failed");
  const dep = await runtime.wait("dep");
  assert.equal(dep.status, "failed");
  assert.match(dep.error, /dependency did not complete: base/);
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
test("TypeBox result schema validates nested arrays and enums", async () => {
  const runtime = new SubagentRuntime({ executor: async () => ({ ok: true, rows: [{ id: 1 }], mode: "x" }) });
  runtime.spawn({
    id: "nested-schema",
    prompt: "return nested",
    schema: {
      type: "object",
      required: ["rows", "mode"],
      properties: {
        rows: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
        mode: { enum: ["a", "b"] }
      }
    }
  });
  const result = await runtime.wait("nested-schema");
  assert.equal(result.status, "failed");
  assert.match(result.error, /result does not match schema/);
  const runtimeOk = new SubagentRuntime({ executor: async () => ({ rows: [{ id: "x" }], mode: "b" }) });
  runtimeOk.spawn({ id: "nested-ok", prompt: "ok", schema: { type: "object", required: ["rows", "mode"], properties: { rows: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "string" } } } }, mode: { enum: ["a", "b"] } } } });
  const ok = await runtimeOk.wait("nested-ok");
  assert.equal(ok.status, "completed");
});

test("timeout is terminal even with a retry budget", async () => {
  let attempts = 0;
  const runtime = new SubagentRuntime({
    defaultMaxRetries: 3,
    executor: async (_task, { signal }) => {
      attempts += 1;
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
  });
  runtime.spawn({ id: "terminal-timeout", prompt: "slow", timeoutMs: 100 });
  const result = await runtime.wait("terminal-timeout");
  assert.equal(result.status, "failed");
  assert.equal(result.attempts, 1, "timeouts must not retry");
  assert.match(result.error, /timed out after 100ms/);
});
  assert.equal((await runtime.wait("running")).status, "cancelled");
});

test("failed tasks carry MARC-style failure attribution (phase + kind)", async () => {
  // schema failure -> finalization/schema
  const schemaRuntime = new SubagentRuntime({ executor: async () => ({ ok: true }) });
  schemaRuntime.spawn({ id: "s1", prompt: "x", schema: { type: "object", required: ["score"], properties: { score: { type: "number" } } } });
  const schemaResult = await schemaRuntime.wait("s1");
  assert.equal(schemaResult.failurePhase, "finalization");
  assert.equal(schemaResult.failureKind, "schema");
  assert.equal(schemaResult.errorCode, "SCHEMA");

  // executor failure -> execution/executor
  const execRuntime = new SubagentRuntime({ executor: async () => { throw new Error("boom"); } });
  execRuntime.spawn({ id: "e1", prompt: "x" });
  const execResult = await execRuntime.wait("e1");
  assert.equal(execResult.failurePhase, "execution");
  assert.equal(execResult.failureKind, "executor");

  // timeout -> execution/timeout
  const slowRuntime = new SubagentRuntime({
    executor: async (_task, { signal }) => {
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted by timeout")), { once: true });
      });
    },
    defaultTimeoutMs: 50
  });
  slowRuntime.spawn({ id: "t1", prompt: "x" });
  const timeoutResult = await slowRuntime.wait("t1");
  assert.equal(timeoutResult.failurePhase, "execution");
  assert.equal(timeoutResult.failureKind, "timeout");
  assert.equal(timeoutResult.errorCode, "TIMEOUT");
});

test("dependency failures attribute to scheduling stage", async () => {
  const runtime = new SubagentRuntime({ executor: async (task) => {
    if (task.id === "dep-fail") throw new Error("executor failure");
    return { ok: true };
  } });
  runtime.spawn({ id: "dep-fail", prompt: "fail" });
  await runtime.wait("dep-fail");
  runtime.spawn({ id: "dependent", prompt: "wait", dependencies: ["dep-fail"] });
  const result = await runtime.wait("dependent");
  assert.equal(result.status, "failed");
  assert.equal(result.failurePhase, "scheduling");
  assert.equal(result.failureKind, "dependency");
});
