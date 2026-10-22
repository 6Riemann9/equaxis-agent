#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatDoctorReport, runDoctor, runStartupPreflight } from "../src/doctor.mjs";
import { loadEquaxisConfig, loadEquaxisConfigLayers } from "../src/equaxis-config.mjs";
import { applyModelSlot, describeProviderModels, hasCredentials, listModelSlots, loadModelCatalog } from "../src/model-slots.mjs";
import { compareCandidate, createEvalLoopFromTrace } from "../src/eval-loop.mjs";
import { exportEvalLoopForHarbor } from "../src/eval-harbor-bridge.mjs";
import { isRuntimeProfile, profileExtensionSelection } from "../src/runtime-profiles.mjs";
import { formatProtocolRegressionReport, runProtocolRegression } from "../src/protocol-regression.mjs";
import { VersionStore } from "../src/version-store.mjs";
import { buildRuntimeDashboard, formatRuntimeDashboard } from "../src/runtime-dashboard.mjs";
import { formatConfigMigrationReport, runConfigMigration } from "../src/config-migration.mjs";
import { applyMemoryGovernance, formatMemoryGovernanceReport } from "../src/memory-governance.mjs";
import { evaluateRuntimeGates, formatRuntimeGateReport } from "../src/runtime-gates.mjs";
import { createDefaultResourceProviderRegistry } from "../src/resource-provider-registry.mjs";
import { checkExtensionContracts, extensionPaths, formatExtensionContractReport } from "../src/extension-compat.mjs";
import { formatEquaxisBanner, shouldShowBanner } from "../src/cli-banner.mjs";
import { resolveRuntimeRoot } from "../src/runtime-root.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function computeRuntimeRoot() {
  // The project root is the nearest config carrier; the runtime root must
  // also carry .pi/extensions + scripts (repo checkout). Otherwise the
  // runtime comes from this installed package.
  return resolveRuntimeRoot(findProjectRoot(process.cwd()), packageRoot);
}

/**
 * The active Equaxis root: the nearest ancestor of the working directory with
 * a .pi/equaxis.json (a project configured to use Equaxis), falling back to
 * the package's own bundled template config. This lets a globally installed
 * `equaxis` command serve any project from anywhere.
 */
function findProjectRoot(start) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, ".pi", "equaxis.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return packageRoot;
    current = parent;
  }
}

const projectRoot = findProjectRoot(process.cwd());
const piEntry = (() => {
  try {
    // Resolves through the package's own dependency graph (works for global
    // installs where deps live in the global node_modules, not under the package).
    return createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent/dist/cli.js");
  } catch {
    return path.join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  }
})();
let unifiedConfig;
try {
  unifiedConfig = loadEquaxisConfig(projectRoot);
} catch (error) {
  console.error(`Failed to load unified Equaxis config: ${error.message}`);
  process.exit(1);
}
const cliArgs = process.argv.slice(2);

function parseJsonArg(value, fallback = {}) {
  if (!value) return fallback;
  const source = value.startsWith("@")
    ? fs.readFileSync(path.resolve(process.cwd(), value.slice(1)), "utf8")
    : value;
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Expected JSON argument: ${error.message}`);
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function localEvalLoop() {
  // Evaluation is offline: runtime facts live in the reliability trace stream
  // (eval_outcome_recorded); the ledger (events.jsonl) holds manual records,
  // candidates and decisions. createEvalLoopFromTrace merges both and drops
  // legacy duplicated rows by traceId.
  return createEvalLoopFromTrace({
    persist: unifiedConfig.evaluation?.enabled !== false,
    projectRoot,
    rootDir: unifiedConfig.evaluation?.rootDir ?? ".pi/runtime/eval-loop",
    traceDir: unifiedConfig.reliability?.traceDir ?? ".pi/runtime",
    maxFiles: unifiedConfig.reliability?.trace?.maxFiles ?? 3
  });
}

async function handleLocalCommand(args) {
  const [group, command, payload] = args;
  if (group === "model") {
    const configLayers = loadEquaxisConfigLayers(projectRoot);
    let piSettings = {};
    try {
      piSettings = JSON.parse(fs.readFileSync(path.join(projectRoot, ".pi", "settings.json"), "utf8"));
    } catch {
      // no project settings yet
    }
    const catalog = loadModelCatalog();
    const asJson = args.includes("--json");
    if (command === "list" || !command) {
      const slots = listModelSlots({ effective: configLayers.effective, piSettings, catalog });
      if (asJson) { printJson(slots); return true; }
      const fallbackNote = {
        true: "falls back to the main model",
        false: "no fallback (this IS the main model)"
      };
      for (const slot of slots) {
        const status = !slot.configured
          ? "not configured — uses the session model"
          : slot.error
            ? `BROKEN: ${slot.error}`
            : slot.unverified
              ? "set (not in local catalog — built-in or remote?)"
              : "ok";
        console.log(`${slot.slot.padEnd(8)} ${String(slot.resolved ?? "-").padEnd(42)} ${status}`);
        console.log(`         ${slot.label}; ${fallbackNote[String(slot.fallback !== "none")]}`);
      }
      console.log(`\ncatalog: ${catalog.size} provider(s) from ~/.pi/agent/models.json + models-store.json`);
      return true;
    }
    if (command === "set" || command === "main") {
      // `model main <provider> <model>` is shorthand for `model set main …`
      const [slotId, provider, model] = command === "main"
        ? ["main", args[2], args[3]]
        : [args[2], args[3], args[4]];
      if (!slotId || !provider || !model) {
        throw new Error("usage: equaxis model set <slot> <provider> <model> | main <provider> <model>  (slots: main, dream, advisor)");
      }
      const result = applyModelSlot({ slotId, provider, model, cwd: projectRoot, layers: configLayers });
      if (asJson) { printJson(result); return true; }
      console.log(`${result.slot}: ${provider}/${model} → ${path.relative(projectRoot, result.file)}`);
      if (result.unverified) console.log("  (not in the local catalog — accepted as a built-in/provider; verify the id)");
      return true;
    }
    if (command === "unset") {
      const slotId = args[2];
      if (!slotId) throw new Error("usage: equaxis model unset <slot>");
      const result = applyModelSlot({ slotId, clear: true, cwd: projectRoot, layers: configLayers });
      if (asJson) { printJson(result); return true; }
      console.log(`${result.slot}: cleared → falls back to the session model (${path.relative(projectRoot, result.file)})`);
      return true;
    }
    if (command === "catalog") {
      const providerName = args[2];
      if (!providerName) {
        const providers = [...catalog.entries()]
          .map(([name, models]) => ({ name, count: models.size, creds: hasCredentials(name) }))
          .sort((a, b) => (b.creds.ok - a.creds.ok) || a.name.localeCompare(b.name));
        if (asJson) { printJson(providers); return true; }
        console.log("providers (usable first — \u2713 = local key found):\n");
        for (const p of providers) {
          console.log(`  ${p.name.padEnd(24)} ${String(p.count).padStart(3)} models  ${p.creds.ok ? "\u2713 " + p.creds.source : "no local key"}`);
        }
        console.log("\npick with: equaxis model catalog <provider>   then: equaxis model set <slot> <provider> <model>");
        return true;
      }
      const models = describeProviderModels(catalog, providerName);
      if (!models) {
        throw new Error(`unknown provider "${providerName}" — try: equaxis model catalog`);
      }
      const creds = hasCredentials(providerName);
      if (asJson) { printJson({ provider: providerName, creds, models }); return true; }
      console.log(`${providerName} — ${models.length} models  ${creds.ok ? "\u2713 key via " + creds.source : "no local key (env vars may still apply)"}\n`);
      for (const model of models) {
        console.log(`  ${model.id.padEnd(36)} ${model.name ?? ""}`);
      }
      console.log(`\nset with: equaxis model set <slot> ${providerName} <model-id>`);
      return true;
    }
    throw new Error("usage: equaxis model [list|set|main|unset|catalog] [--json]");
  }
  if (group === "protocols" && command === "verify") {
    const report = runProtocolRegression({ projectRoot, config: unifiedConfig });
    console.log(formatProtocolRegressionReport(report));
    process.exit(report.ok ? 0 : report.status || 1);
  }
  if (group === "eval") {
    const loop = localEvalLoop();
    if (command === "record") { printJson(loop.record(parseJsonArg(payload))); return true; }
    if (command === "snapshot") { printJson(loop.snapshot(parseJsonArg(payload))); return true; }
    if (command === "decide") { printJson(compareCandidate({
      ...parseJsonArg(payload),
      minSamples: unifiedConfig.evaluation?.minSamples,
      minSuccessRateDelta: unifiedConfig.evaluation?.minSuccessRateDelta,
      maxLatencyRegression: unifiedConfig.evaluation?.maxLatencyRegression,
      maxCostRegression: unifiedConfig.evaluation?.maxCostRegression,
      confidenceZ: unifiedConfig.evaluation?.confidenceZ
    })); return true; }
    if (command === "export-harbor") { printJson(exportEvalLoopForHarbor({ projectRoot, events: loop.events, ...parseJsonArg(payload) })); return true; }
  }
  if (group === "gates" && command === "check") {
    const report = evaluateRuntimeGates(parseJsonArg(payload), unifiedConfig.runtime?.gates);
    if (args.includes("--json")) { printJson(report); return true; }
    console.log(formatRuntimeGateReport(report));
    process.exit(report.ok ? 0 : 1);
  }
  if (group === "memory" && (command === "audit" || command === "apply")) {
    const governance = unifiedConfig.memory?.governance ?? {};
    const inputArg = args.slice(2).find((arg) => !arg.startsWith("--"));
    const inputPath = path.resolve(projectRoot, inputArg ?? governance.auditPath ?? ".pi/runtime/memory-governance/memories.jsonl");
    const report = applyMemoryGovernance({
      inputPath,
      apply: command === "apply",
      retentionDays: governance.retentionDays
    });
    if (args.includes("--json")) { printJson(report); return true; }
    console.log(formatMemoryGovernanceReport(report));
    return true;
  }
  if (group === "config" && command === "migrate") {
    const report = runConfigMigration({ projectRoot, dryRun: !args.includes("--write") });
    if (args.includes("--json")) { printJson(report); return true; }
    console.log(formatConfigMigrationReport(report));
    return true;
  }
  if (group === "resources" && command === "read") {
    const registry = createDefaultResourceProviderRegistry({ projectRoot });
    const result = await registry.read(payload);
    if (args.includes("--json")) { printJson(result); return true; }
    console.log(result.text);
    return true;
  }
  if (group === "runtime" && (command === "dashboard" || command === "status")) {
    const dashboard = buildRuntimeDashboard({ projectRoot, cwd: process.cwd(), env: process.env, config: unifiedConfig });
    if (args.includes("--json")) { printJson(dashboard); return true; }
    console.log(formatRuntimeDashboard(dashboard));
    return true;
  }
  if (group === "versions") {
    const store = new VersionStore({ projectRoot });
    if (command === "add") { printJson(store.writeCandidate(parseJsonArg(payload))); return true; }
    if (command === "list") { printJson(store.list(payload)); return true; }
  }
  return false;
}

try {
  const handled = await handleLocalCommand(cliArgs);
  if (handled !== false) process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// Data-only project roots (a workspace with just .pi/equaxis.json, e.g. the
// user's home) borrow the runtime — extensions, scripts, settings template —
// from the installed package; the project root still supplies config/state.
const runtimeRoot = computeRuntimeRoot();

const startup = runStartupPreflight({ projectRoot, runtimeRoot, cwd: process.cwd(), env: process.env, piEntry });
if (!startup.ok) {
  const report = runDoctor({ projectRoot, runtimeRoot, cwd: process.cwd(), env: process.env, piEntry });
  if (cliArgs.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.error(formatDoctorReport(report));
  process.exit(1);
}
const extensionContracts = startup.extensionContracts ?? checkExtensionContracts({
  projectRoot: runtimeRoot,
  manifestPath: path.resolve(runtimeRoot, unifiedConfig.extensions.manifest)
});
if (!extensionContracts.ok) {
  console.error(formatExtensionContractReport(extensionContracts));
  process.exit(1);
}
const runtimeProfile = unifiedConfig.runtime.profile;
const profileSelection = profileExtensionSelection(runtimeProfile, unifiedConfig.extensions);
const extensionArgs = profileSelection === null
  ? []
  : extensionPaths(runtimeRoot, extensionContracts.manifest, profileSelection).flatMap((extensionPath) => [
      "--extension",
      extensionPath
    ]);

if (shouldShowBanner({ args: cliArgs })) {
  process.stdout.write(formatEquaxisBanner({ color: !process.env.NO_COLOR }));
}

if (cliArgs[0] === "--doctor") {
  const report = runDoctor({ projectRoot, runtimeRoot, cwd: process.cwd() });
  if (cliArgs.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatDoctorReport(report));
  process.exit(report.ok ? 0 : 1);
}

/**
 * Resolve Pi's settings.json (the same file the spawned CLI reads via
 * getAgentDir()). Falls back to project-root settings, then to the
 * historical hardcoded defaults.
 */
function readPiSettings() {
  const candidates = [
    path.join(process.cwd(), ".pi", "settings.json"),
    path.join(runtimeRoot, ".pi", "settings.json")
  ];
  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // try the next candidate
    }
  }
  return {};
}

const hasOption = (name) => cliArgs.some((arg) => arg === name || arg.startsWith(`${name}=`));
const piSettings = readPiSettings();
const modelArgs = [];
// Only force defaults that are explicitly configured: with no default
// provider/model, Pi presents the full provider picker so the user can
// choose (or /login) instead of being pinned to one vendor.
if (!hasOption("--provider") && piSettings.defaultProvider) modelArgs.push("--provider", piSettings.defaultProvider);
if (!hasOption("--model") && piSettings.defaultModel) modelArgs.push("--model", piSettings.defaultModel);
if (!hasOption("--thinking") && piSettings.defaultThinkingLevel) modelArgs.push("--thinking", piSettings.defaultThinkingLevel);
if (modelArgs.length === 0 && !hasOption("--model") && !hasOption("--provider") && !cliArgs.includes("--offline") && !cliArgs.includes("--list-models")) {
  const hasKey = Boolean(process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY);
  if (!hasKey) {
    process.stderr.write("Equaxis: no provider key found — run /login inside the agent (or the Models panel in pi-web) to pick a provider.\n");
  }
}

const result = spawnSync(
  process.execPath,
  // --no-extensions disables Pi's auto-discovery of .pi/extensions/*.ts
  // so that only the explicit --extension paths from the manifest filter
  // are loaded. Without this, runtime.profile and extensions.disabled
  // have no effect on direct-mount extensions.
  [piEntry, "--no-extensions", ...extensionArgs, ...modelArgs, ...cliArgs],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  }
);

if (result.error) {
  console.error(`Failed to start Equaxis: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
