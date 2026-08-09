#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatProductizationExerciseReport, formatProductizationReport, runProductizationCommand, runProductizationExercise } from "../src/productization.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith("--"));
const dryRun = args.includes("--dry-run");
const json = args.includes("--json");

if (!command) {
  console.error("Usage: node scripts/equaxis-product.mjs <install|update|release|exercise> [--dry-run] [--json]");
  process.exit(1);
}

try {
  const report = command === "exercise"
    ? runProductizationExercise({ projectRoot, cwd: process.cwd(), env: process.env })
    : runProductizationCommand(command, {
        projectRoot,
        cwd: process.cwd(),
        env: process.env,
        dryRun
      });
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(command === "exercise" ? formatProductizationExerciseReport(report) : formatProductizationReport(report));
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(`Equaxis ${command} failed: ${error.message}`);
  process.exit(1);
}
