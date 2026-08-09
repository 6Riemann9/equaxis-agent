const DEFAULT_RUNTIME_GATES = {
  enabled: true,
  minBenchmarkPassRate: 0.8,
  maxReliabilityRegression: 0.02,
  maxUnitCostUsd: 0.05,
  maxLatencyMs: 30000,
  minImprovementDelta: 0.01
};

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function gate(name, actual, threshold, comparator, detail) {
  if (actual === null) return { name, status: false, actual: null, threshold, reason: "missing metric" };
  return { name, status: comparator(actual, threshold), actual, threshold, detail };
}

export function runtimeGateDefaults() {
  return { ...DEFAULT_RUNTIME_GATES };
}

export function evaluateRuntimeGates(metrics = {}, thresholds = {}) {
  const config = { ...DEFAULT_RUNTIME_GATES, ...thresholds };
  if (config.enabled === false) return { ok: true, enabled: false, checks: [], summary: "disabled" };
  const checks = [
    gate("benchmark pass rate", numeric(metrics.benchmarkPassRate), config.minBenchmarkPassRate, (actual, limit) => actual >= limit, ">= minimum"),
    gate("reliability regression", numeric(metrics.reliabilityRegression), config.maxReliabilityRegression, (actual, limit) => actual <= limit, "<= maximum"),
    gate("unit cost", numeric(metrics.unitCostUsd), config.maxUnitCostUsd, (actual, limit) => actual <= limit, "<= maximum"),
    gate("latency", numeric(metrics.latencyMs), config.maxLatencyMs, (actual, limit) => actual <= limit, "<= maximum"),
    gate("improvement", numeric(metrics.improvementDelta), config.minImprovementDelta, (actual, limit) => actual >= limit, ">= minimum")
  ];
  return {
    ok: checks.every((item) => item.status),
    enabled: true,
    thresholds: config,
    metrics: {
      benchmarkPassRate: numeric(metrics.benchmarkPassRate),
      reliabilityRegression: numeric(metrics.reliabilityRegression),
      unitCostUsd: numeric(metrics.unitCostUsd),
      latencyMs: numeric(metrics.latencyMs),
      improvementDelta: numeric(metrics.improvementDelta)
    },
    checks,
    summary: checks.every((item) => item.status) ? "READY" : "NOT READY"
  };
}

export function formatRuntimeGateReport(report) {
  const lines = ["Equaxis runtime gates", report.ok ? "READY" : "NOT READY"];
  if (report.enabled === false) {
    lines.push("disabled");
    return lines.join("\n");
  }
  for (const item of report.checks) {
    const actual = item.actual === null ? "missing" : item.actual;
    lines.push(`${item.status ? "PASS" : "FAIL"}  ${item.name}: ${actual} / ${item.threshold}${item.reason ? ` (${item.reason})` : ""}`);
  }
  return lines.join("\n");
}
