import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRuntimeGates, formatRuntimeGateReport } from "../src/runtime-gates.mjs";

test("passes runtime gates when all metrics meet thresholds", () => {
  const report = evaluateRuntimeGates({
    benchmarkPassRate: 0.91,
    reliabilityRegression: 0.01,
    unitCostUsd: 0.02,
    latencyMs: 12000,
    improvementDelta: 0.04
  }, {
    minBenchmarkPassRate: 0.85,
    maxReliabilityRegression: 0.02,
    maxUnitCostUsd: 0.05,
    maxLatencyMs: 30000,
    minImprovementDelta: 0.01
  });
  assert.equal(report.ok, true);
  assert.equal(report.checks.every((item) => item.status), true);
  assert.match(formatRuntimeGateReport(report), /READY/);
});

test("fails runtime gates deterministically on regressions and missing metrics", () => {
  const report = evaluateRuntimeGates({ benchmarkPassRate: 0.6, latencyMs: 45000 }, {
    minBenchmarkPassRate: 0.8,
    maxReliabilityRegression: 0.02,
    maxUnitCostUsd: 0.05,
    maxLatencyMs: 30000,
    minImprovementDelta: 0.01
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.name === "benchmark pass rate").status, false);
  assert.equal(report.checks.find((item) => item.name === "latency").status, false);
  assert.equal(report.checks.find((item) => item.name === "unit cost").reason, "missing metric");
  assert.match(formatRuntimeGateReport(report), /NOT READY/);
});
