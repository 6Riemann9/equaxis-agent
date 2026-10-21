/**
 * Feature model slots: one CLI surface (`equaxis model …`) for every place
 * Equaxis consumes an LLM, with validation against the local model catalog
 * and automatic fallback to the main model at use time.
 *
 * Slots:
 *   main    — the session's default model (project .pi/settings.json,
 *             defaultProvider/defaultModel); no fallback (it IS the fallback)
 *   dream   — memory dream consolidation (memory.dream.provider/model);
 *             falls back to the session model when unavailable
 *   advisor — recommendation advisor (advisor.provider/model); same fallback
 *
 * The catalog is the bundled pi-ai providers (dist/providers/data/*.json,
 * e.g. anthropic, deepseek) overlaid by the user's own
 * ~/.pi/agent/models.json (custom providers, shape
 * { providers: { name: { models: [...] } } }) and models-store.json (shape
 * { name: { models: [...] } }). When pi-ai is not resolvable from this
 * package, validation degrades to the user catalog and unknown providers
 * are accepted with an "unverified" flag instead of being blocked.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setAtPath } from "./config-sections.mjs";
import {
  DEFAULT_EQUAXIS_CONFIG,
  mergeConfig,
  migrateEquaxisConfig,
  validateEquaxisConfig
} from "./equaxis-config.mjs";

export const MODEL_SLOTS = [
  {
    id: "main",
    label: "Main model (session default)",
    file: "pi-settings",
    description: "The default model every session starts on; other slots fall back to it",
    providerKey: "defaultProvider",
    modelKey: "defaultModel",
    fallback: "none"
  },
  {
    id: "dream",
    label: "Dream consolidation",
    file: "equaxis",
    description: "Extracts durable memories from session history (memory.dream)",
    providerKey: "memory.dream.provider",
    modelKey: "memory.dream.model",
    fallback: "session"
  },
  {
    id: "advisor",
    label: "Advisor",
    file: "equaxis",
    description: "Recommendation advisor for high-risk decisions (advisor)",
    providerKey: "advisor.provider",
    modelKey: "advisor.model",
    fallback: "session"
  }
];

export function getSlot(id) {
  return MODEL_SLOTS.find((slot) => slot.id === id) ?? null;
}

/** Read one provider entry from either user-catalog shape. */
function providerModels(entry) {
  const models = entry?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((model) => ({ id: String(model?.id ?? ""), name: typeof model?.name === "string" ? model.name : null }))
    .filter((model) => model.id);
}

/**
 * Locate pi-ai's bundled provider data by walking up from this file:
 * node_modules/@earendil-works/pi-ai/... (hoisted) or the copy nested under
 * pi-coding-agent. require.resolve cannot be used — pi-ai's package.json
 * `exports` field does not expose ./package.json or ./dist/*.
 */
function findPiaiDataDir() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  const suffixes = [
    path.join("node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"),
    path.join("node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data")
  ];
  while (true) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, suffix);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The bundled pi-ai catalog: dist/providers/data/<provider>.json, each shaped
 * { [api]: { [modelId]: { id, … } } }. Returns an empty Map when pi-ai is
 * not resolvable from this package.
 */
export function loadBuiltinCatalog() {
  const catalog = new Map();
  const dataDir = findPiaiDataDir();
  if (!dataDir) return catalog;
  let files = [];
  try {
    files = fs.readdirSync(dataDir).filter((file) => file.endsWith(".json"));
  } catch {
    return catalog;
  }
  for (const file of files) {
    const provider = path.basename(file, ".json");
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));
    } catch {
      continue;
    }
    const models = new Map();
    for (const apiEntry of Object.values(parsed ?? {})) {
      if (typeof apiEntry !== "object" || apiEntry === null) continue;
      for (const [key, value] of Object.entries(apiEntry)) {
        if (typeof value === "object" && value !== null && value.id === key) {
          models.set(key, { name: typeof value.name === "string" ? value.name : null });
        }
      }
    }
    if (models.size) catalog.set(provider, models);
  }
  return catalog;
}

/**
 * The user's own providers (custom gateways etc.): Map<provider, Map<modelId, {name}>>
 * from ~/.pi/agent/models.json and models-store.json. `homeDir` defaults to
 * os.homedir(); tests pass a fixture dir.
 */
export function loadUserCatalog(homeDir = os.homedir()) {
  const catalog = new Map();
  const files = [
    path.join(homeDir, ".pi", "agent", "models.json"),
    path.join(homeDir, ".pi", "agent", "models-store.json")
  ];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    // models.json: { providers: { ... } }; models-store.json: { ... } direct.
    const providers = parsed?.providers ?? parsed ?? {};
    if (typeof providers !== "object" || providers === null) continue;
    for (const [name, entry] of Object.entries(providers)) {
      if (typeof entry !== "object" || entry === null) continue;
      if (!catalog.has(name)) catalog.set(name, new Map());
      for (const model of providerModels(entry)) catalog.get(name).set(model.id, model);
    }
  }
  return catalog;
}

/** The full catalog: bundled pi-ai providers overlaid by the user's own. */
export function loadModelCatalog(homeDir = os.homedir()) {
  const catalog = loadBuiltinCatalog();
  for (const [provider, models] of loadUserCatalog(homeDir)) {
    catalog.set(provider, models);
  }
  return catalog;
}

/**
 * Credential probe for a provider: a key in ~/.pi/agent/auth.json or an
 * inline `apiKey` on the user's models.json provider entry. Environment
 * variables (e.g. DEEPSEEK_API_KEY) are not visible offline - a negative
 * result means "no local key found", never "cannot work".
 */
export function hasCredentials(provider, homeDir = os.homedir()) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(homeDir, ".pi", "agent", "auth.json"), "utf8"));
    if (auth && typeof auth === "object" && provider in auth) {
      return { ok: true, source: "auth.json" };
    }
  } catch {
    // no auth file
  }
  try {
    const models = JSON.parse(fs.readFileSync(path.join(homeDir, ".pi", "agent", "models.json"), "utf8"));
    const entry = models?.providers?.[provider];
    if (entry && typeof entry.apiKey === "string" && entry.apiKey) {
      return { ok: true, source: "models.json" };
    }
  } catch {
    // no models file
  }
  return { ok: false, source: null };
}

/** Model rows (id + display name) for one provider, sorted by id. */
export function describeProviderModels(catalog, provider) {
  const models = catalog.get(provider);
  if (!models) return null;
  return [...models.entries()]
    .map(([id, info]) => ({ id, name: info?.name ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Validate a provider/model pair against the catalog.
 * Returns { ok, known }: `ok` is true only when the pair exists in the
 * catalog. When pi-ai's bundled catalog is unavailable (stripped install)
 * and the provider is not user-defined, accept with `unverified: true`
 * instead of blocking — validation degrades, it never breaks setup.
 */
export function validateModelRef(catalog, provider, model, { builtinAvailable = true } = {}) {
  if (!provider || !model) {
    return { ok: false, known: false, error: "provider and model are both required" };
  }
  const models = catalog.get(provider);
  if (models) {
    if (models.has(model)) return { ok: true, known: true };
    return {
      ok: false,
      known: false,
      error: `provider "${provider}" exists but has no model "${model}" (available: ${[...models.keys()].slice(0, 8).join(", ")}${models.size > 8 ? ", …" : ""})`
    };
  }
  if (builtinAvailable) {
    return {
      ok: false,
      known: false,
      error: `unknown provider "${provider}" (known providers include: ${[...catalog.keys()].slice(0, 8).join(", ")}${catalog.size > 8 ? ", …" : ""})`
    };
  }
  return { ok: true, known: false, unverified: true };
}

/**
 * Resolve every slot against the merged config + project Pi settings.
 * `effective` is loadEquaxisConfigLayers(cwd).effective; `piSettings` is the
 * parsed project .pi/settings.json ({} when absent).
 */
export function listModelSlots({ effective, piSettings, catalog }) {
  const builtinAvailable = catalog.size > 0;
  return MODEL_SLOTS.map((slot) => {
    const source = slot.file === "pi-settings" ? (piSettings ?? {}) : (effective ?? {});
    const provider = readPath(source, slot.providerKey);
    const model = readPath(source, slot.modelKey);
    const configured = Boolean(provider && model);
    const validation = configured
      ? validateModelRef(catalog, provider, model, { builtinAvailable })
      : { ok: true, known: false };
    return {
      slot: slot.id,
      label: slot.label,
      fallback: slot.fallback === "session" ? "main/session model" : "none",
      configured,
      provider: provider ?? null,
      model: model ?? null,
      resolved: configured ? `${provider}/${model}` : null,
      known: Boolean(validation.known),
      unverified: Boolean(validation.unverified),
      error: validation.error ?? null
    };
  });
}

function readPath(object, dotPath) {
  let current = object;
  for (const part of dotPath.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = current[part];
  }
  return current === undefined ? undefined : current;
}

function writeLayerFile(filePath, layer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(layer, null, 2)}\n`, "utf8");
}

/**
 * Apply (or clear) a slot value. `layers` is loadEquaxisConfigLayers(cwd)
 * output; writes only the owning layer file.
 *   applyModelSlot({ slotId: "dream", provider, model, cwd, layers })
 *   applyModelSlot({ slotId: "dream", clear: true, cwd, layers })
 */
export function applyModelSlot({ slotId, provider, model, clear = false, cwd, layers, homeDir = os.homedir() }) {
  const slot = getSlot(slotId);
  if (!slot) {
    throw new Error(`unknown model slot "${slotId}" (available: ${MODEL_SLOTS.map((s) => s.id).join(", ")})`);
  }
  const catalog = loadModelCatalog(homeDir);
  const builtinAvailable = catalog.size > 0;
  if (!clear) {
    const validation = validateModelRef(catalog, provider, model, { builtinAvailable });
    if (!validation.ok) throw new Error(validation.error);
  }

  if (slot.file === "pi-settings") {
    const settingsPath = path.join(cwd, ".pi", "settings.json");
    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      // no project settings yet
    }
    let next = setAtPath(settings, slot.providerKey, clear ? undefined : provider);
    next = setAtPath(next, slot.modelKey, clear ? undefined : model);
    writeLayerFile(settingsPath, next);
    return { slot: slotId, file: settingsPath, provider: clear ? null : provider, model: clear ? null : model };
  }

  // equaxis.json slot: write the project layer with the same schema
  // discipline config-edit.mjs uses.
  const filePath = layers.projectPath;
  const current = layers.project ?? {};
  let next = setAtPath(current, slot.providerKey, clear ? undefined : provider);
  next = setAtPath(next, slot.modelKey, clear ? undefined : model);
  const candidate = mergeConfig(DEFAULT_EQUAXIS_CONFIG, migrateEquaxisConfig(next ?? {}, filePath) ?? {});
  validateEquaxisConfig(candidate, filePath);
  writeLayerFile(filePath, next);
  return {
    slot: slotId,
    file: filePath,
    provider: clear ? null : provider,
    model: clear ? null : model,
    unverified: clear ? false : Boolean(validateModelRef(catalog, provider, model, { builtinAvailable }).unverified)
  };
}

/**
 * Resolve a teammate's `model` setting into Pi CLI args.
 *
 * Accepts "provider/model" (unambiguous) or a bare model id that exactly one
 * provider offers. An unknown or ambiguous value is refused with the closest
 * matches instead of silently falling back to the session model — a teammate
 * that runs a different model than the one configured is worse than one that
 * fails and says why.
 */
export function teammateModelArgs(model, catalog = loadModelCatalog()) {
  if (!model) return { args: [], provider: null, model: null };
  const value = String(model).trim();
  if (!value) return { args: [], provider: null, model: null };

  const slash = value.indexOf("/");
  if (slash > 0) {
    const provider = value.slice(0, slash);
    const modelId = value.slice(slash + 1);
    if (!provider || !modelId) throw new Error(`teammate model "${value}" must look like provider/model`);
    const validation = validateModelRef(catalog, provider, modelId, { builtinAvailable: catalog.size > 0 });
    if (!validation.ok) throw new Error(validation.error);
    return { args: ["--provider", provider, "--model", modelId], provider, model: modelId };
  }

  const owners = [...catalog.entries()].filter(([, models]) => models.has(value)).map(([provider]) => provider);
  if (owners.length === 1) {
    return { args: ["--provider", owners[0], "--model", value], provider: owners[0], model: value };
  }
  if (owners.length > 1) {
    throw new Error(`teammate model "${value}" is ambiguous (${owners.join(", ")}) — set it as <provider>/<model>`);
  }

  // Suggest the closest ids so the fix is a copy-paste, not a hunt.
  const needle = value.toLowerCase();
  const suggestions = [];
  for (const [provider, models] of catalog) {
    for (const id of models.keys()) {
      if (id.toLowerCase().includes(needle) || needle.includes(id.toLowerCase())) suggestions.push(`${provider}/${id}`);
      if (suggestions.length >= 5) break;
    }
    if (suggestions.length >= 5) break;
  }
  throw new Error(
    `teammate model "${value}" is not in the model catalog` +
    (suggestions.length ? ` — did you mean: ${suggestions.join(", ")}?` : " — run: equaxis model catalog")
  );
}
