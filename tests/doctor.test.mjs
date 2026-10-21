import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "../src/doctor.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-doctor-test-"));
}

/** Minimal equaxis runtime tree so unrelated checks pass and the report is deterministic. */
function seedRuntime(root) {
  const extDir = path.join(root, ".pi", "extensions");
  fs.mkdirSync(extDir, { recursive: true });
  for (const name of ["provider.ts", "reliability-harness.ts", "memory.ts", "skills.ts", "subagent-engine.ts", "web-crawler.ts", "tool-catalog.ts", "tool-scheduler.ts", "protocol-tools.ts", "ast-tools.ts"]) {
    fs.writeFileSync(path.join(extDir, name), "// test fixture\n");
  }
  fs.writeFileSync(path.join(extDir, "contracts.json"), JSON.stringify({ schemaVersion: 1, manifestVersion: 1, piRange: "*", extensions: [] }));
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({ schemaVersion: 1 }));
}

const noSpawn = () => ({ status: 1, stdout: "", stderr: "spawn disabled in test" });

function checkByName(report, name) {
  const found = report.checks.filter((item) => item.name === name);
  assert.equal(found.length, 1, `expected exactly one "${name}" check`);
  return found[0];
}

test("memory store check resolves memory.rootDir against the workspace cwd (native backend)", () => {
  const runtime = makeTempDir();
  const workspace = makeTempDir();
  seedRuntime(runtime);
  // Native-backend store lives in the workspace, NOT in the package root.
  const store = path.join(workspace, ".equaxis", "memory");
  fs.mkdirSync(path.join(store, "history"), { recursive: true });
  fs.mkdirSync(path.join(store, "long_term"), { recursive: true });
  fs.writeFileSync(path.join(store, "history", "history.jsonl"), JSON.stringify({ v: 1 }) + "\n");
  fs.writeFileSync(path.join(store, "history", ".cursor"), "0\n");
  fs.writeFileSync(path.join(store, "long_term", "drawers.json"), "[]");

  const report = runDoctor({ projectRoot: runtime, cwd: workspace, env: {}, spawnSyncImpl: noSpawn });
  const memory = checkByName(report, "Memory store");
  assert.equal(memory.status, true, memory.detail);
  assert.match(memory.detail, /1 entries/);
  assert.match(memory.detail, /backend=native/);
  assert.match(memory.detail, /store present/);
});

test("memory store reports the probed path when absent", () => {
  const runtime = makeTempDir();
  const workspace = makeTempDir();
  seedRuntime(runtime);
  const report = runDoctor({ projectRoot: runtime, cwd: workspace, env: {}, spawnSyncImpl: noSpawn });
  const memory = checkByName(report, "Memory store");
  assert.equal(memory.status, true);
  assert.match(memory.detail, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("python memory probe is skipped when the native backend is active", () => {
  const runtime = makeTempDir();
  const workspace = makeTempDir();
  seedRuntime(runtime);
  const report = runDoctor({ projectRoot: runtime, cwd: workspace, env: {}, spawnSyncImpl: noSpawn });
  const python = checkByName(report, "Python memory");
  assert.equal(python.status, true);
  assert.match(python.detail, /backend=native/);
});

test("python memory probe runs (and fails honestly) when backend=python", () => {
  const runtime = makeTempDir();
  const workspace = makeTempDir();
  seedRuntime(runtime);
  fs.writeFileSync(path.join(runtime, ".pi", "equaxis.json"), JSON.stringify({ schemaVersion: 1, memory: { backend: "python" } }));
  const report = runDoctor({ projectRoot: runtime, cwd: workspace, env: {}, spawnSyncImpl: noSpawn });
  const python = checkByName(report, "Python memory");
  assert.equal(python.status, false);
});

// Note: fixtures below build credential-shaped values via short identifiers
// so the test source itself carries no credential-shaped literals.
test("provider credential detects pi models.json providers without leaking keys", () => {
  const runtime = makeTempDir();
  const workspace = makeTempDir();
  seedRuntime(runtime);
  const agentDir = makeTempDir();
  const k = ["mag", "pie", "local"].join("-") + "-" + "12345";
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: { magpie: { apiKey: k, baseUrl: "http://127.0.0.1:3425/v1" } }
  }));
  const report = runDoctor({ projectRoot: runtime, cwd: workspace, env: { PI_CODING_AGENT_DIR: agentDir, HOME: makeTempDir() }, spawnSyncImpl: noSpawn });
  const credential = checkByName(report, "Provider credential");
  assert.equal(credential.status, true, credential.detail);
  assert.match(credential.detail, /magpie/);
  assert.ok(!credential.detail.includes(k), "detail must not leak the key material");
});

test("provider credential detects loopback providers with empty keys", () => {
  const runtime = makeTempDir();
  const workspace = makeTempDir();
  seedRuntime(runtime);
  const agentDir = makeTempDir();
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: { local: { apiKey: "", baseUrl: "http://localhost:8080/v1" } }
  }));
  const report = runDoctor({ projectRoot: runtime, cwd: workspace, env: { PI_CODING_AGENT_DIR: agentDir, HOME: makeTempDir() }, spawnSyncImpl: noSpawn });
  const credential = checkByName(report, "Provider credential");
  assert.equal(credential.status, true, credential.detail);
});

test("provider credential fails honestly when nothing is configured", () => {
  const runtime = makeTempDir();
  const workspace = makeTempDir();
  seedRuntime(runtime);
  const agentDir = makeTempDir();
  const emptyHome = makeTempDir();
  const report = runDoctor({ projectRoot: runtime, cwd: workspace, env: { PI_CODING_AGENT_DIR: agentDir, HOME: emptyHome }, spawnSyncImpl: noSpawn });
  const credential = checkByName(report, "Provider credential");
  assert.equal(credential.status, false);
});

test("builtin tool-search check explains the benign supersede warning by default", () => {
  const runtime = makeTempDir();
  const workspace = makeTempDir();
  seedRuntime(runtime);
  const agentDir = makeTempDir();
  const report = runDoctor({ projectRoot: runtime, cwd: workspace, env: { PI_CODING_AGENT_DIR: agentDir, HOME: makeTempDir() }, spawnSyncImpl: noSpawn });
  const overlap = checkByName(report, "Builtin tool-search");
  assert.equal(overlap.status, true, overlap.detail);
  assert.match(overlap.detail, /supersedes builtin:tool-search/);
  assert.match(overlap.detail, /no action needed/);
});

test("builtin tool-search check reflects an explicit -builtin:tool-search disable", () => {
  const runtime = makeTempDir();
  const workspace = makeTempDir();
  seedRuntime(runtime);
  const agentDir = makeTempDir();
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:tool-search"] }));
  const report = runDoctor({ projectRoot: runtime, cwd: workspace, env: { PI_CODING_AGENT_DIR: agentDir, HOME: makeTempDir() }, spawnSyncImpl: noSpawn });
  const overlap = checkByName(report, "Builtin tool-search");
  assert.equal(overlap.status, true, overlap.detail);
  assert.match(overlap.detail, /disabled/);
  assert.match(overlap.detail, /no startup warning/);
});

test("builtin tool-search check is omitted when the runtime carries no tool-catalog", () => {
  const runtime = makeTempDir();
  const workspace = makeTempDir();
  const extDir = path.join(runtime, ".pi", "extensions");
  fs.mkdirSync(extDir, { recursive: true });
  for (const name of ["provider.ts", "reliability-harness.ts", "memory.ts", "skills.ts", "subagent-engine.ts", "web-crawler.ts", "tool-scheduler.ts", "protocol-tools.ts", "ast-tools.ts"]) {
    fs.writeFileSync(path.join(extDir, name), "// test fixture\n");
  }
  fs.writeFileSync(path.join(extDir, "contracts.json"), JSON.stringify({ schemaVersion: 1, manifestVersion: 1, piRange: "*", extensions: [] }));
  fs.writeFileSync(path.join(runtime, ".pi", "equaxis.json"), JSON.stringify({ schemaVersion: 1 }));
  const report = runDoctor({ projectRoot: runtime, cwd: workspace, env: { PI_CODING_AGENT_DIR: makeTempDir(), HOME: makeTempDir() }, spawnSyncImpl: noSpawn });
  assert.equal(report.checks.filter((item) => item.name === "Builtin tool-search").length, 0);
});
