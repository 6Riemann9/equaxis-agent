import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasRuntimeMarkers, resolveRuntimeRoot, ownPackageRoot } from "../src/runtime-root.mjs";
import { loadEquaxisConfigLayers } from "../src/equaxis-config.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-root-test-"));
}

test("hasRuntimeMarkers distinguishes runtime roots from data-only roots", () => {
  const dataOnly = makeTempDir();
  fs.mkdirSync(path.join(dataOnly, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(dataOnly, ".pi", "equaxis.json"), '{"schemaVersion":1}');
  assert.equal(hasRuntimeMarkers(dataOnly), false);

  const runtime = makeTempDir();
  fs.mkdirSync(path.join(runtime, ".pi", "extensions"), { recursive: true });
  fs.writeFileSync(path.join(runtime, ".pi", "extensions", "contracts.json"), "{}");
  assert.equal(hasRuntimeMarkers(runtime), true);
});

test("resolveRuntimeRoot borrows the package runtime for data-only roots", () => {
  const dataOnly = makeTempDir();
  const pkg = makeTempDir();
  fs.mkdirSync(path.join(pkg, ".pi", "extensions"), { recursive: true });
  fs.writeFileSync(path.join(pkg, ".pi", "extensions", "contracts.json"), "{}");
  assert.equal(resolveRuntimeRoot(dataOnly, pkg), pkg);
  assert.equal(resolveRuntimeRoot(pkg, pkg), pkg);
});

test("bundled package config sits between defaults and project layers", () => {
  // This repo IS a package with .pi/equaxis.json (profile=full); a data-only
  // workspace must still see bundled installation defaults.
  const dataOnly = makeTempDir();
  fs.mkdirSync(path.join(dataOnly, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(dataOnly, ".pi", "equaxis.json"), JSON.stringify({ schemaVersion: 1 }));
  const layers = loadEquaxisConfigLayers(dataOnly);
  assert.equal(layers.effective.runtime.profile, "full");
  assert.equal(layers.bundled?.runtime?.profile, "full");
  // code defaults remain visible as their own layer
  assert.equal(layers.defaults.runtime.profile, "standard");
});

test("project layer overrides bundled and global layers", () => {
  const dataOnly = makeTempDir();
  fs.mkdirSync(path.join(dataOnly, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(dataOnly, ".pi", "equaxis.json"), JSON.stringify({
    schemaVersion: 1,
    runtime: { profile: "standard" },
    memory: { recallLimit: 9 }
  }));
  const layers = loadEquaxisConfigLayers(dataOnly);
  assert.equal(layers.effective.runtime.profile, "standard");
  assert.equal(layers.effective.memory.recallLimit, 9);
});

test("ownPackageRoot resolves the package containing the runtime modules", () => {
  const pkgRoot = ownPackageRoot(import.meta.url);
  assert.equal(path.basename(pkgRoot), "src"); // tests run from the package dir named src in dev
});
