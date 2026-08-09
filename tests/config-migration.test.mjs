import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runConfigMigration } from "../src/config-migration.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-config-migrate-"));
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeLegacyConfig(root) {
  const file = path.join(root, ".pi", "equaxis.json");
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 0,
    runtimeProfile: "full",
    evaluation: { eventDir: ".pi/legacy-eval", costRegressionLimit: 0.25 },
    subagents: { timeoutMs: 30000, stateDir: ".pi/legacy-subagents" }
  }, null, 2));
  return file;
}

test("previews a legacy config migration without writing", (t) => {
  const root = workspace(t);
  const file = writeLegacyConfig(root);
  const before = fs.readFileSync(file, "utf8");
  const report = runConfigMigration({ projectRoot: root, dryRun: true });
  assert.equal(report.ok, true);
  assert.equal(report.written, false);
  assert.equal(report.changed, true);
  assert.equal(report.config.schemaVersion, 1);
  assert.equal(report.config.runtime.profile, "full");
  assert.equal(report.config.evaluation.rootDir, ".pi/legacy-eval");
  assert.equal(report.config.evaluation.maxCostRegression, 0.25);
  assert.equal(report.config.subagents.budgets.timeoutMs, 30000);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("writes the migrated current schema when requested", (t) => {
  const root = workspace(t);
  const file = writeLegacyConfig(root);
  const report = runConfigMigration({ projectRoot: root, dryRun: false });
  assert.equal(report.ok, true);
  assert.equal(report.written, true);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.schemaVersion, 1);
  assert.equal(written.runtime.profile, "full");
  assert.equal(written.evaluation.rootDir, ".pi/legacy-eval");
  assert.equal(written.evaluation.eventDir, undefined);
  assert.equal(written.subagents.persistence.rootDir, ".pi/legacy-subagents");
});
