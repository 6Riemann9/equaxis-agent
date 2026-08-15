import test from "node:test";
import assert from "node:assert/strict";
import { classifyRetryFailure, SubagentRuntime } from "../src/subagent-runtime.mjs";

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

test("completion claims are evidence-checked without gating the run", async () => {
  // verifier confirms the claimed artifact exists
  const okRuntime = new SubagentRuntime({
    executor: async () => ({ ok: true, artifact: "build/report.md" }),
    verifyEvidence: async (_task, result) => ({ ok: result.artifact === "build/report.md" })
  });
  okRuntime.spawn({ id: "ev-ok", prompt: "x" });
  const okResult = await okRuntime.wait("ev-ok");
  assert.equal(okResult.status, "completed");
  assert.deepEqual(okResult.evidence, { status: "verified", issues: [] });

  // verifier rejects the claim: run still completes, claim flagged
  const badRuntime = new SubagentRuntime({
    executor: async () => ({ ok: true, artifact: "missing.pdf" }),
    verifyEvidence: async () => ({ ok: false, issues: ["artifact missing.pdf does not exist"] })
  });
  badRuntime.spawn({ id: "ev-bad", prompt: "x" });
  const badResult = await badRuntime.wait("ev-bad");
  assert.equal(badResult.status, "completed");
  assert.equal(badResult.evidence.status, "unverified");
  assert.deepEqual(badResult.evidence.issues, ["artifact missing.pdf does not exist"]);

  // verifier crash: claim flagged, run unaffected
  const crashRuntime = new SubagentRuntime({
    executor: async () => ({ ok: true }),
    verifyEvidence: async () => { throw new Error("verifier down"); }
  });
  crashRuntime.spawn({ id: "ev-crash", prompt: "x" });
  const crashResult = await crashRuntime.wait("ev-crash");
  assert.equal(crashResult.status, "completed");
  assert.equal(crashResult.evidence.status, "unverified");
  assert.match(crashResult.evidence.issues[0], /verifier error/);

  // no verifier configured: no evidence field, legacy behavior
  const plainRuntime = new SubagentRuntime({ executor: async () => ({ ok: true }) });
  plainRuntime.spawn({ id: "ev-none", prompt: "x" });
  const plainResult = await plainRuntime.wait("ev-none");
  assert.equal(plainResult.evidence, null);
});

test("per-model concurrency buckets let other models run while one is saturated", async () => {
  const runtime = new SubagentRuntime({
    maxConcurrent: 4,
    modelConcurrency: { "model-a": 1, "model-b": 1 },
    executor: async (task) => { await sleep(60); return { ok: true, model: task.modelKey }; }
  });
  // 桶 a 限 1:三个 a 任务应串行;桶 b 限 1:一个 b 任务应与 a 并行
  const t0 = Date.now();
  runtime.spawn({ id: "a1", prompt: "a1", model: "model-a" });
  runtime.spawn({ id: "a2", prompt: "a2", model: "model-a" });
  runtime.spawn({ id: "a3", prompt: "a3", model: "model-a" });
  runtime.spawn({ id: "b1", prompt: "b1", model: "model-b" });
  const all = await runtime.waitAll(["a1", "a2", "a3", "b1"]);
  const elapsed = Date.now() - t0;
  // a 串行(3×60ms)+ b 并行 → 总耗时 < 4×60(全串行),> 60(全并行)
  assert.ok(elapsed < 220, `expected near-parallel execution, took ${elapsed}ms`);
  assert.ok(elapsed >= 160, `expected 3 serial a-runs to dominate, took ${elapsed}ms`);
  assert.ok(all.every((s) => s.status === "completed"));
  assert.equal(all.find((s) => s.id === "a1").modelKey, "model-a");
});

test("no modelConcurrency config keeps legacy behavior (single unbounded bucket)", async () => {
  const runtime = new SubagentRuntime({ maxConcurrent: 2, executor: async () => { await sleep(40); return { ok: true }; } });
  const t0 = Date.now();
  runtime.spawn({ id: "x1", prompt: "x1" });
  runtime.spawn({ id: "x2", prompt: "x2" });
  await runtime.waitAll(["x1", "x2"]);
  assert.ok(Date.now() - t0 < 70, "legacy: both run concurrently");
});

test("category routing maps work categories to model keys", async () => {
  const runtime = new SubagentRuntime({
    maxConcurrent: 4,
    categoryRoutes: { deep: { model: "model-xl" }, quick: { model: "model-fast" } },
    executor: async (task) => ({ ok: true, model: task.modelKey })
  });
  const a = runtime.spawn({ id: "cat-1", prompt: "deep work", category: "deep" });
  const b = runtime.spawn({ id: "cat-2", prompt: "quick check", category: "quick" });
  const c = runtime.spawn({ id: "cat-3", prompt: "explicit wins", category: "deep", model: "model-custom" });
  const d = runtime.spawn({ id: "cat-4", prompt: "no category" });
  assert.equal(a.modelKey, "model-xl");
  assert.equal(b.modelKey, "model-fast");
  assert.equal(c.modelKey, "model-custom", "explicit model beats category route");
  assert.equal(d.modelKey, "default");
  assert.equal(a.category, "deep");
  assert.equal(d.category, null);
  const results = await runtime.waitAll(["cat-1", "cat-2", "cat-3", "cat-4"]);
  assert.ok(results.every((s) => s.status === "completed"));
});

test("dual-review gate records OKAY/REJECT without failing the run", async () => {
  const calls = [];
  const runtime = new SubagentRuntime({
    executor: async (task) => {
      calls.push(task.id);
      if (task.isReview) return { verdict: "OKAY", issues: [] };
      return { ok: true };
    }
  });
  runtime.spawn({ id: "rev-ok", prompt: "do x", reviewPrompt: "Review this result critically." });
  const okResult = await runtime.wait("rev-ok");
  assert.equal(okResult.status, "completed");
  assert.equal(okResult.review.status, "okay");
  assert.equal(calls.includes("review-rev-ok"), true, "reviewer ran as an independent pass");

  const rejectRuntime = new SubagentRuntime({
    executor: async (task) => {
      if (task.isReview) return { verdict: "REJECT", issues: ["missing tests", "bad naming"] };
      return { ok: true };
    }
  });
  rejectRuntime.spawn({ id: "rev-bad", prompt: "do x", reviewPrompt: "Review." });
  const badResult = await rejectRuntime.wait("rev-bad");
  assert.equal(badResult.status, "completed", "REJECT does not fail the run");
  assert.equal(badResult.review.status, "reject");
  assert.deepEqual(badResult.review.issues, ["missing tests", "bad naming"]);
});

test("reviewer crash or bad verdict degrades to review error", async () => {
  const crashRuntime = new SubagentRuntime({
    executor: async (task) => {
      if (task.isReview) throw new Error("reviewer crashed");
      return { ok: true };
    }
  });
  crashRuntime.spawn({ id: "rev-crash", prompt: "x", reviewPrompt: "Review." });
  const crashed = await crashRuntime.wait("rev-crash");
  assert.equal(crashed.status, "completed");
  assert.equal(crashed.review.status, "error");
  assert.match(crashed.review.issues[0], /reviewer crashed/);

  const junkRuntime = new SubagentRuntime({
    executor: async (task) => {
      if (task.isReview) return { note: "i liked it" };
      return { ok: true };
    }
  });
  junkRuntime.spawn({ id: "rev-junk", prompt: "x", reviewPrompt: "Review." });
  const junk = await junkRuntime.wait("rev-junk");
  assert.equal(junk.review.status, "error");
  assert.match(junk.review.issues[0], /no OKAY\/REJECT/);
});

test("terminal tasks are pruned beyond the retention window", async () => {
  const runtime = new SubagentRuntime({
    executor: async () => ({ ok: true }),
    terminalRetention: 3
  });
  for (let i = 0; i < 5; i += 1) {
    runtime.spawn({ id: `p-${i}`, prompt: `x${i}` });
    await runtime.wait(`p-${i}`);
  }
  assert.equal(runtime.status("p-0"), null, "oldest terminal task pruned");
  assert.equal(runtime.status("p-1"), null, "second-oldest pruned too");
  assert.ok(runtime.status("p-2"), "retention window (3) keeps the newest three");
  assert.ok(runtime.status("p-4"), "newest task retained");
});

test("classifyRetryFailure applies the no-replay boundary", () => {
  const withCode = (code) => { const e = new Error(code); e.code = code; return e; };

  // pre-dispatch codes are safe to retry
  assert.deepEqual(classifyRetryFailure(withCode("VALIDATION")), { retry: true, class: "pre_dispatch", reason: "executor rejected before dispatch; side effects cannot have applied" });
  // ambiguous transport failures are never replayed
  for (const code of ["EPIPE", "ECONNRESET", "ETIMEDOUT", "ERR_STREAM_WRITE_AFTER_END"]) {
    const policy = classifyRetryFailure(withCode(code));
    assert.equal(policy.retry, false, `${code} must not retry`);
    assert.equal(policy.class, "ambiguous");
  }
  // terminal failures
  assert.equal(classifyRetryFailure(withCode("ABORT_ERR")).retry, false);
  assert.equal(classifyRetryFailure(withCode("TIMEOUT")).class, "terminal");
  // unknown codes keep the legacy transient-retry behavior
  assert.deepEqual(classifyRetryFailure(new Error("boom")), { retry: true, class: "unclassified", reason: "transient executor failure (attempt 1)" });
});

test("ambiguous transport failures fail fast instead of replaying side effects", async () => {
  const events = [];
  let attempts = 0;
  const runtime = new SubagentRuntime({
    trace: (event, data) => events.push([event, data]),
    executor: async () => {
      attempts += 1;
      const error = new Error("write EPIPE");
      error.code = "EPIPE";
      throw error;
    }
  });
  runtime.spawn({ id: "noreplay", prompt: "run", maxRetries: 2 });
  const result = await runtime.wait("noreplay");
  assert.equal(result.status, "failed");
  assert.equal(attempts, 1, "EPIPE must not be retried");
  assert.equal(result.errorCode, "EPIPE");
  assert.match(result.error, /no-replay/);
  assert.ok(events.some(([event]) => event === "subagent_retry_skipped"), "skip decision must be traced");
  assert.ok(!events.some(([event]) => event === "subagent_retry"), "no replay attempt");
});

test("pre-dispatch failures still retry within budget", async () => {
  const events = [];
  let attempts = 0;
  const runtime = new SubagentRuntime({
    trace: (event, data) => events.push([event, data]),
    executor: async (task) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("schema rejected");
        error.code = "SCHEMA_ERROR";
        throw error;
      }
      return { ok: true, attempts };
    }
  });
  runtime.spawn({ id: "predispatch", prompt: "run", maxRetries: 1 });
  const result = await runtime.wait("predispatch");
  assert.equal(result.status, "completed");
  assert.equal(attempts, 2);
  assert.ok(events.some(([event]) => event === "subagent_retry"));
});
