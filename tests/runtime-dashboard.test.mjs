import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { EvalLoop } from "../src/eval-loop.mjs";
import { VersionStore } from "../src/version-store.mjs";
import { buildRuntimeDashboard, formatRuntimeDashboard } from "../src/runtime-dashboard.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-dashboard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("builds a runtime dashboard from eval events versions and runtime files", (t) => {
  const root = workspace(t);
  const config = {
    runtime: { gates: { enabled: true, minBenchmarkPassRate: 0.8, maxReliabilityRegression: 0.02, maxUnitCostUsd: 0.05, maxLatencyMs: 30000, minImprovementDelta: 0.01 } },
    evaluation: { enabled: true, rootDir: ".pi/runtime/eval-loop" },
    memory: { governance: { enabled: true, auditPath: ".pi/runtime/memory-governance/memories.jsonl", retentionDays: { hot: 3650, warm: 365, cold: 180 } } },
    protocols: { lsp: { command: "" }, dap: { command: "" } }
  };
  const loop = new EvalLoop({ persist: true, projectRoot: root });
  loop.record({ toolName: "read", capability: "repo-inspect", outcome: "success", cohort: "baseline" });
  new VersionStore({ projectRoot: root }).writeCandidate({ kind: "prompt", id: "candidate-1", status: "scoped", changes: { file: "prompts/review.md" } });
  fs.mkdirSync(path.join(root, ".pi", "runtime", "protocols"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "runtime", "protocols", "traces.jsonl"), "{}\n", "utf8");

  const dashboard = buildRuntimeDashboard({
    projectRoot: root,
    config,
    env: {},
    spawnSyncImpl: () => ({ status: 0, stdout: "", stderr: "" }),
    gateMetrics: { benchmarkPassRate: 0.9, reliabilityRegression: 0, unitCostUsd: 0.01, latencyMs: 1000, improvementDelta: 0.02 }
  });
  assert.equal(dashboard.evaluation.attempts, 1);
  assert.equal(dashboard.evaluation.successRate, 1);
  assert.equal(dashboard.versions.total, 1);
  assert.deepEqual(dashboard.versions.byKind, { prompt: 1 });
  assert.equal(dashboard.gates.ok, true);
  assert.equal(dashboard.memoryGovernance.enabled, true);
  assert.equal(dashboard.runtimeFiles.protocolTrace.exists, true);
  assert.equal(dashboard.protocols.lsp.status, "skipped");
  assert.match(formatRuntimeDashboard(dashboard), /Equaxis runtime dashboard/);
  assert.match(formatRuntimeDashboard(dashboard), /Gates: READY/);
  assert.match(formatRuntimeDashboard(dashboard), /Evaluation: attempts=1/);
  assert.match(formatRuntimeDashboard(dashboard), /Memory governance: enabled/);
});
