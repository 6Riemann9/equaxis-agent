import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { EvalLoop, compareCandidate, createCandidateChange, createEvalEvent } from "../src/eval-loop.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-eval-loop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("normalizes model tool capability outcome records", () => {
  const event = createEvalEvent({
    provider: "openai-inprior",
    modelId: "gpt-5.5",
    toolName: "edit",
    capability: "code-edit",
    success: true,
    inputTokens: 10,
    outputTokens: 5,
    version: { kind: "prompt", id: "p1" }
  });
  assert.equal(event.model.provider, "openai-inprior");
  assert.equal(event.tool.name, "edit");
  assert.deepEqual(event.capabilities, ["code-edit"]);
  assert.equal(event.outcome, "success");
  assert.equal(event.version.id, "p1");
});

test("aggregates outcomes by model tool and capability", () => {
  const events = [];
  const loop = new EvalLoop({ trace: (event, data) => events.push([event, data.tool.name]) });
  loop.record({ provider: "p", modelId: "m", toolName: "read", capability: "repo-inspect", outcome: "success", score: 0.8, latencyMs: 100, inputTokens: 10, outputTokens: 2, costUsd: 0.01 });
  loop.record({ provider: "p", modelId: "m", toolName: "read", capability: "repo-inspect", outcome: "failure", score: 0.2, errorCode: "TOOL_ERROR", latencyMs: 300, inputTokens: 30, outputTokens: 4, costUsd: 0.03 });
  loop.record({ provider: "p", modelId: "m", toolName: "edit", capability: "code-edit", outcome: "success", latencyMs: 50, inputTokens: 20, outputTokens: 10, costUsd: 0.02 });

  const snapshot = loop.snapshot();
  assert.equal(snapshot.attempts, 3);
  assert.equal(snapshot.successRate, 0.6667);
  const read = snapshot.matrix.find((row) => row.tool === "read");
  assert.equal(read.attempts, 2);
  assert.equal(read.successRate, 0.5);
  assert.equal(read.averageScore, 0.5);
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

test("persists and restores eval events and candidate provenance", (t) => {
  const root = workspace(t);
  const loop = new EvalLoop({ persist: true, projectRoot: root });
  loop.record({ provider: "p", modelId: "baseline", toolName: "read", capability: "repo-inspect", outcome: "success", cohort: "baseline", traceId: "trace-1" });
  const candidate = loop.registerCandidate({ id: "candidate-1", hypothesis: "reduce tool failures", scope: ["repo-inspect"], evidenceTraceIds: ["trace-1"], version: { kind: "policy", id: "policy-v2" } });
  assert.equal(candidate.version.id, "policy-v2");
  assert.deepEqual(candidate.provenance.evidenceTraceIds, ["trace-1"]);

  const eventLog = path.join(root, ".pi", "runtime", "eval-loop", "events.jsonl");
  assert.equal(fs.existsSync(eventLog), true);
  const restored = new EvalLoop({ persist: true, projectRoot: root });
  assert.equal(restored.snapshot().attempts, 1);
  assert.equal(restored.snapshot().candidates[0].id, "candidate-1");
});

test("deterministically decides A/B outcomes", () => {
  const baseline = { attempts: 10, successRate: 0.7, averageLatencyMs: 100 };
  assert.equal(compareCandidate({ baseline, candidate: { attempts: 10, successRate: 0.82, averageLatencyMs: 105 } }).decision, "deploy");
  assert.equal(compareCandidate({ baseline, candidate: { attempts: 10, successRate: 0.6, averageLatencyMs: 90 } }).decision, "reject");
  assert.equal(compareCandidate({ baseline, candidate: { attempts: 3, successRate: 1, averageLatencyMs: 90 } }).decision, "insufficient_data");
  assert.equal(compareCandidate({ baseline, candidate: { attempts: 10, successRate: 0.71, averageLatencyMs: 100 } }).decision, "scoped");
});

test("normalizes candidate changes with version provenance", () => {
  const candidate = createCandidateChange({
    id: "skill-candidate",
    hypothesis: "improve reviews",
    kind: "skill",
    parentVersion: { kind: "skill", id: "skill-v1" },
    changes: { file: "skills/review/SKILL.md" }
  });
  assert.equal(candidate.version.kind, "skill");
  assert.equal(candidate.provenance.parentVersion.id, "skill-v1");
  assert.equal(candidate.provenance.changes.file, "skills/review/SKILL.md");
});
