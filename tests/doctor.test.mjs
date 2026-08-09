import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { formatDoctorReport, runDoctor, runStartupPreflight } from "../src/doctor.mjs";

test("doctor reports actionable failures without exposing credential contents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-doctor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".pi"));
  fs.writeFileSync(path.join(root, ".pi", "memory.json"), JSON.stringify({ enabled: false }));
  const report = runDoctor({ projectRoot: root, cwd: root, env: {}, nodeVersion: "20.0.0" });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.name === "Node.js").status, false);
  assert.equal(report.checks.find((item) => item.name === "Provider credential").status, false);
  assert.match(formatDoctorReport(report), /NOT READY/);
});

function writeStartupConfig(root, overrides = {}) {
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    runtime: { profile: "standard", services: { config: true, diagnostics: true, trace: true, status: true } },
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
    memory: { enabled: false, pythonCommand: "python", rootDir: ".equaxis/memory", autoRecall: true, defaultWing: "equaxis", defaultRoom: "general", recallLimit: 5, maxContextChars: 8000, maxStoredMessageChars: 24000, requestTimeoutMs: 60000 },
    ...overrides
  }));
}

function writePiDependency(root) {
  fs.mkdirSync(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), JSON.stringify({ version: "0.83.0" }));
}

function writeRequiredExtensions(root) {
  fs.mkdirSync(path.join(root, ".pi", "extensions"), { recursive: true });
  for (const name of ["provider.ts", "reliability-harness.ts", "memory.ts", "web-crawler.ts", "tool-catalog.ts", "tool-scheduler.ts", "protocol-tools.ts", "ast-tools.ts"]) {
    fs.writeFileSync(path.join(root, ".pi", "extensions", name), "export default () => {};\n");
  }
}

test("startup preflight reads startup-facing config from the project root even when cwd differs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-startup-root-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-startup-cwd-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    runtime: { profile: "full", services: { config: true, diagnostics: true, trace: true, status: true } },
    extensions: { manifest: ".pi/extensions/contracts.json", enabled: [], disabled: [] },
    reliability: {
      mode: "audit",
      traceDir: ".pi/runtime",
      trace: { maxFileBytes: 5242880, maxFiles: 7 },
      protectPaths: [".env", ".git/", "node_modules/", "*.pem", "*.key"],
      approval: { highRiskBash: true, writesOutsideWorkspace: true, externalEditPolicy: "prompt", externalEditRoots: [], sessionFork: false },
      limits: { maxToolCallsPerTurn: 30, maxHighRiskCallsPerTurn: 3, maxRepairAttemptsPerError: 2 },
      toolRouting: { enabled: true, maxCandidates: 5 }
    },
    memory: { enabled: false, pythonCommand: "python", rootDir: ".equaxis/memory", autoRecall: true, defaultWing: "equaxis", defaultRoom: "general", recallLimit: 5, maxContextChars: 8000, maxStoredMessageChars: 24000, requestTimeoutMs: 60000 }
  }));
  fs.writeFileSync(path.join(cwd, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    runtime: { profile: "minimal", services: { config: true, diagnostics: true, trace: true, status: true } },
    extensions: { manifest: ".pi/extensions/contracts.json", enabled: [], disabled: [] },
    reliability: {
      mode: "enforce",
      traceDir: ".pi/runtime",
      trace: { maxFileBytes: 5242880, maxFiles: 2 },
      protectPaths: [".env", ".git/", "node_modules/", "*.pem", "*.key"],
      approval: { highRiskBash: true, writesOutsideWorkspace: true, externalEditPolicy: "prompt", externalEditRoots: [], sessionFork: false },
      limits: { maxToolCallsPerTurn: 30, maxHighRiskCallsPerTurn: 3, maxRepairAttemptsPerError: 2 },
      toolRouting: { enabled: true, maxCandidates: 5 }
    },
    memory: { enabled: true, pythonCommand: "python", rootDir: ".equaxis/memory", autoRecall: true, defaultWing: "equaxis", defaultRoom: "general", recallLimit: 5, maxContextChars: 8000, maxStoredMessageChars: 24000, requestTimeoutMs: 60000 }
  }));

  const report = runStartupPreflight({ projectRoot: root, cwd, env: {}, nodeVersion: "22.19.0" });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.name === "Unified config").detail.includes("profile=full"), true);
  assert.equal(report.checks.find((item) => item.name === "Extension contracts").status, false);
  assert.equal(report.checks.find((item) => item.name === "Provider credential").status, false);
});

test("doctor checks protocol tool declarations", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-doctor-protocol-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeRequiredExtensions(root);
  writePiDependency(root);
  writeStartupConfig(root);
  fs.writeFileSync(path.join(root, ".pi", "extensions", "contracts.json"), JSON.stringify({
    schemaVersion: 1,
    manifestVersion: 1,
    piRange: ">=0.83.0 <0.84.0",
    extensions: [
      { id: "provider", entry: "provider.ts", contractVersion: 1, piRange: ">=0.83.0 <0.84.0", failureMode: "fatal", requires: [], provides: ["provider:test"] },
      { id: "reliability", entry: "reliability-harness.ts", contractVersion: 1, piRange: ">=0.83.0 <0.84.0", failureMode: "fatal", requires: [], provides: ["core:policy"] },
      { id: "protocol-tools", entry: "protocol-tools.ts", contractVersion: 1, piRange: ">=0.83.0 <0.84.0", failureMode: "degrade", requires: ["core:policy"], provides: ["tool:advisor_consult", "tool:lsp_probe", "tool:dap_probe"] }
    ]
  }));

  const report = runDoctor({ projectRoot: root, cwd: root, env: { OPENAI_API_KEY: "test-key" }, nodeVersion: "22.19.0" });
  assert.equal(
    report.checks.find((item) => item.name === "Protocol tools").detail,
    "advisor/lsp/dap tools declared; lsp=unconfigured,locked; dap=unconfigured,locked"
  );
  assert.equal(
    report.checks.find((item) => item.name === "Runtime isolation").detail,
    "scrubbed-env; outputRoot=.pi/runtime/isolated"
  );
  assert.equal(
    report.checks.find((item) => item.name === "Subagent budgets").detail,
    "timeout=none; maxRetries=0"
  );
  assert.equal(
    report.checks.find((item) => item.name === "Subagent persistence").detail,
    "snapshotDir=.pi/runtime/subagents/snapshots"
  );
  assert.equal(
    report.checks.find((item) => item.name === "Evaluation loop").detail,
    "rootDir=.pi/runtime/eval-loop; minSamples=5"
  );
});
