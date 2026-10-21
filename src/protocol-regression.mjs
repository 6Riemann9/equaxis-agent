import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RotatingJsonlTrace } from "./trace-store.mjs";
import { discoverProtocolAdapters } from "./protocol-adapters.mjs";

/**
 * Protocol regression suite. These files are the intended protocol coverage
 * (see docs/FILE_ARCHITECTURE.md); a checkout that has not written them yet
 * must not fail the gate — the run is reported as skipped instead of silently
 * green or permanently red.
 */
const DEFAULT_TEST_FILES = [
  "tests/lsp-client.test.mjs",
  "tests/dap-client.test.mjs",
  "tests/ast-tools.test.mjs",
  "tests/extension.integration.test.mjs"
];

/** Split the candidate suite into files that exist on disk and files that do not. */
export function resolveProtocolTestFiles(projectRoot, options = {}) {
  const candidates = options.testFiles ?? DEFAULT_TEST_FILES;
  const present = [];
  const missing = [];
  for (const file of candidates) {
    if (fs.existsSync(path.join(projectRoot, file))) present.push(file);
    else missing.push(file);
  }
  return { candidates, present, missing };
}

function truncate(value, maxChars = 12000) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function npmInvocation(options = {}) {
  if (options.nodeCommand) return { command: options.nodeCommand, args: ["--test", ...options.testFiles] };
  return { command: process.execPath, args: ["--test", ...options.testFiles] };
}

function tracePath(projectRoot, options = {}) {
  return path.join(projectRoot, options.traceDir ?? ".pi/runtime/protocols", "traces.jsonl");
}

export function runProtocolRegression(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const trace = new RotatingJsonlTrace(tracePath(projectRoot, options), options.trace ?? {});
  const startedAt = new Date().toISOString();
  const adapters = options.config ? discoverProtocolAdapters(options.config, { cwd: projectRoot, env: options.env, spawnSyncImpl: options.adapterSpawnSyncImpl }) : null;
  const files = resolveProtocolTestFiles(projectRoot, options);

  // Nothing to run: report an explicit skip instead of spawning a command that
  // can only fail on missing files (the previous behaviour), or exiting 0 as if
  // the suite had passed.
  if (files.present.length === 0) {
    const reason = `no protocol test files present (expected ${files.candidates.join(", ")})`;
    trace.append({ event: "protocol_regression_skipped", startedAt, projectRoot, reason, missing: files.missing, adapters });
    return {
      ok: true,
      skipped: true,
      status: 0,
      reason,
      missing: files.missing,
      traceFile: trace.filePath,
      adapters,
      stdout: "",
      stderr: ""
    };
  }

  const invocation = options.invocation ?? npmInvocation({ ...options, testFiles: files.present });
  trace.append({
    event: "protocol_regression_started",
    startedAt,
    projectRoot,
    command: invocation.command,
    args: invocation.args,
    missing: files.missing,
    adapters
  });

  const result = spawnSyncImpl(invocation.command, invocation.args, {
    cwd: projectRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true
  });
  const status = result.status ?? (result.error ? 1 : 0);
  const completedAt = new Date().toISOString();
  const record = {
    event: status === 0 ? "protocol_regression_passed" : "protocol_regression_failed",
    startedAt,
    completedAt,
    status,
    command: invocation.command,
    args: invocation.args,
    missing: files.missing,
    adapters,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr ?? result.error?.message)
  };
  trace.append(record);
  return {
    ok: status === 0,
    skipped: false,
    status,
    missing: files.missing,
    traceFile: trace.filePath,
    adapters,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? "")
  };
}

export function formatProtocolRegressionReport(report) {
  if (report.skipped) {
    const lines = ["Protocol regression SKIPPED (not a pass)", `Reason: ${report.reason}`, `Trace: ${report.traceFile}`];
    if (report.missing?.length) lines.push("", `Not yet written: ${report.missing.join(", ")}`);
    return lines.join("\n");
  }
  const lines = [report.ok ? "Protocol regression passed" : "Protocol regression failed", `Trace: ${report.traceFile}`];
  if (report.missing?.length) lines.push(`Note: additional protocol tests not present: ${report.missing.join(", ")}`);
  if (!report.ok) {
    const detail = report.stderr.trim() || report.stdout.trim() || `exit ${report.status}`;
    lines.push("", truncate(detail, 2000));
  }
  return lines.join("\n");
}
