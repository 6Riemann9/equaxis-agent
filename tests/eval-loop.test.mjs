import test from "node:test";
import assert from "node:assert/strict";
import { EvalLoop, createEvalEvent } from "../src/eval-loop.mjs";

test("normalizes model tool capability outcome records", () => {
  const event = createEvalEvent({
    provider: "openai-inprior",
    modelId: "gpt-5.5",
    toolName: "edit",
    capability: "code-edit",
    success: true,
    inputTokens: 10,
    outputTokens: 5
  });
  assert.equal(event.model.provider, "openai-inprior");
  assert.equal(event.tool.name, "edit");
  assert.deepEqual(event.capabilities, ["code-edit"]);
  assert.equal(event.outcome, "success");
});

test("aggregates outcomes by model tool and capability", () => {
  const events = [];
  const loop = new EvalLoop({ trace: (event, data) => events.push([event, data.tool.name]) });
  loop.record({ provider: "p", modelId: "m", toolName: "read", capability: "repo-inspect", outcome: "success", latencyMs: 100, inputTokens: 10, outputTokens: 2, costUsd: 0.01 });
  loop.record({ provider: "p", modelId: "m", toolName: "read", capability: "repo-inspect", outcome: "failure", errorCode: "TOOL_ERROR", latencyMs: 300, inputTokens: 30, outputTokens: 4, costUsd: 0.03 });
  loop.record({ provider: "p", modelId: "m", toolName: "edit", capability: "code-edit", outcome: "success", latencyMs: 50, inputTokens: 20, outputTokens: 10, costUsd: 0.02 });

  const snapshot = loop.snapshot();
  assert.equal(snapshot.attempts, 3);
  assert.equal(snapshot.successRate, 0.6667);
  const read = snapshot.matrix.find((row) => row.tool === "read");
  assert.equal(read.attempts, 2);
  assert.equal(read.successRate, 0.5);
  assert.equal(read.averageLatencyMs, 200);
  assert.deepEqual(read.errorCodes, { TOOL_ERROR: 1 });
  assert.deepEqual(events.map(([event]) => event), ["eval_outcome_recorded", "eval_outcome_recorded", "eval_outcome_recorded"]);
});

test("filters snapshots by capability", () => {
  const loop = new EvalLoop();
  loop.record({ provider: "p", modelId: "m", toolName: "read", capability: "repo-inspect", outcome: "success" });
  loop.record({ provider: "p", modelId: "m", toolName: "edit", capability: "code-edit", outcome: "failure" });
  const snapshot = loop.snapshot({ capability: "code-edit" });
  assert.equal(snapshot.attempts, 1);
  assert.equal(snapshot.matrix[0].tool, "edit");
});
