import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadEquaxisConfig, loadEquaxisConfigLayers } from "../src/equaxis-config.mjs";
import { getAtPath, setAtPath } from "../src/config-sections.mjs";

test("defaults → global → project merge order and provenance", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-layers-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-layers-home-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // os.homedir() reads USERPROFILE on Windows but $HOME on POSIX, and caches
  // its result for the process — both must be redirected (and the first
  // os.homedir() call in this process happens inside loadEquaxisConfigLayers,
  // i.e. after this mutation).
  const originalWinHome = process.env.USERPROFILE;
  const originalPosixHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;

  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  fs.mkdirSync(path.join(home, ".equaxis"), { recursive: true });
  fs.writeFileSync(path.join(home, ".equaxis", "config.json"), JSON.stringify({
    memory: { recallLimit: 7 },
    skills: { enabled: false }
  }), "utf8");
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    runtime: { profile: "standard", services: { config: true, diagnostics: true, trace: true, status: true } },
    extensions: { manifest: ".pi/extensions/contracts.json", enabled: [], disabled: [] },
    reliability: { mode: "audit", traceDir: ".pi/runtime" },
    memory: { enabled: true, pythonCommand: "python", rootDir: ".equaxis/memory", autoRecall: true, recallLimit: 9 }
  }), "utf8");

  try {
    const layers = loadEquaxisConfigLayers(root);
    // project wins over global wins over defaults
    assert.equal(layers.effective.memory.recallLimit, 9);
    assert.equal(getAtPath(layers.global, "memory.recallLimit"), 7);
    assert.equal(getAtPath(layers.project, "memory.recallLimit"), 9);
    assert.equal(getAtPath(layers.project, "skills.enabled"), undefined);
    assert.equal(layers.effective.skills.enabled, false); // global layer applied
    assert.equal(layers.effective.reliability.mode, "audit");
  } finally {
    if (originalWinHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalWinHome;
    if (originalPosixHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalPosixHome;
  }
});

test("setAtPath sets and deletes nested keys without mutating input", () => {
  const input = { memory: { recallLimit: 5 } };
  const updated = setAtPath(input, "memory.dream.enabled", false);
  assert.equal(input.memory.recallLimit, 5);
  assert.equal(input.memory.dream, undefined, "input is not mutated");
  assert.equal(updated.memory.dream.enabled, false);
  assert.equal(updated.memory.recallLimit, 5);

  const cleared = setAtPath(updated, "memory.dream", undefined);
  assert.equal("dream" in cleared.memory, false);
});

test("loadEquaxisConfig still returns the effective config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-layers-eff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    runtime: { profile: "minimal", services: { config: true, diagnostics: true, trace: true, status: true } },
    extensions: { manifest: ".pi/extensions/contracts.json", enabled: [], disabled: [] },
    reliability: { mode: "enforce", traceDir: ".pi/runtime" },
    memory: { enabled: false, pythonCommand: "python", rootDir: ".equaxis/memory" }
  }), "utf8");
  const config = loadEquaxisConfig(root);
  assert.equal(config.reliability.mode, "enforce");
  assert.equal(config.memory.enabled, false);
});

test("safety arrays union-merge instead of replacing defaults", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-layers-union-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    runtime: { profile: "standard" },
    extensions: { manifest: ".pi/extensions/contracts.json", enabled: [], disabled: [] },
    reliability: {
      protectPaths: [".env"],
      approval: { externalEditRoots: ["<workspace>"] },
      commandAllowlist: { extraCommands: ["equaxis"] }
    }
  }), "utf8");
  const config = loadEquaxisConfig(root);
  for (const entry of [".git/", "node_modules/", "*.pem", "*.key", ".env"]) {
    assert.ok(config.reliability.protectPaths.includes(entry), `default protectPath kept: ${entry}`);
  }
  assert.ok(config.reliability.approval.externalEditRoots.includes("<workspace>"), "custom externalEditRoot kept");
  assert.ok(config.reliability.commandAllowlist.extraCommands.includes("equaxis"), "custom extraCommand kept");
});

test("reliability.checkpoints is configurable and advisor.mode follows the validator", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-layers-cp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });

  // default: checkpoints enabled
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    runtime: { profile: "standard" },
    extensions: { manifest: ".pi/extensions/contracts.json", enabled: [], disabled: [] }
  }), "utf8");
  assert.equal(loadEquaxisConfig(root).reliability.checkpoints.enabled, true);

  // explicitly disabled is a legal key now (previously rejected as unknown)
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    runtime: { profile: "standard" },
    extensions: { manifest: ".pi/extensions/contracts.json", enabled: [], disabled: [] },
    reliability: { checkpoints: { enabled: false } },
    advisor: { mode: "block_on_negative" }
  }), "utf8");
  const config = loadEquaxisConfig(root);
  assert.equal(config.reliability.checkpoints.enabled, false, "checkpoints can be turned off");
  assert.equal(config.advisor.mode, "block_on_negative", "validator-accepted advisor mode loads");

  // the schema's old advisor.mode value ("review") must not load
  fs.writeFileSync(path.join(root, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    runtime: { profile: "standard" },
    extensions: { manifest: ".pi/extensions/contracts.json", enabled: [], disabled: [] },
    advisor: { mode: "review" }
  }), "utf8");
  assert.throws(() => loadEquaxisConfig(root), /advisor\.mode/);
});
