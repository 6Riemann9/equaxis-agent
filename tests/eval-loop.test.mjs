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

test("decisionWithHoldout deploys on train gain + dev non-regression over cohort events", (t) => {
  const root = workspace(t);
  const loop = new EvalLoop({ persist: true, projectRoot: root });
  const event = (cohort, version, outcome) => loop.record({
    provider: "p", modelId: "m", toolName: "read", capability: "repo-inspect",
    outcome, cohort, version: { kind: "policy", id: version }
  });
  // train cohort: baseline 100 attempts @70% + candidate 100 attempts @90%
  for (let i = 0; i < 70; i += 1) event("train", "base-v1", "success");
  for (let i = 0; i < 30; i += 1) event("train", "base-v1", "failure");
  for (let i = 0; i < 90; i += 1) event("train", "cand-v2", "success");
  for (let i = 0; i < 10; i += 1) event("train", "cand-v2", "failure");
  // dev cohort: baseline 50 @70% + candidate 50 @72% (flat, within tolerance)
  for (let i = 0; i < 35; i += 1) event("dev", "base-v1", "success");
  for (let i = 0; i < 15; i += 1) event("dev", "base-v1", "failure");
  for (let i = 0; i < 36; i += 1) event("dev", "cand-v2", "success");
  for (let i = 0; i < 14; i += 1) event("dev", "cand-v2", "failure");

  const decision = loop.decisionWithHoldout({ trainCohort: "train", devCohort: "dev", versionId: "cand-v2", tool: "read", capability: "repo-inspect" });
  assert.equal(decision.decision, "deploy");
  assert.equal(decision.holdout, "pass");
  assert.equal(decision.versionId, "cand-v2");
});

test("decisionWithHoldout rejects when dev cohort regresses despite train gain", (t) => {
  const loop = new EvalLoop();
  const event = (cohort, version, outcome) => loop.record({
    provider: "p", modelId: "m", toolName: "read", capability: "repo-inspect",
    outcome, cohort, version: { kind: "policy", id: version }
  });
  for (let i = 0; i < 70; i += 1) event("train", "base-v1", "success");
  for (let i = 0; i < 30; i += 1) event("train", "base-v1", "failure");
  for (let i = 0; i < 90; i += 1) event("train", "cand-v2", "success");
  for (let i = 0; i < 10; i += 1) event("train", "cand-v2", "failure");
  // dev regression: candidate 60% vs baseline 70%
  for (let i = 0; i < 35; i += 1) event("dev", "base-v1", "success");
  for (let i = 0; i < 15; i += 1) event("dev", "base-v1", "failure");
  for (let i = 0; i < 30; i += 1) event("dev", "cand-v2", "success");
  for (let i = 0; i < 20; i += 1) event("dev", "cand-v2", "failure");

  const decision = loop.decisionWithHoldout({ trainCohort: "train", devCohort: "dev", versionId: "cand-v2", tool: "read", capability: "repo-inspect" });
  assert.equal(decision.decision, "reject");
  assert.equal(decision.holdout, "regressed");
  assert.equal(decision.mainDecision, "deploy");
});

test("decisionWithHoldout persists and restores holdout metadata", (t) => {
  const root = workspace(t);
  const loop = new EvalLoop({ persist: true, projectRoot: root });
  loop.record({ provider: "p", modelId: "m", toolName: "read", capability: "c", outcome: "success", cohort: "train", version: { kind: "policy", id: "v0" } });
  loop.record({ provider: "p", modelId: "m", toolName: "read", capability: "c", outcome: "success", cohort: "train", version: { kind: "policy", id: "v1" } });
  loop.record({ provider: "p", modelId: "m", toolName: "read", capability: "c", outcome: "success", cohort: "dev", version: { kind: "policy", id: "v0" } });
  loop.record({ provider: "p", modelId: "m", toolName: "read", capability: "c", outcome: "success", cohort: "dev", version: { kind: "policy", id: "v1" } });
  loop.decisionWithHoldout({ trainCohort: "train", devCohort: "dev", versionId: "v1", tool: "read", capability: "c", minSamples: 1 });

  const restored = new EvalLoop({ persist: true, projectRoot: root });
  assert.equal(restored.decisions.length, 1);
  assert.equal(restored.decisions[0].trainCohort, "train");
  assert.equal(restored.decisions[0].devCohort, "dev");
  assert.ok("holdout" in restored.decisions[0]);
});

test("decisionWithHoldout requires versionId", () => {
  const loop = new EvalLoop();
  assert.throws(() => loop.decisionWithHoldout({ trainCohort: "train", devCohort: "dev" }), /requires versionId/);
});

test("capabilityDeltaMatrix reports per-capability version deltas", () => {
  const loop = new EvalLoop();
  const record = (capability, version, outcome) => loop.record({
    provider: "p", modelId: "m", toolName: "read", capability,
    outcome, version: { kind: "policy", id: version }
  });
  // repo-inspect: improved by candidate (0.5 -> 0.9)
  for (let i = 0; i < 5; i += 1) record("repo-inspect", "v1", "success");
  for (let i = 0; i < 5; i += 1) record("repo-inspect", "v1", "failure");
  for (let i = 0; i < 9; i += 1) record("repo-inspect", "v2", "success");
  for (let i = 0; i < 1; i += 1) record("repo-inspect", "v2", "failure");
  // edit-apply: regressed by candidate (0.8 -> 0.4)
  for (let i = 0; i < 8; i += 1) record("edit-apply", "v1", "success");
  for (let i = 0; i < 2; i += 1) record("edit-apply", "v1", "failure");
  for (let i = 0; i < 4; i += 1) record("edit-apply", "v2", "success");
  for (let i = 0; i < 6; i += 1) record("edit-apply", "v2", "failure");
  // other-version events are ignored
  record("repo-inspect", "v0", "failure");

  const matrix = loop.capabilityDeltaMatrix({ baselineVersionId: "v1", candidateVersionId: "v2" });
  assert.equal(matrix.rows.length, 2);
  const repo = matrix.rows.find((row) => row.capability === "repo-inspect");
  assert.equal(repo.delta, 0.4);
  const edit = matrix.rows.find((row) => row.capability === "edit-apply");
  assert.equal(edit.delta, -0.4);
  assert.deepEqual(matrix.improved, ["repo-inspect"]);
  assert.deepEqual(matrix.regressed, ["edit-apply"]);
  assert.deepEqual(matrix.unchanged, []);
});

test("capabilityDeltaMatrix honors filters and tolerates empty data", () => {
  const loop = new EvalLoop();
  assert.deepEqual(loop.capabilityDeltaMatrix({ baselineVersionId: "a", candidateVersionId: "b" }).rows, []);
  loop.record({ provider: "p", modelId: "m", toolName: "read", capability: "c", outcome: "success", version: { kind: "policy", id: "a" } });
  loop.record({ provider: "p", modelId: "m", toolName: "read", capability: "c", outcome: "success", version: { kind: "policy", id: "b" } });
  const filtered = loop.capabilityDeltaMatrix({ baselineVersionId: "a", candidateVersionId: "b", tool: "write" });
  assert.equal(filtered.rows.length, 0, "tool filter excludes read events");
  const full = loop.capabilityDeltaMatrix({ baselineVersionId: "a", candidateVersionId: "b" });
  assert.equal(full.rows.length, 1);
  assert.equal(full.rows[0].delta, 0);
  assert.deepEqual(full.unchanged, ["c"]);
});

test("decision records carry provenance: decisionId, causal links, scenario, evidence", () => {
  const loop = new EvalLoop();
  const parent = loop.decision({
    baseline: { attempts: 10, successes: 8, successRate: 0.8, averageLatencyMs: 100, averageCostUsd: 0.01 },
    candidate: { attempts: 10, successes: 9, successRate: 0.9, averageLatencyMs: 90, averageCostUsd: 0.01 },
    decisionId: "dec-1",
    scenario: "policy v2 rollout",
    reasoning: "win rate improved",
    confidence: 0.95,
    evidence: ["trace-9"]
  });
  assert.equal(parent.decisionId, "dec-1");
  assert.equal(parent.parentDecisionId, null);
  assert.equal(parent.causalType, null);
  assert.equal(parent.scenario, "policy v2 rollout");
  assert.equal(parent.confidence, 0.95);
  assert.deepEqual(parent.evidence, ["trace-9"]);

  const child = loop.decision({
    baseline: { attempts: 10, successes: 8, successRate: 0.8, averageLatencyMs: 100, averageCostUsd: 0.01 },
    candidate: { attempts: 10, successes: 9, successRate: 0.9, averageLatencyMs: 90, averageCostUsd: 0.01 },
    decisionId: "dec-2",
    parentDecisionId: "dec-1",
    causalType: "CAUSED",
    scenario: "policy v2 follow-up",
    reasoning: "latency target kept"
  });
  assert.equal(child.causalType, "CAUSED");
  assert.equal(child.parentDecisionId, "dec-1");

  // auto-generated decisionId when absent
  const auto = loop.decision({
    baseline: { attempts: 5, successes: 5, successRate: 1, averageLatencyMs: 100, averageCostUsd: 0.01 },
    candidate: { attempts: 5, successes: 5, successRate: 1, averageLatencyMs: 90, averageCostUsd: 0.01 }
  });
  assert.match(auto.decisionId, /^[0-9a-f-]{36}$/);

  // invalid causal types are rejected, not silently accepted
  assert.throws(
    () => loop.decision({
      baseline: { attempts: 5, successes: 5, successRate: 1, averageLatencyMs: 100, averageCostUsd: 0.01 },
      candidate: { attempts: 5, successes: 5, successRate: 1, averageLatencyMs: 90, averageCostUsd: 0.01 },
      causalType: "BECAUSE_OF"
    }),
    /invalid causalType/
  );
  // lowercase input normalizes
  const normalized = loop.decision({
    baseline: { attempts: 5, successes: 5, successRate: 1, averageLatencyMs: 100, averageCostUsd: 0.01 },
    candidate: { attempts: 5, successes: 5, successRate: 1, averageLatencyMs: 90, averageCostUsd: 0.01 },
    causalType: "precedent_for"
  });
  assert.equal(normalized.causalType, "PRECEDENT_FOR");
});

test("traceDecisionChain walks upstream parents and downstream children with depth", () => {
  const loop = new EvalLoop();
  const base = { attempts: 10, successes: 8, successRate: 0.8, averageLatencyMs: 100, averageCostUsd: 0.01 };
  const better = { attempts: 10, successes: 9, successRate: 0.9, averageLatencyMs: 90, averageCostUsd: 0.01 };
  loop.decision({ baseline: base, candidate: better, decisionId: "dec-a", scenario: "root" });
  loop.decision({ baseline: base, candidate: better, decisionId: "dec-b", parentDecisionId: "dec-a", causalType: "CAUSED", scenario: "middle" });
  loop.decision({ baseline: base, candidate: better, decisionId: "dec-c", parentDecisionId: "dec-b", causalType: "INFLUENCED", scenario: "leaf" });

  const upstream = loop.traceDecisionChain("dec-c");
  assert.equal(upstream.found, true);
  assert.deepEqual(upstream.chain.map((node) => node.decisionId), ["dec-c", "dec-b", "dec-a"]);
  assert.deepEqual(upstream.chain.map((node) => node.depth), [0, 1, 2]);
  assert.equal(upstream.chain[1].causalType, "CAUSED");

  const downstream = loop.traceDecisionChain("dec-a", { direction: "downstream" });
  assert.deepEqual(downstream.chain.map((node) => node.decisionId), ["dec-a", "dec-b", "dec-c"]);
  assert.deepEqual(downstream.chain.map((node) => node.depth), [0, 1, 2]);

  const missing = loop.traceDecisionChain("dec-z");
  assert.equal(missing.found, false);
  assert.deepEqual(missing.chain, []);
});

test("decisionImpact aggregates downstream decisions, tools and capabilities", () => {
  const loop = new EvalLoop();
  const base = { attempts: 10, successes: 8, successRate: 0.8, averageLatencyMs: 100, averageCostUsd: 0.01 };
  const better = { attempts: 10, successes: 9, successRate: 0.9, averageLatencyMs: 90, averageCostUsd: 0.01 };
  loop.decision({ baseline: base, candidate: better, decisionId: "dec-1", scenario: "root" });
  loop.decisionWithHoldout({ trainCohort: "train", devCohort: "dev", versionId: "v2", tool: "edit", capability: "edit-apply", decisionId: "dec-2", parentDecisionId: "dec-1", causalType: "CAUSED", scenario: "child edit" });
  loop.decisionWithHoldout({ trainCohort: "train", devCohort: "dev", versionId: "v2", tool: "read", capability: "repo-inspect", decisionId: "dec-3", parentDecisionId: "dec-2", causalType: "INFLUENCED", scenario: "grandchild read" });

  const impact = loop.decisionImpact("dec-1");
  assert.equal(impact.found, true);
  assert.equal(impact.count, 3);
  assert.deepEqual(impact.tools, ["edit", "read"]);
  assert.deepEqual(impact.capabilities, ["edit-apply", "repo-inspect"]);
  assert.equal(impact.chain[2].decisionId, "dec-3");
});

test("findPrecedents ranks decisions by scenario overlap deterministically", () => {
  const loop = new EvalLoop();
  const base = { attempts: 10, successes: 8, successRate: 0.8, averageLatencyMs: 100, averageCostUsd: 0.01 };
  const better = { attempts: 10, successes: 9, successRate: 0.9, averageLatencyMs: 90, averageCostUsd: 0.01 };
  loop.decision({ baseline: base, candidate: better, decisionId: "dec-x", scenario: "provider migration to deepseek", reasoning: "cost dropped" });
  loop.decision({ baseline: base, candidate: better, decisionId: "dec-y", scenario: "provider migration to openai", reasoning: "latency dropped" });
  loop.decision({ baseline: base, candidate: better, decisionId: "dec-z", scenario: "unrelated skill refactor", reasoning: "none" });

  const precedents = loop.findPrecedents({ scenario: "provider migration deepseek", limit: 2 });
  assert.equal(precedents.length, 2);
  assert.equal(precedents[0].decisionId, "dec-x");
  assert.ok(precedents[0].score >= precedents[1].score);
  assert.ok(["deploy", "scoped"].includes(precedents[0].decision));

  assert.deepEqual(loop.findPrecedents({ scenario: "" }), []);
  assert.deepEqual(loop.findPrecedents({ scenario: "zzz qqq" }), []);
});

test("provenance fields survive persistence round-trip", (t) => {
  const root = workspace(t);
  const loop = new EvalLoop({ persist: true, projectRoot: root });
  const base = { attempts: 5, successes: 5, successRate: 1, averageLatencyMs: 100, averageCostUsd: 0.01 };
  const better = { attempts: 5, successes: 5, successRate: 1, averageLatencyMs: 90, averageCostUsd: 0.01 };
  loop.decision({ baseline: base, candidate: better, decisionId: "dec-root", scenario: "root scenario" });
  loop.decision({
    baseline: base,
    candidate: better,
    decisionId: "dec-persist",
    parentDecisionId: "dec-root",
    causalType: "CAUSED",
    scenario: "persisted scenario",
    evidence: ["trace-1", "trace-2"]
  });

  const restored = new EvalLoop({ persist: true, projectRoot: root });
  assert.equal(restored.decisions.length, 2);
  const record = restored.decisions.find((entry) => entry.decisionId === "dec-persist");
  assert.equal(record.decisionId, "dec-persist");
  assert.equal(record.parentDecisionId, "dec-root");
  assert.equal(record.causalType, "CAUSED");
  assert.equal(record.scenario, "persisted scenario");
  assert.deepEqual(record.evidence, ["trace-1", "trace-2"]);

  // chain trace works on restored records too
  const chain = restored.traceDecisionChain("dec-persist");
  assert.deepEqual(chain.chain.map((node) => node.decisionId), ["dec-persist", "dec-root"]);
});
