import test from "node:test";
import assert from "node:assert/strict";
import { generatedBoundaryCases, MockToolRegistry } from "../src/mock-runtime.mjs";

test("records mock calls and injects scripted response/error", async () => {
  const mocks = new MockToolRegistry();
  mocks.register("search", { response: (args, context) => ({ args, traceId: context.traceId }) });
  const result = await mocks.invoke("search", { query: "pool" }, { traceId: "t-1" });
  assert.deepEqual(result, { args: { query: "pool" }, traceId: "t-1" });
  mocks.assertCalled("search");
  assert.equal(mocks.calls[0].args.query, "pool");
});

test("supports deterministic error and duplicate-call injection", async () => {
  const mocks = new MockToolRegistry();
  mocks.register("write", { response: { ok: true }, once: true });
  await mocks.invoke("write", { path: "a" });
  await assert.rejects(() => mocks.invoke("write", { path: "a" }), /more than once/);
  mocks.assertCalled("write", 2);
});

test("generates valid, missing, wrong-type and numeric boundary cases", () => {
  const cases = generatedBoundaryCases({ validArgs: { query: "x", limit: 5 }, requiredStrings: ["query"], numericBounds: { limit: { min: 1, max: 20 } } });
  assert.deepEqual(cases.map((item) => item.name), ["valid", "query_missing", "query_wrong_type", "limit_below_min", "limit_above_max"]);
});

