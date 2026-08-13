import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runDoctor, runStartupPreflight, formatDoctorReport } from "./doctor.mjs";

function step(name, status, detail = "") {
  return { name, status, detail };
}

function runCommand(command, args, options) {
  const result = options.spawnSyncImpl(command, args, {
    cwd: options.projectRoot,
    env: options.env,
    encoding: "utf8",
    windowsHide: true
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? result.error?.message ?? "").trim()
  };
}

function commandDetail(result) {
  if (result.status === 0) return result.stdout || "ok";
  return result.stderr || result.stdout || `exit ${result.status}`;
}

function npmInvocation(options = {}) {
  if (options.npmCommand) return { command: options.npmCommand, prefixArgs: [] };
  const npmCli = options.env?.npm_execpath;
  if (npmCli) return { command: options.nodeCommand ?? process.execPath, prefixArgs: [npmCli] };
  return { command: options.platform === "win32" ? "npm.cmd" : "npm", prefixArgs: [] };
}

function npmArgs(npm, args) {
  return [...npm.prefixArgs, ...args];
}

function parsePackage(projectRoot) {
  const packagePath = path.join(projectRoot, "package.json");
  return JSON.parse(fs.readFileSync(packagePath, "utf8"));
}

function gateResult(name, result) {
  if (!result) return null;
  return {
    name,
    ok: result.status === 0,
    status: result.status,
    detail: commandDetail(result),
    stdout: result.stdout,
    stderr: result.stderr
  };
}

const PACK_REQUIRED_FILES = [
  ".pi/equaxis.json",
  ".pi/extensions/contracts.json",
  ".pi/settings.json",
  "scripts/equaxis.mjs",
  "pi-web/bin/pi-web.js"
];
const PACK_FORBIDDEN_PREFIXES = ["harbor_eval/jobs/", "harbor_eval/reports/"];

/**
 * Assert that an npm pack file list ships the runtime files Equaxis needs at
 * first run and excludes local runtime/benchmark data. Pure and testable
 * without invoking npm.
 */
export function assertPackFiles(files = []) {
  const missing = PACK_REQUIRED_FILES.filter((required) => !files.includes(required));
  const leaked = files.filter((file) => PACK_FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix)));
  const issues = [
    ...missing.map((file) => "missing required file in package: " + file),
    ...leaked.map((file) => "runtime or benchmark data leaked into package: " + file)
  ];
  return { ok: issues.length === 0, issues, missing, leaked };
}

/** Extract packed file paths from npm pack --dry-run --json stdout. */
export function packFilePaths(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return Array.isArray(first?.files) ? first.files.map((file) => String(file?.path ?? "")) : null;
}

function writeReleaseManifest(projectRoot, pkg, options = {}) {
  const outputPath = options.outputPath ?? path.join(projectRoot, ".pi", "runtime", "release-manifest.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const config = options.config ?? null;
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    private: Boolean(pkg.private),
    node: pkg.engines?.node ?? null,
    pi: pkg.dependencies?.["@earendil-works/pi-coding-agent"] ?? null,
    gates: {
      verify: "verify:full",
      protocols: "test:protocols",
      memory: "test:memory",
      evaluation: "test:eval"
    },
    gateResults: options.gateResults ?? {},
    runtime: {
      gates: config?.runtime?.gates ?? null,
      evaluation: config?.evaluation ?? null,
      memory: config?.memory ? { governance: config.memory.governance } : null,
      subagents: config?.subagents ? {
        budgets: config.subagents.budgets,
        persistence: config.subagents.persistence,
        isolation: config.subagents.isolation
      } : null,
      protocols: config?.protocols ?? null
    },
    generatedAt: new Date().toISOString()
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return outputPath;
}

export function runProductizationExercise(options = {}) {
  const platforms = options.platforms ?? [options.platform ?? process.platform];
  const commands = options.commands ?? ["install", "update", "release"];
  const runs = [];
  for (const platform of platforms) {
    for (const command of commands) {
      const report = runProductizationCommand(command, { ...options, platform, dryRun: true });
      runs.push({ platform, command, ok: report.ok, steps: report.steps });
    }
  }
  return { ok: runs.every((item) => item.ok), platforms, commands, runs };
}

export function formatProductizationExerciseReport(report) {
  const lines = ["Equaxis productization exercise", ""];
  for (const run of report.runs) lines.push(`${run.ok ? "PASS" : "FAIL"}  ${run.platform} ${run.command}`);
  lines.push("", report.ok ? "READY" : "NOT READY");
  return lines.join("\n");
}

export function runProductizationCommand(command, options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const cwd = path.resolve(options.cwd ?? projectRoot);
  const env = options.env ?? process.env;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const dryRun = Boolean(options.dryRun);
  const npm = npmInvocation({
    env,
    npmCommand: options.npmCommand,
    nodeCommand: options.nodeCommand,
    platform: options.platform
  });
  const steps = [];
  const execOptions = { projectRoot, env, spawnSyncImpl };

  if (!["install", "update", "release"].includes(command)) {
    throw new Error(`Unknown Equaxis productization command: ${command}`);
  }

  const startup = runStartupPreflight({ projectRoot, cwd, env, nodeVersion: options.nodeVersion });
  steps.push(step("startup preflight", startup.ok, startup.ok ? "ready" : "not ready"));

  if (command === "install") {
    if (dryRun) {
      steps.push(step("npm install", true, "skipped by --dry-run"));
      steps.push(step("memory setup", true, "skipped by --dry-run"));
    } else {
      const install = runCommand(npm.command, npmArgs(npm, ["install"]), execOptions);
      steps.push(step("npm install", install.status === 0, commandDetail(install)));
      const memory = runCommand(npm.command, npmArgs(npm, ["run", "setup:memory"]), execOptions);
      steps.push(step("memory setup", memory.status === 0, commandDetail(memory)));
    }
    const doctor = runDoctor({ projectRoot, cwd, env, spawnSyncImpl, nodeVersion: options.nodeVersion });
    steps.push(step("doctor", doctor.ok, doctor.ok ? "READY" : "NOT READY"));
    return { ok: steps.every((item) => item.status), command, projectRoot, cwd, steps, doctor };
  }

  if (command === "update") {
    if (dryRun) {
      steps.push(step("npm install", true, "skipped by --dry-run"));
    } else {
      const install = runCommand(npm.command, npmArgs(npm, ["install"]), execOptions);
      steps.push(step("npm install", install.status === 0, commandDetail(install)));
    }
    const doctor = runDoctor({ projectRoot, cwd, env, spawnSyncImpl, nodeVersion: options.nodeVersion });
    steps.push(step("doctor", doctor.ok, doctor.ok ? "READY" : "NOT READY"));
    return { ok: steps.every((item) => item.status), command, projectRoot, cwd, steps, doctor };
  }

  const pkg = parsePackage(projectRoot);
  steps.push(step("package metadata", Boolean(pkg.name && pkg.version), `${pkg.name ?? "<unnamed>"}@${pkg.version ?? "<unversioned>"}`));
  if (dryRun) {
    steps.push(step("verify", true, "skipped by --dry-run"));
    steps.push(step("release manifest", true, "skipped by --dry-run"));
    return { ok: steps.every((item) => item.status), command, projectRoot, cwd, steps };
  }

  const verify = runCommand(npm.command, npmArgs(npm, ["run", "verify:full"]), execOptions);
  steps.push(step("verify:full", verify.status === 0, commandDetail(verify)));
  if (verify.status === 0) {
    const pack = runCommand(npm.command, npmArgs(npm, ["pack", "--dry-run", "--json"]), execOptions);
    const packFiles = pack.status === 0 ? packFilePaths(pack.stdout) : null;
    if (packFiles === null) {
      steps.push(step("package contents", false, pack.status === 0 ? "could not parse npm pack output" : commandDetail(pack)));
    } else {
      const packCheck = assertPackFiles(packFiles);
      const packDetail = packCheck.ok
        ? packFiles.length + " files; required .pi runtime files present; no harbor jobs/reports"
        : packCheck.issues.join("; ");
      steps.push(step("package contents", packCheck.ok, packDetail));
    }
    if (steps[steps.length - 1].status) {
      const manifestPath = writeReleaseManifest(projectRoot, pkg, { ...options, config: startup.unifiedConfig, gateResults: { verifyFull: gateResult("verify:full", verify) } });
      steps.push(step("release manifest", true, manifestPath));
    } else {
      steps.push(step("release manifest", false, "skipped because package contents gate failed"));
    }
  } else {
    steps.push(step("release manifest", false, "skipped because verify failed"));
  }
  return { ok: steps.every((item) => item.status), command, projectRoot, cwd, steps };
}

export function formatProductizationReport(report) {
  const lines = [`Equaxis ${report.command}`, `Runtime: ${report.projectRoot}`, `Workspace: ${report.cwd}`, ""];
  for (const item of report.steps) lines.push(`${item.status ? "PASS" : "FAIL"}  ${item.name}: ${item.detail}`);
  if (report.doctor && !report.doctor.ok) {
    lines.push("", formatDoctorReport(report.doctor));
  }
  lines.push("", report.ok ? "READY" : "NOT READY");
  return lines.join("\n");
}
