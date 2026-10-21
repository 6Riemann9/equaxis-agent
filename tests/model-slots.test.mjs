import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadEquaxisConfigLayers } from "../src/equaxis-config.mjs";
import {
  MODEL_SLOTS,
  applyModelSlot,
  describeProviderModels,
  getSlot,
  hasCredentials,
  listModelSlots,
  loadBuiltinCatalog,
  loadModelCatalog,
  loadUserCatalog,
  validateModelRef
} from "../src/model-slots.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "model-slots-"));
}

/** A fixture HOME with a custom provider catalog, like the real machine's
 * magpie gateway (loopback OpenAI-compatible endpoint). */
function fixtureHome() {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".pi", "agent", "models.json"),
    JSON.stringify({
      providers: {
        magpie: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:3425/v1",
          models: [{ id: "deepworks/DeepSeek-V4-Flash" }, { id: "deepworks/Kimi-K3" }]
        }
      }
    }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(home, ".pi", "agent", "models-store.json"),
    JSON.stringify({
      "opencode-go": { models: [{ id: "beam-free" }] }
    }, null, 2),
    "utf8"
  );
  return home;
}

function fixtureProject(dream = { provider: "deepseek", model: "deepseek-v4-flash" }) {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".pi", "equaxis.json"),
    JSON.stringify({ schemaVersion: 1, memory: { dream } }, null, 2),
    "utf8"
  );
  return root;
}

// ---- catalogs ----

test("user catalog: merges models.json (providers wrapper) and models-store.json (direct)", () => {
  const catalog = loadUserCatalog(fixtureHome());
  assert.equal(catalog.size, 2);
  assert.deepEqual([...catalog.get("magpie").keys()], ["deepworks/DeepSeek-V4-Flash", "deepworks/Kimi-K3"]);
  assert.deepEqual([...catalog.get("opencode-go").keys()], ["beam-free"]);
  assert.equal(catalog.get("magpie").get("deepworks/Kimi-K3").name, null);
});

test("user catalog: missing files yield an empty catalog, never a throw", () => {
  assert.equal(loadUserCatalog(tmpDir()).size, 0);
});

test("builtin catalog: pi-ai providers are loadable (deepseek/deepseek-v4-flash is a real model)", () => {
  const catalog = loadBuiltinCatalog();
  if (catalog.size === 0) {
    // Stripped install without a resolvable pi-ai — the documented degrade path.
    return;
  }
  assert.ok(catalog.has("deepseek"), "deepseek is a bundled pi-ai provider");
  assert.ok(catalog.has("anthropic"), "anthropic is a bundled pi-ai provider");
  assert.ok(catalog.get("deepseek").has("deepseek-v4-flash"));
});

test("full catalog: user providers overlay the bundled ones", () => {
  const catalog = loadModelCatalog(fixtureHome());
  assert.ok(catalog.has("magpie"), "custom provider present");
  if (loadBuiltinCatalog().size > 0) {
    assert.ok(catalog.has("deepseek"), "bundled provider still present");
    const pair = validateModelRef(catalog, "deepseek", "deepseek-v4-flash");
    assert.equal(pair.ok, true);
    assert.equal(pair.known, true);
  }
});

// ---- validation ----

test("validateModelRef: known pair ok; wrong model under known provider rejected with the list", () => {
  const catalog = loadModelCatalog(fixtureHome());
  assert.deepEqual(validateModelRef(catalog, "magpie", "deepworks/DeepSeek-V4-Flash"), { ok: true, known: true });

  const wrong = validateModelRef(catalog, "magpie", "deepseek-v4-flash");
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /provider "magpie" exists but has no model "deepseek-v4-flash"/);
  assert.match(wrong.error, /DeepSeek-V4-Flash/); // suggests what exists

  assert.equal(validateModelRef(catalog, "", "x").ok, false);
  assert.equal(validateModelRef(catalog, "magpie", "").ok, false);
});

test("validateModelRef: unknown providers are rejected when the builtin catalog is available", () => {
  const catalog = loadModelCatalog(fixtureHome());
  if (loadBuiltinCatalog().size === 0) return; // degrade path: skip
  const result = validateModelRef(catalog, "dreamai", "pro-1");
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown provider "dreamai"/);
});

test("validateModelRef: stripped installs accept unknown providers with an unverified flag", () => {
  const userOnly = loadUserCatalog(fixtureHome());
  const result = validateModelRef(userOnly, "anthropic", "claude-sonnet-4", { builtinAvailable: false });
  assert.deepEqual(result, { ok: true, known: false, unverified: true });
});

// ---- listing ----

test("listModelSlots: valid pair reports known; broken pair reports the error; fallback semantics per slot", () => {
  const home = fixtureHome();
  const root = fixtureProject(); // deepseek/deepseek-v4-flash — a real bundled pair
  const layers = loadEquaxisConfigLayers(root);
  const slots = listModelSlots({ effective: layers.effective, piSettings: {}, catalog: loadModelCatalog(home) });

  const dream = slots.find((s) => s.slot === "dream");
  assert.equal(dream.configured, true);
  assert.equal(dream.error, null);
  assert.equal(dream.fallback, "main/session model");
  if (loadBuiltinCatalog().size > 0) assert.equal(dream.known, true);

  const main = slots.find((s) => s.slot === "main");
  assert.equal(main.configured, false);
  assert.equal(main.fallback, "none");

  const advisor = slots.find((s) => s.slot === "advisor");
  assert.equal(advisor.configured, false);
  assert.equal(advisor.fallback, "main/session model");

  // A broken pair surfaces as an error, not a crash.
  const brokenRoot = fixtureProject({ provider: "ghost-provider", model: "nope" });
  const brokenLayers = loadEquaxisConfigLayers(brokenRoot);
  const brokenSlots = listModelSlots({ effective: brokenLayers.effective, piSettings: {}, catalog: loadModelCatalog(home) });
  const broken = brokenSlots.find((s) => s.slot === "dream");
  if (loadBuiltinCatalog().size > 0) {
    assert.equal(broken.error !== null, true);
    assert.match(broken.error, /unknown provider/);
  }
});

// ---- apply ----

test("applyModelSlot: set + unset round-trip writes the project layer and validates", () => {
  const home = fixtureHome();
  const root = fixtureProject();
  const layers = loadEquaxisConfigLayers(root);

  // Setting the correct pair replaces the previous one.
  const set = applyModelSlot({ slotId: "dream", provider: "magpie", model: "deepworks/DeepSeek-V4-Flash", cwd: root, layers, homeDir: home });
  assert.equal(path.resolve(set.file), path.join(root, ".pi", "equaxis.json"));
  const after = JSON.parse(fs.readFileSync(path.join(root, ".pi", "equaxis.json"), "utf8"));
  assert.equal(after.memory.dream.provider, "magpie");
  assert.equal(after.memory.dream.model, "deepworks/DeepSeek-V4-Flash");

  // A typo'd model under a known provider is rejected before any write.
  assert.throws(
    () => applyModelSlot({ slotId: "dream", provider: "magpie", model: "nope", cwd: root, layers, homeDir: home }),
    /no model "nope"/
  );
  const unchanged = JSON.parse(fs.readFileSync(path.join(root, ".pi", "equaxis.json"), "utf8"));
  assert.equal(unchanged.memory.dream.model, "deepworks/DeepSeek-V4-Flash");

  // Unset clears both keys (falls back to the session model at use time).
  applyModelSlot({ slotId: "dream", clear: true, cwd: root, layers, homeDir: home });
  const cleared = JSON.parse(fs.readFileSync(path.join(root, ".pi", "equaxis.json"), "utf8"));
  assert.equal(cleared.memory.dream.provider, undefined);
  assert.equal(cleared.memory.dream.model, undefined);
});

test("applyModelSlot: main writes .pi/settings.json defaultProvider/defaultModel", () => {
  const home = fixtureHome();
  const root = fixtureProject();
  const layers = loadEquaxisConfigLayers(root);

  applyModelSlot({ slotId: "main", provider: "magpie", model: "deepworks/Kimi-K3", cwd: root, layers, homeDir: home });
  const settings = JSON.parse(fs.readFileSync(path.join(root, ".pi", "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "magpie");
  assert.equal(settings.defaultModel, "deepworks/Kimi-K3");

  applyModelSlot({ slotId: "main", clear: true, cwd: root, layers, homeDir: home });
  const cleared = JSON.parse(fs.readFileSync(path.join(root, ".pi", "settings.json"), "utf8"));
  assert.equal(cleared.defaultProvider, undefined);
  assert.equal(cleared.defaultModel, undefined);
});

test("applyModelSlot: unknown slots are refused; every declared slot is resolvable", () => {
  const home = fixtureHome();
  const root = fixtureProject();
  const layers = loadEquaxisConfigLayers(root);
  assert.throws(() => applyModelSlot({ slotId: "ghost", provider: "a", model: "b", cwd: root, layers, homeDir: home }), /unknown model slot "ghost"/);
  assert.ok(MODEL_SLOTS.every((slot) => typeof getSlot(slot.id)?.id === "string"));
  assert.equal(getSlot("nope"), null);
});

// ---- catalog browsing (the "show me what I can pick" surface) ----

test("hasCredentials: auth.json entry, inline apiKey, and absence", () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".pi", "agent", "auth.json"),
    JSON.stringify({ "opencode-go": { type: "api_key", key: "x" } }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(home, ".pi", "agent", "models.json"),
    JSON.stringify({ providers: { magpie: { api: "openai-completions", apiKey: "inline", models: [] } } }, null, 2),
    "utf8"
  );
  assert.deepEqual(hasCredentials("opencode-go", home), { ok: true, source: "auth.json" });
  assert.deepEqual(hasCredentials("magpie", home), { ok: true, source: "models.json" });
  assert.deepEqual(hasCredentials("deepseek", home), { ok: false, source: null });
  // No files at all → clean negative, never a throw.
  assert.deepEqual(hasCredentials("anything", tmpDir()), { ok: false, source: null });
});

test("describeProviderModels: rows sorted by id with names; unknown provider is null", () => {
  const catalog = loadUserCatalog(fixtureHome());
  const rows = describeProviderModels(catalog, "magpie");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.id), ["deepworks/DeepSeek-V4-Flash", "deepworks/Kimi-K3"]);
  assert.ok(rows.every((r) => r.name === null));
  assert.equal(describeProviderModels(catalog, "nope"), null);

  // Builtin entries carry display names.
  const builtin = loadBuiltinCatalog();
  if (builtin.size > 0) {
    const deepseek = describeProviderModels(builtin, "deepseek");
    const flash = deepseek.find((m) => m.id === "deepseek-v4-flash");
    assert.equal(flash.name, "DeepSeek V4 Flash");
  }
});
