#!/usr/bin/env node

/**
 * One-command Equaxis onboarding: checks the toolchain, installs missing
 * dependencies, validates the unified config, and runs the doctor.
 * Idempotent and non-destructive.
 *
 * Usage: node scripts/setup.mjs [--json]
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEquaxisConfig } from "../src/equaxis-config.mjs";
import { formatDoctorReport, runDoctor } from "../src/doctor.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = process.argv.includes("--json");
const steps = [];

function step(name, ok, detail) {
  steps.push({ name, ok, detail });
}

function run(command, args, options = {}) {
  try {
    const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe", ...options });
    return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
  } catch (error) {
    return { ok: false, stdout: "", stderr: String(error) };
  }
}

function nodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  return { ok: major > 22 || (major === 22 && minor >= 19), version: process.versions.node };
}

const pythonProbe = run("python", ["-c", "import sys; print(sys.version.split()[0])"]);
const hasNodeModules = fs.existsSync(path.join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"));
const piWebDir = path.join(projectRoot, "pi-web");
const piWebBuilt = fs.existsSync(path.join(piWebDir, ".next", "BUILD_ID"));
const memoryImportable = pythonProbe.ok
  ? run("python", ["-c", "import sys; sys.path.insert(0, 'vendor/agent-memory'); import memory; print('ok')"], { cwd: projectRoot }).ok
  : false;

// 1. Toolchain
const node = nodeVersion();
step("Node.js", node.ok, node.ok ? `v${node.version} (>=22.19.0)` : `v${node.version} (requires >=22.19.0)`);
step("Python", pythonProbe.ok, pythonProbe.ok ? `v${pythonProbe.stdout}` : pythonProbe.stderr || "python not found");

// 2. Dependencies (install only when missing; never touch existing state)
if (!hasNodeModules) {
  const install = run("npm", ["install"], { cwd: projectRoot });
  step("npm install", install.ok, install.ok ? "installed" : install.stderr.slice(0, 300));
} else {
  step("npm install", true, "already installed");
}

if (!memoryImportable) {
  if (pythonProbe.ok) {
    const pip = run("python", ["-m", "pip", "install", "-e", "./vendor/agent-memory"], { cwd: projectRoot });
    step("Python memory core", pip.ok, pip.ok ? "installed" : pip.stderr.slice(0, 300));
  } else {
    step("Python memory core", false, "skipped: python unavailable");
  }
} else {
  step("Python memory core", true, "already importable");
}

// 2b. pi-web fork (web dashboards) — install deps and build when missing
if (fs.existsSync(piWebDir)) {
  if (!piWebBuilt) {
    const install = run("npm", ["install", "--no-audit", "--no-fund"], { cwd: piWebDir });
    const build = install.ok ? run("npm", ["run", "build"], { cwd: piWebDir }) : { ok: false, stderr: "" };
    step("pi-web fork build", build.ok, build.ok ? "installed + built" : (build.stderr || install.stderr || "build failed").slice(0, 200));
  } else {
    step("pi-web fork build", true, "already built");
  }
}

// 3. Config + doctor
let configOk = true;
let configDetail = "ok";
try {
  loadEquaxisConfig(projectRoot);
} catch (error) {
  configOk = false;
  configDetail = error instanceof Error ? error.message : String(error);
}
step("Unified config (.pi/equaxis.json)", configOk, configDetail);

const doctor = runDoctor({ projectRoot, cwd: projectRoot, env: process.env });
const failing = (doctor.checks ?? []).filter((check) => !check.status);
step("Doctor", doctor.ok, doctor.ok ? `${doctor.checks.length} checks passed` : `failing: ${failing.map((check) => check.name).join(", ")}`);

const ok = steps.every((item) => item.ok);

if (json) {
  console.log(JSON.stringify({ ok, steps, doctor: doctor.ok ? undefined : failing.map((check) => ({ name: check.name, detail: check.detail })) }, null, 2));
} else {
  for (const item of steps) console.log(`${item.ok ? "✓" : "✗"} ${item.name} — ${item.detail}`);
  if (doctor.ok) console.log(formatDoctorReport(doctor));
  console.log("\nNext steps:");
  console.log("  1. Add a provider key: OPENAI_API_KEY or .pi/auth.json (see docs/PROVIDER.md)");
  console.log("  2. Launch the agent:  npm run equaxis -- --approve");
  console.log("  3. Web dashboards:    /pi-web inside the agent, or run `pi-web` separately");
}

process.exit(ok && doctor.ok ? 0 : 1);
