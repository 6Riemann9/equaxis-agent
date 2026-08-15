import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { collectEvalEventsFromTraceDir, createEvalLoopFromTrace, EvalLoop, compareCandidate, compareCandidateWithHoldout, createCandidateChange, createEvalEvent } from "../src/eval-loop.mjs";

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
  const baseline = { attempts: 200, successes: 140, successRate: 0.7, averageLatencyMs: 100, averageCostUsd: 0.01 };
  const deploy = compareCandidate({ baseline, candidate: { attempts: 200, successes: 180, successRate: 0.9, averageLatencyMs: 105, averageCostUsd: 0.011 } });
  assert.equal(deploy.decision, "deploy");
  assert.equal(deploy.confidence.z, 1.96);
  assert.equal(compareCandidate({ baseline, candidate: { attempts: 200, successes: 120, successRate: 0.6, averageLatencyMs: 90, averageCostUsd: 0.01 } }).decision, "reject");
  assert.equal(compareCandidate({ baseline, candidate: { attempts: 3, successes: 3, successRate: 1, averageLatencyMs: 90, averageCostUsd: 0.01 } }).decision, "insufficient_data");
  const scoped = compareCandidate({ baseline, candidate: { attempts: 20, successes: 16, successRate: 0.8, averageLatencyMs: 100, averageCostUsd: 0.01 }, minSamples: 10 });
  assert.equal(scoped.decision, "scoped");
  assert.match(scoped.reason, /confidence intervals/);
  const costReject = compareCandidate({ baseline, candidate: { attempts: 200, successes: 142, successRate: 0.71, averageLatencyMs: 100, averageCostUsd: 0.02 } });
  assert.equal(costReject.decision, "reject");
  assert.match(costReject.reason, /cost regressed/);
});

test("holdout gate deploys only on train gain + dev non-regression", () => {
  const baseline = { attempts: 200, successes: 140, successRate: 0.7, averageLatencyMs: 100, averageCostUsd: 0.01 };
  const improved = { attempts: 200, successes: 180, successRate: 0.9, averageLatencyMs: 105, averageCostUsd: 0.011 };
  const holdoutBaseline = { attempts: 100, successes: 70, successRate: 0.7, averageLatencyMs: 100, averageCostUsd: 0.01 };

  // train improved + holdout flat -> deploy
  const deploy = compareCandidateWithHoldout({
    baseline,
    candidate: improved,
    holdoutBaseline,
    holdoutCandidate: { attempts: 100, successes: 72, successRate: 0.72, averageLatencyMs: 100, averageCostUsd: 0.01 }
  });
  assert.equal(deploy.decision, "deploy");
  assert.equal(deploy.holdout, "pass");

  // train improved + holdout regressed -> reject (AutoDesign acceptance gate)
  const rejected = compareCandidateWithHoldout({
    baseline,
    candidate: improved,
    holdoutBaseline,
    holdoutCandidate: { attempts: 100, successes: 60, successRate: 0.6, averageLatencyMs: 100, averageCostUsd: 0.01 }
  });
  assert.equal(rejected.decision, "reject");
  assert.equal(rejected.holdout, "regressed");
  assert.match(rejected.reason, /holdout/);
  assert.equal(rejected.mainDecision, "deploy");

  // main reject short-circuits without holdout
  const shortCircuit = compareCandidateWithHoldout({
    baseline,
    candidate: { attempts: 200, successes: 120, successRate: 0.6, averageLatencyMs: 90, averageCostUsd: 0.01 },
    holdoutBaseline,
    holdoutCandidate: { attempts: 100, successes: 80, successRate: 0.8, averageLatencyMs: 90, averageCostUsd: 0.01 }
  });
  assert.equal(shortCircuit.decision, "reject");
  assert.equal(shortCircuit.holdout, undefined);

  // missing holdout data -> skipped, main decision stands
  const skipped = compareCandidateWithHoldout({ baseline, candidate: improved });
  assert.equal(skipped.decision, "deploy");
  assert.equal(skipped.holdout, "skipped");

  // insufficient holdout samples -> not deployed via holdout path
  const thin = compareCandidateWithHoldout({
    baseline,
    candidate: improved,
    holdoutBaseline,
    holdoutCandidate: { attempts: 2, successes: 2, successRate: 1, averageLatencyMs: 90, averageCostUsd: 0.01 }
  });
  assert.equal(thin.holdout, "insufficient_data");
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
test("collectEvalEventsFromTraceDir reads rotated trace archives newest-last", (t) => {
  const root = workspace(t);
  const traceDir = path.join(root, ".pi", "runtime");
  fs.mkdirSync(traceDir, { recursive: true });
  const trace = (traceId, toolName) => JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", source: "reliability", event: "eval_outcome_recorded", model: { provider: "p", id: "m" }, tool: { name: toolName }, capabilities: ["c"], outcome: "success", latencyMs: 10, traceId }) + "\n";
  fs.writeFileSync(path.join(traceDir, "traces.2.jsonl"), trace("t-2", "read"));
  fs.writeFileSync(path.join(traceDir, "traces.1.jsonl"), trace("t-1", "edit"));
  fs.writeFileSync(path.join(traceDir, "traces.jsonl"), trace("t-0", "bash"));
  const events = collectEvalEventsFromTraceDir(root, ".pi/runtime", { maxFiles: 3 });
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.traceId), ["t-2", "t-1", "t-0"]);
  assert.equal(events[0].tool.name, "read");
  assert.deepEqual(events[2].capabilities, ["c"]);
});

test("createEvalLoopFromTrace merges trace facts with the offline ledger and dedupes by traceId", (t) => {
  const root = workspace(t);
  const traceDir = path.join(root, ".pi", "runtime");
  fs.mkdirSync(traceDir, { recursive: true });
  const traceLine = (traceId, toolName) => JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", source: "reliability", event: "eval_outcome_recorded", model: { provider: "p", id: "m" }, tool: { name: toolName }, capabilities: ["c"], outcome: "success", latencyMs: 10, traceId }) + "\n";
  // trace carries two runtime outcomes; the ledger has one duplicate (same
  // traceId, legacy harness) plus one manual record without traceId.
  fs.writeFileSync(path.join(traceDir, "traces.jsonl"), traceLine("t-1", "read") + traceLine("t-2", "edit"));
  const ledger = new EvalLoop({ persist: true, projectRoot: root });
  ledger.record({ provider: "p", modelId: "m", toolName: "read", capability: "c", outcome: "success", traceId: "t-1" });
  ledger.record({ provider: "p", modelId: "m", toolName: "reflect", capability: "c", outcome: "success" });
  const loop = createEvalLoopFromTrace({ projectRoot: root, traceDir: ".pi/runtime", persist: true });
  const snapshot = loop.snapshot();
  assert.equal(snapshot.attempts, 3, "trace t-1,t-2 + ledger reflect (deduped t-1)");
  const tools = snapshot.matrix.map((row) => row.tool).sort();
  assert.deepEqual(tools, ["edit", "read", "reflect"]);
  const read = snapshot.matrix.find((row) => row.tool === "read");
  assert.equal(read.attempts, 1, "legacy duplicate dropped");
});

test("createEvalLoopFromTrace with persist disabled keeps trace-only facts", (t) => {
  const root = workspace(t);
  const traceDir = path.join(root, ".pi", "runtime");
  fs.mkdirSync(traceDir, { recursive: true });
  const line = JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", source: "reliability", event: "eval_outcome_recorded", model: { provider: "p", id: "m" }, tool: { name: "read" }, capabilities: ["c"], outcome: "failure", errorCode: "TOOL_ERROR", traceId: "t-9" }) + "\n";
  fs.writeFileSync(path.join(traceDir, "traces.jsonl"), line);
  const loop = createEvalLoopFromTrace({ projectRoot: root, traceDir: ".pi/runtime", persist: false });
  const snapshot = loop.snapshot();
  assert.equal(snapshot.attempts, 1);
  assert.equal(snapshot.matrix[0].tool, "read");
  assert.deepEqual(snapshot.matrix[0].errorCodes, { TOOL_ERROR: 1 });
});
