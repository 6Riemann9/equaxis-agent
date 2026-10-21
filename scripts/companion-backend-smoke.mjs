#!/usr/bin/env node
/**
 * Backend smoke test: prove each execution backend really confines a
 * teammate subprocess — not just that its argv looks right.
 *
 * Usage:
 *   node scripts/companion-backend-smoke.mjs                 # every available tier
 *   node scripts/companion-backend-smoke.mjs bwrap directory
 *   node scripts/companion-backend-smoke.mjs container       # needs a local image
 *   node scripts/companion-backend-smoke.mjs --image node:22-slim container
 *   node scripts/companion-backend-smoke.mjs --microvm-kernel vmlinuz \
 *        --microvm-rootfs disk.img microvm
 *
 * Each probe runs `node -e <script>` through the backend and checks:
 *   - the child starts at all (argv/engine wiring is valid)
 *   - cwd is the teammate workspace
 *   - a write INSIDE the workspace succeeds
 *   - a write OUTSIDE the workspace (into the project root) is refused
 *     (directory backend is expected to allow it — that is its documented
 *     lack of isolation, reported as such rather than failing the run)
 *
 * Exit code is 0 when every requested backend behaves as documented.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKEND_ORDER,
  createBackendSpawnWrapper,
  detectBackend,
  formatBackendChoice,
  resolveBackend
} from "../src/companion-backends.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROBE = `
const fs = require("node:fs");
const cwd = process.cwd();
const result = { cwd };
try {
  fs.writeFileSync(require("node:path").join(cwd, ".smoke-write"), "ok");
  result.insideWrite = "ok";
} catch (error) { result.insideWrite = "refused: " + error.code; }
try {
  fs.writeFileSync(require("node:path").join(process.env.SMOKE_OUTSIDE, ".smoke-write"), "ok");
  result.outsideWrite = "allowed";
} catch (error) { result.outsideWrite = "refused: " + error.code; }
console.log("SMOKE " + JSON.stringify(result));
`.trim();

function parseArgs(argv) {
  const backends = [];
  let image = "docker.io/library/node:22-slim";
  const microvm = { kernel: null, rootfs: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--image") {
      image = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--microvm-kernel") {
      microvm.kernel = path.resolve(String(argv[i + 1]));
      i += 1;
    } else if (argv[i] === "--microvm-rootfs") {
      microvm.rootfs = path.resolve(String(argv[i + 1]));
      i += 1;
    } else if (!argv[i].startsWith("-")) {
      backends.push(argv[i]);
    }
  }
  return { backends: backends.length ? backends : null, image, microvm };
}

function spawnAndCollect(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function probe(backendId, { image, microvm }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `smoke-${backendId}-`));
  const projectRoot = path.join(root, "project");
  const workspace = path.join(projectRoot, ".pi", "companion", "workspaces", "probe");
  const homeDir = path.join(projectRoot, ".pi", "companion", "home", "probe");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".pi", "agent", "sessions"), { recursive: true });

  const wrapper = createBackendSpawnWrapper({
    backend: backendId,
    workspace,
    projectRoot,
    homeDir,
    image,
    microvm,
    spawnImpl: spawn
  });

  const run = wrapper(process.execPath, ["-e", PROBE], {
    cwd: workspace,
    env: { ...process.env, HOME: homeDir, SMOKE_OUTSIDE: projectRoot },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const collected = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    run.stdout?.on("data", (chunk) => { stdout += chunk; });
    run.stderr?.on("data", (chunk) => { stderr += chunk; });
    run.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    run.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  const line = collected.stdout.split("\n").find((entry) => entry.startsWith("SMOKE "));
  const result = line ? JSON.parse(line.slice(6)) : null;
  return { root, projectRoot, workspace, ...collected, result };
}

function report(backendId, outcome) {
  const { code, result, stderr } = outcome;
  if (!result) {
    console.log(`  \u2717 no SMOKE line (exit ${code})`);
    if (stderr.trim()) console.log(`    stderr: ${stderr.trim().split("\n").slice(0, 3).join("\n    ")}`);
    return false;
  }
  const cwdOk = result.cwd === outcome.workspace;
  const insideOk = result.insideWrite === "ok";
  const outsideRefused = result.outsideWrite !== "allowed";
  console.log(`  cwd=${cwdOk ? "workspace \u2713" : `UNEXPECTED (${result.cwd})`}`);
  console.log(`  write inside workspace: ${result.insideWrite}`);
  console.log(`  write into the read-only project root: ${result.outsideWrite}`);
  if (backendId === "directory") {
    console.log("  (directory backend is documented as isolation-free — an allowed outside write is expected)");
    return cwdOk && insideOk;
  }
  return cwdOk && insideOk && outsideRefused;
}

const { backends: requested, image, microvm } = parseArgs(process.argv.slice(2));
const targets = requested ?? BACKEND_ORDER;

const auto = await resolveBackend("auto", { ceiling: "bwrap" });
console.log(`auto picks: ${formatBackendChoice(auto)}\n`);

let failures = 0;
for (const backendId of targets) {
  const entry = await detectBackend(backendId, { microvm });
  console.log(`\n== ${backendId} (${entry.label}) ==`);
  console.log(`   ${entry.available ? "\u2713 available" : "\u2717 unavailable"}: ${entry.detail}`);
  if (!entry.available) {
    console.log(`   skipped — ${entry.detail}`);
    if (backendId !== "microvm") failures += 1;
    continue;
  }
  const outcome = await probe(backendId, { image, microvm });
  if (!report(backendId, outcome)) failures += 1;
  fs.rmSync(outcome.root, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures} backend(s))`} — package root: ${packageRoot}`);
process.exit(failures === 0 ? 0 : 1);
