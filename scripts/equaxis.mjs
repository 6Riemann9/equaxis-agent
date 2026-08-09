#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatDoctorReport, runDoctor, runStartupPreflight } from "../src/doctor.mjs";
import { loadEquaxisConfig } from "../src/equaxis-config.mjs";
import { compareCandidate, EvalLoop } from "../src/eval-loop.mjs";
import { exportEvalLoopForHarbor } from "../src/eval-harbor-bridge.mjs";
import { formatProtocolRegressionReport, runProtocolRegression } from "../src/protocol-regression.mjs";
import { VersionStore } from "../src/version-store.mjs";
import { buildRuntimeDashboard, formatRuntimeDashboard } from "../src/runtime-dashboard.mjs";
import { formatConfigMigrationReport, runConfigMigration } from "../src/config-migration.mjs";
import { checkExtensionContracts, extensionPaths, formatExtensionContractReport } from "../src/extension-compat.mjs";
import { formatEquaxisBanner, shouldShowBanner } from "../src/cli-banner.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piEntry = path.join(
  projectRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js"
);
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
  return new EvalLoop({
    persist: unifiedConfig.evaluation?.enabled !== false,
    projectRoot,
    rootDir: unifiedConfig.evaluation?.rootDir ?? ".pi/runtime/eval-loop"
  });
}

function handleLocalCommand(args) {
  const [group, command, payload] = args;
  if (group === "protocols" && command === "verify") {
    const report = runProtocolRegression({ projectRoot, config: unifiedConfig });
    console.log(formatProtocolRegressionReport(report));
    process.exit(report.ok ? 0 : report.status || 1);
  }
  if (group === "eval") {
    const loop = localEvalLoop();
    if (command === "record") return printJson(loop.record(parseJsonArg(payload)));
    if (command === "snapshot") return printJson(loop.snapshot(parseJsonArg(payload)));
    if (command === "decide") return printJson(compareCandidate({
      ...parseJsonArg(payload),
      minSamples: unifiedConfig.evaluation?.minSamples,
      minSuccessRateDelta: unifiedConfig.evaluation?.minSuccessRateDelta,
      maxLatencyRegression: unifiedConfig.evaluation?.maxLatencyRegression,
      maxCostRegression: unifiedConfig.evaluation?.maxCostRegression,
      confidenceZ: unifiedConfig.evaluation?.confidenceZ
    }));
    if (command === "export-harbor") return printJson(exportEvalLoopForHarbor({ projectRoot, ...parseJsonArg(payload) }));
  }
  if (group === "config" && command === "migrate") {
    const report = runConfigMigration({ projectRoot, dryRun: !args.includes("--write") });
    if (args.includes("--json")) return printJson(report);
    console.log(formatConfigMigrationReport(report));
    return true;
  }
  if (group === "runtime" && (command === "dashboard" || command === "status")) {
    const dashboard = buildRuntimeDashboard({ projectRoot, cwd: process.cwd(), env: process.env, config: unifiedConfig });
    if (args.includes("--json")) return printJson(dashboard);
    console.log(formatRuntimeDashboard(dashboard));
    return true;
  }
  if (group === "versions") {
    const store = new VersionStore({ projectRoot });
    if (command === "add") return printJson(store.writeCandidate(parseJsonArg(payload)));
    if (command === "list") return printJson(store.list(payload));
  }
  return false;
}

try {
  const handled = handleLocalCommand(cliArgs);
  if (handled !== false) process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const startup = runStartupPreflight({ projectRoot, cwd: process.cwd(), env: process.env });
if (!startup.ok) {
  const report = runDoctor({ projectRoot, cwd: process.cwd(), env: process.env });
  if (cliArgs.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.error(formatDoctorReport(report));
  process.exit(1);
}
const extensionContracts = startup.extensionContracts ?? checkExtensionContracts({
  projectRoot,
  manifestPath: path.resolve(projectRoot, unifiedConfig.extensions.manifest)
});
if (!extensionContracts.ok) {
  console.error(formatExtensionContractReport(extensionContracts));
  process.exit(1);
}
const extensionArgs = extensionPaths(projectRoot, extensionContracts.manifest, unifiedConfig.extensions).flatMap((extensionPath) => [
  "--extension",
  extensionPath
]);

if (shouldShowBanner({ args: cliArgs })) {
  process.stdout.write(formatEquaxisBanner({ color: !process.env.NO_COLOR }));
}

if (cliArgs[0] === "--doctor") {
  const report = runDoctor({ projectRoot, cwd: process.cwd() });
  if (cliArgs.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatDoctorReport(report));
  process.exit(report.ok ? 0 : 1);
}

const hasOption = (name) => cliArgs.some((arg) => arg === name || arg.startsWith(`${name}=`));
const modelArgs = [];
if (!hasOption("--provider")) modelArgs.push("--provider", "openai-inprior");
if (!hasOption("--model")) modelArgs.push("--model", "gpt-5.5");
if (!hasOption("--thinking")) modelArgs.push("--thinking", "xhigh");

const result = spawnSync(
  process.execPath,
  [piEntry, ...extensionArgs, ...modelArgs, ...cliArgs],
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
