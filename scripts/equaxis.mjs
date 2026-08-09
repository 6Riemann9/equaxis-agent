#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatDoctorReport, runDoctor, runStartupPreflight } from "../src/doctor.mjs";
import { loadEquaxisConfig } from "../src/equaxis-config.mjs";
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
