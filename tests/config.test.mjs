import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";
import { loadEquaxisConfig } from "../src/equaxis-config.mjs";
import { loadMemoryConfig } from "../src/memory-config.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-config-"));
  fs.mkdirSync(path.join(root, ".pi"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("merges nested reliability defaults before validation", (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, ".pi", "reliability.json"), JSON.stringify({ limits: { maxToolCallsPerTurn: 7 } }));
  const config = loadConfig(root);
  assert.equal(config.limits.maxToolCallsPerTurn, 7);
  assert.equal(config.limits.maxHighRiskCallsPerTurn, 3);
  assert.equal(config.trace.maxFiles, 3);
});

test("rejects unsafe or nonsensical reliability settings", (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, ".pi", "reliability.json"), JSON.stringify({ traceDir: "../outside" }));
  assert.throws(() => loadConfig(root), /must stay inside the workspace/);
  fs.writeFileSync(path.join(root, ".pi", "reliability.json"), JSON.stringify({ limits: { maxToolCallsPerTurn: -1 } }));
  assert.throws(() => loadConfig(root), /maxToolCallsPerTurn/);
});

test("rejects invalid memory bounds and external roots", (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, ".pi", "memory.json"), JSON.stringify({ recallLimit: 0 }));
  assert.throws(() => loadMemoryConfig(root), /recallLimit/);
  fs.writeFileSync(path.join(root, ".pi", "memory.json"), JSON.stringify({ rootDir: "../shared-memory" }));
  assert.throws(() => loadMemoryConfig(root), /must stay inside the workspace/);
});

test("validates optional advisor configuration", (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    advisor: { enabled: true, provider: "openai", model: "reviewer", mode: "recommend", triggers: ["high_risk_tool"], complexPlanStepThreshold: 2 }
  }));
  const config = loadEquaxisConfig(root);
  assert.equal(config.advisor.enabled, true);
  assert.equal(config.advisor.model, "reviewer");
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({ schemaVersion: 1, advisor: { mode: "execute" } }));
  assert.throws(() => loadEquaxisConfig(root), /advisor.mode/);
});

test("uses the unified config as the source of truth", (t) => {
  const root = workspace(t);
  const externalRoot = path.resolve(root, "..", "approved-external");
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    reliability: {
      approval: {
        externalEditPolicy: "auto",
        externalEditRoots: [externalRoot]
      }
    },
    memory: { enabled: false }
  }));
  const config = loadEquaxisConfig(root);
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.reliability.approval.externalEditPolicy, "auto");
  assert.deepEqual(config.reliability.approval.externalEditRoots, [externalRoot]);
  assert.equal(config.memory.enabled, false);
  assert.equal(loadConfig(root).approval.externalEditPolicy, "auto");
});

test("requires explicit roots for automatic external approval", (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    reliability: { approval: { externalEditPolicy: "auto", externalEditRoots: [] } }
  }));
  assert.throws(() => loadEquaxisConfig(root), /must not be empty/);
});

test("merges and validates subagent runtime configuration", (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    subagents: {
      maxConcurrent: 4,
      budgets: { timeoutMs: 30000, maxRetries: 2 },
      isolation: { outputRoot: ".pi/agents" }
    }
  }));
  const config = loadEquaxisConfig(root);
  assert.equal(config.subagents.maxConcurrent, 4);
  assert.equal(config.subagents.budgets.timeoutMs, 30000);
  assert.equal(config.subagents.budgets.maxRetries, 2);
  assert.equal(config.subagents.isolation.enabled, true);
  assert.equal(config.subagents.isolation.scrubEnv, true);
  assert.equal(config.subagents.isolation.outputRoot, ".pi/agents");

  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    subagents: { isolation: { outputRoot: "../outside" } }
  }));
  assert.throws(() => loadEquaxisConfig(root), /subagents\.isolation\.outputRoot.*workspace/);

  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    subagents: { budgets: { timeoutMs: 50 } }
  }));
  assert.throws(() => loadEquaxisConfig(root), /subagents\.budgets\.timeoutMs/);

  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    subagents: { budgets: { maxRetries: 9 } }
  }));
  assert.throws(() => loadEquaxisConfig(root), /subagents\.budgets\.maxRetries/);
});

test("merges and validates protocol adapter configuration", (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    protocols: { lsp: { command: "typescript-language-server", args: ["--stdio"], requestTimeoutMs: 30000 } }
  }));
  const config = loadEquaxisConfig(root);
  assert.equal(config.protocols.lsp.command, "typescript-language-server");
  assert.deepEqual(config.protocols.lsp.args, ["--stdio"]);
  assert.equal(config.protocols.lsp.requestTimeoutMs, 30000);
  assert.equal(config.protocols.lsp.allowCommandOverride, false);
  assert.equal(config.protocols.dap.requestTimeoutMs, 15000);

  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    protocols: { dap: { cwd: "../outside" } }
  }));
  assert.throws(() => loadEquaxisConfig(root), /protocols\.dap\.cwd.*workspace/);

  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    protocols: { lsp: { requestTimeoutMs: 10 } }
  }));
  assert.throws(() => loadEquaxisConfig(root), /protocols\.lsp\.requestTimeoutMs/);
});
