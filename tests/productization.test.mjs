import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { formatProductizationExerciseReport, formatProductizationReport, runProductizationCommand, runProductizationExercise } from "../src/productization.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-product-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".pi", "extensions"), { recursive: true });
  for (const name of ["provider.ts", "reliability-harness.ts", "memory.ts", "web-crawler.ts", "tool-catalog.ts", "tool-scheduler.ts", "protocol-tools.ts", "ast-tools.ts"]) {
    fs.writeFileSync(path.join(root, ".pi", "extensions", name), "export default () => {};\n");
  }
  fs.mkdirSync(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), JSON.stringify({ version: "0.83.0" }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "equaxis-agent",
    version: "0.2.0",
    private: true,
    type: "module",
    engines: { node: ">=22.19.0" },
    dependencies: { "@earendil-works/pi-coding-agent": "0.83.0" }
  }));
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    runtime: {
      profile: "standard",
      services: { config: true, diagnostics: true, trace: true, status: true },
      gates: { enabled: true, minBenchmarkPassRate: 0.8, maxReliabilityRegression: 0.02, maxUnitCostUsd: 0.05, maxLatencyMs: 30000, minImprovementDelta: 0.01 }
    },
    extensions: { manifest: ".pi/extensions/contracts.json", enabled: [], disabled: [] },
    reliability: {
      mode: "enforce",
      traceDir: ".pi/runtime",
      trace: { maxFileBytes: 5242880, maxFiles: 3 },
      protectPaths: [".env", ".git/", "node_modules/", "*.pem", "*.key"],
      approval: { highRiskBash: true, writesOutsideWorkspace: true, externalEditPolicy: "prompt", externalEditRoots: [], sessionFork: false },
      limits: { maxToolCallsPerTurn: 30, maxHighRiskCallsPerTurn: 3, maxRepairAttemptsPerError: 2 },
      toolRouting: { enabled: true, maxCandidates: 5 }
    },
    memory: { enabled: false, pythonCommand: "python", rootDir: ".equaxis/memory", autoRecall: true, defaultWing: "equaxis", defaultRoom: "general", recallLimit: 5, maxContextChars: 8000, maxStoredMessageChars: 24000, requestTimeoutMs: 60000, governance: { enabled: true, auditPath: ".pi/runtime/memory-governance/memories.jsonl", retentionDays: { hot: 3650, warm: 365, cold: 180 } } },
    evaluation: { enabled: true, rootDir: ".pi/runtime/eval-loop", minSamples: 5, minSuccessRateDelta: 0.02, maxLatencyRegression: 0.1, maxCostRegression: 0.15, confidenceZ: 1.96 }
  }));
  fs.writeFileSync(path.join(root, ".pi", "extensions", "contracts.json"), JSON.stringify({
    schemaVersion: 1,
    manifestVersion: 1,
    piRange: ">=0.83.0 <0.84.0",
    extensions: [
      { id: "provider", entry: "provider.ts", contractVersion: 1, piRange: ">=0.83.0 <0.84.0", failureMode: "fatal", requires: [], provides: ["provider:test"] },
      { id: "reliability", entry: "reliability-harness.ts", contractVersion: 1, piRange: ">=0.83.0 <0.84.0", failureMode: "fatal", requires: [], provides: ["core:policy"] },
      { id: "protocol-tools", entry: "protocol-tools.ts", contractVersion: 1, piRange: ">=0.83.0 <0.84.0", failureMode: "degrade", requires: ["core:policy"], provides: ["tool:advisor_consult", "tool:lsp_probe", "tool:dap_probe"] }, 
      { id: "ast-tools", entry: "ast-tools.ts", contractVersion: 1, piRange: ">=0.83.0 <0.84.0", failureMode: "degrade", requires: ["core:policy"], provides: ["tool:ast_inspect", "tool:ast_rename"] }
    ]
  }));
  return root;
}

function fakeSpawn(calls) {
  return (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: "ok\n", stderr: "" };
  };
}

test("install command runs dependency setup and doctor", (t) => {
  const root = workspace(t);
  const calls = [];
  const report = runProductizationCommand("install", {
    projectRoot: root,
    cwd: root,
    env: { OPENAI_API_KEY: "test-key" },
    nodeVersion: "22.19.0",
    spawnSyncImpl: fakeSpawn(calls),
    npmCommand: "npm"
  });
  assert.equal(report.ok, true);
  assert.deepEqual(calls.map((item) => item[1]), [["install"], ["run", "setup:memory"]]);
  assert.match(formatProductizationReport(report), /Equaxis install/);
});

test("release command verifies before writing a manifest", (t) => {
  const root = workspace(t);
  const calls = [];
  const outputPath = path.join(root, "release.json");
  const report = runProductizationCommand("release", {
    projectRoot: root,
    cwd: root,
    env: { OPENAI_API_KEY: "test-key" },
    nodeVersion: "22.19.0",
    spawnSyncImpl: fakeSpawn(calls),
    npmCommand: "npm",
    outputPath
  });
  assert.equal(report.ok, true);
  assert.deepEqual(calls.map((item) => item[1]), [["run", "verify:full"]]);
  const manifest = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(manifest.name, "equaxis-agent");
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.pi, "0.83.0");
  assert.equal(manifest.gates.verify, "verify:full");
  assert.equal(manifest.gateResults.verifyFull.ok, true);
  assert.equal(manifest.gateResults.verifyFull.status, 0);
  assert.equal(manifest.gateResults.verifyFull.detail, "ok");
  assert.equal(manifest.runtime.evaluation.rootDir, ".pi/runtime/eval-loop");
  assert.equal(manifest.runtime.gates.minBenchmarkPassRate, 0.8);
  assert.equal(manifest.runtime.memory.governance.retentionDays.cold, 180);
});

test("exercise command runs install update release dry-runs across platforms", (t) => {
  const root = workspace(t);
  const calls = [];
  const report = runProductizationExercise({
    projectRoot: root,
    cwd: root,
    env: { OPENAI_API_KEY: "test-key" },
    nodeVersion: "22.19.0",
    spawnSyncImpl: fakeSpawn(calls),
    platforms: ["linux", "win32"]
  });
  assert.equal(report.ok, true);
  assert.equal(report.runs.length, 6);
  assert.deepEqual([...new Set(report.runs.map((item) => item.platform))], ["linux", "win32"]);
  assert.deepEqual([...new Set(report.runs.map((item) => item.command))], ["install", "update", "release"]);
  assert.match(formatProductizationExerciseReport(report), /Equaxis productization exercise/);
  assert.match(formatProductizationExerciseReport(report), /linux install/);
  assert.match(formatProductizationExerciseReport(report), /win32 release/);
});

test("dry-run update reports planned work without spawning npm", (t) => {
  const root = workspace(t);
  const calls = [];
  const report = runProductizationCommand("update", {
    projectRoot: root,
    cwd: root,
    env: { OPENAI_API_KEY: "test-key" },
    nodeVersion: "22.19.0",
    spawnSyncImpl: fakeSpawn(calls),
    dryRun: true
  });
  assert.equal(report.ok, true);
  assert.deepEqual(calls, []);
  assert.ok(report.steps.some((item) => item.detail === "skipped by --dry-run"));
});
