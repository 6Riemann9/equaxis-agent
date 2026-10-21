#!/usr/bin/env node

/**
 * One-command Python test environment: create the repo-local `.venv` and install
 * pytest plus the vendored agent-memory package into it.
 *
 * Needed on PEP 668 "externally managed" distributions (Arch, Debian 12+, …)
 * where `pip install` into the system interpreter is refused. Idempotent: an
 * existing `.venv` is reused and only (re)installed into.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const venvDir = path.join(root, ".venv");
const venvPython = path.join(venvDir, isWindows ? "Scripts" : "bin", isWindows ? "python.exe" : "python");

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    console.error(`${label} failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${label} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

if (!fs.existsSync(venvPython)) {
  console.log(`Creating virtualenv at ${path.relative(root, venvDir)} …`);
  run("python", ["-m", "venv", ".venv"], "python -m venv");
} else {
  console.log(`Reusing ${path.relative(root, venvDir)}`);
}

run(venvPython, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"], "pip upgrade");
run(
  venvPython,
  ["-m", "pip", "install", "--quiet", "-e", "./vendor/agent-memory", "pytest", "pytest-asyncio"],
  "pip install"
);

console.log("\nPython test environment ready. Run: npm run test:memory");
