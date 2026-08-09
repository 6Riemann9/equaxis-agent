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

function writeReleaseManifest(projectRoot, pkg, options = {}) {
  const outputPath = options.outputPath ?? path.join(projectRoot, ".pi", "runtime", "release-manifest.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    private: Boolean(pkg.private),
    node: pkg.engines?.node ?? null,
    pi: pkg.dependencies?.["@earendil-works/pi-coding-agent"] ?? null,
    generatedAt: new Date().toISOString()
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return outputPath;
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

  const verify = runCommand(npm.command, npmArgs(npm, ["run", "verify"]), execOptions);
  steps.push(step("verify", verify.status === 0, commandDetail(verify)));
  if (verify.status === 0) {
    const manifestPath = writeReleaseManifest(projectRoot, pkg, options);
    steps.push(step("release manifest", true, manifestPath));
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
