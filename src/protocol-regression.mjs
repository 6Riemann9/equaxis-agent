import path from "node:path";
import { spawnSync } from "node:child_process";
import { RotatingJsonlTrace } from "./trace-store.mjs";
import { discoverProtocolAdapters } from "./protocol-adapters.mjs";

const DEFAULT_TEST_FILES = [
  "tests/lsp-client.test.mjs",
  "tests/dap-client.test.mjs",
  "tests/ast-tools.test.mjs",
  "tests/extension.integration.test.mjs"
];

function truncate(value, maxChars = 12000) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function npmInvocation(options = {}) {
  if (options.nodeCommand) return { command: options.nodeCommand, args: ["--test", ...DEFAULT_TEST_FILES] };
  return { command: process.execPath, args: ["--test", ...DEFAULT_TEST_FILES] };
}

function tracePath(projectRoot, options = {}) {
  return path.join(projectRoot, options.traceDir ?? ".pi/runtime/protocols", "traces.jsonl");
}

export function runProtocolRegression(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const invocation = options.invocation ?? npmInvocation(options);
  const trace = new RotatingJsonlTrace(tracePath(projectRoot, options), options.trace ?? {});
  const startedAt = new Date().toISOString();
  const adapters = options.config ? discoverProtocolAdapters(options.config, { cwd: projectRoot, env: options.env, spawnSyncImpl: options.adapterSpawnSyncImpl }) : null;
  trace.append({
    event: "protocol_regression_started",
    startedAt,
    projectRoot,
    command: invocation.command,
    args: invocation.args,
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
    adapters,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr ?? result.error?.message)
  };
  trace.append(record);
  return {
    ok: status === 0,
    status,
    traceFile: trace.filePath,
    adapters,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? "")
  };
}

export function formatProtocolRegressionReport(report) {
  const lines = [report.ok ? "Protocol regression passed" : "Protocol regression failed", `Trace: ${report.traceFile}`];
  if (!report.ok) {
    const detail = report.stderr.trim() || report.stdout.trim() || `exit ${report.status}`;
    lines.push("", truncate(detail, 2000));
  }
  return lines.join("\n");
}
