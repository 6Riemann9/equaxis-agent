#!/usr/bin/env node

/**
 * Layered Equaxis settings editor: view / set / unset values across the
 * defaults → global (~/.equaxis/config.json) → project (.pi/equaxis.json)
 * layers, with full schema validation on write.
 *
 * Usage:
 *   node scripts/config-edit.mjs view [--cwd <dir>]
 *   node scripts/config-edit.mjs set --layer project|global --key <dot.path> --value <json> [--cwd <dir>]
 *   node scripts/config-edit.mjs unset --layer project|global --key <dot.path> [--cwd <dir>]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EQUAXIS_CONFIG,
  globalEquaxisConfigPath,
  loadEquaxisConfigLayers,
  mergeConfig,
  migrateEquaxisConfig,
  validateEquaxisConfig
} from "../src/equaxis-config.mjs";
import { CONFIG_SECTIONS, setAtPath } from "../src/config-sections.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(args, name) {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : undefined;
}

function writeLayerFile(filePath, layer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(layer, null, 2)}\n`, "utf8");
}

function view(cwd) {
  const layers = loadEquaxisConfigLayers(cwd);
  const settingsPath = path.join(cwd, ".pi", "settings.json");
  let piSettings = {};
  try {
    piSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    // no project settings yet
  }
  process.stdout.write(JSON.stringify({
    sections: CONFIG_SECTIONS.map((section) => ({
      ...section,
      keys: section.keys.map((key) => ({
        ...key,
        // Per-key layer file: logical sections can mix equaxis.json keys
        // with .pi/settings.json keys, so consumers must look at the key's
        // own file, never the section's.
        file: key.file ?? section.file,
        // Full dot-path into the layer object: logical-section keys already
        // carry it ("runtime.profile"); legacy section-scoped keys ("enabled")
        // are prefixed with the section id. settings.json keys stay bare
        // (they live at the top level of .pi/settings.json). Consumers must
        // use `path`, never re-derive it from section.id.
        path: key.path ?? (key.file === "settings" ? key.key : (key.key.includes(".") ? key.key : `${section.id}.${key.key}`))
      }))
    })),
    layers: {
      defaults: layers.defaults,
      global: layers.global,
      project: layers.project
    },
    effective: layers.effective,
    piSettings,
    paths: { global: layers.globalPath, project: layers.projectPath },
    schemaVersion: layers.effective.schemaVersion
  }, null, 2));
}

function edit(cwd, action, args) {
  const layerName = argValue(args, "--layer");
  if (layerName !== "project" && layerName !== "global") {
    throw new Error("--layer must be project or global");
  }
  const key = argValue(args, "--key");
  if (!key) throw new Error("--key is required (dot path, e.g. memory.recallLimit)");

  const layers = loadEquaxisConfigLayers(cwd);
  const filePath = layerName === "project" ? layers.projectPath : layers.globalPath;
  const current = layerName === "project" ? layers.project : layers.global;
  const next = action === "unset"
    ? setAtPath(current, key, undefined)
    : setAtPath(current, key, JSON.parse(argValue(args, "--value") ?? "undefined"));

  // Validate the edited layer on its own (merged with the bundled defaults)
  // BEFORE writing — a value masked by another layer must still be rejected.
  const candidate = mergeConfig(DEFAULT_EQUAXIS_CONFIG, migrateEquaxisConfig(next ?? {}, filePath) ?? {});
  validateEquaxisConfig(candidate, filePath);
  writeLayerFile(filePath, next);

  process.stdout.write(JSON.stringify({
    ok: true,
    layer: layerName,
    key,
    file: filePath
  }, null, 2));
}

const args = process.argv.slice(2);
const action = args[0];
const cwd = path.resolve(argValue(args, "--cwd") ?? process.cwd());

try {
  if (action === "view") {
    view(cwd);
  } else if (action === "set" || action === "unset") {
    edit(cwd, action, args);
  } else {
    throw new Error("Usage: config-edit.mjs view|set|unset [--cwd <dir>] [--layer project|global] [--key dot.path] [--value json]");
  }
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(1);
}
