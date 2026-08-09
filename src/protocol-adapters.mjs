import fs from "node:fs";
import { spawnSync } from "node:child_process";

function asArray(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function commandLabel(command, args = []) {
  return [command, ...args].filter(Boolean).join(" ");
}

function detectLsp(adapter = {}, options = {}) {
  const command = String(adapter.command ?? "").trim();
  const args = asArray(adapter.args);
  if (!command) return { kind: "lsp", available: false, status: "skipped", reason: "not configured" };
  if (command === "node" && args[0] && !fs.existsSync(args[0])) {
    return { kind: "lsp", available: false, status: "skipped", reason: `entry not found: ${args[0]}`, command: commandLabel(command, args) };
  }
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const probe = spawnSyncImpl(command, args.includes("--stdio") ? [args[0], "--version"].filter(Boolean) : ["--version"], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000
  });
  const output = String(probe.stdout ?? probe.stderr ?? probe.error?.message ?? "").trim();
  return {
    kind: "lsp",
    available: probe.status === 0,
    status: probe.status === 0 ? "available" : "unavailable",
    reason: probe.status === 0 ? output || "ok" : output || `exit ${probe.status ?? 1}`,
    command: commandLabel(command, args)
  };
}

function detectDap(adapter = {}, options = {}) {
  const command = String(adapter.command ?? "").trim();
  const args = asArray(adapter.args);
  if (!command) return { kind: "dap", available: false, status: "skipped", reason: "not configured" };
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const probeArgs = command.includes("python") || args[0] === "-m"
    ? ["-c", "import debugpy.adapter; print('debugpy.adapter')"]
    : ["--version"];
  const probe = spawnSyncImpl(command, probeArgs, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000
  });
  const output = String(probe.stdout ?? probe.stderr ?? probe.error?.message ?? "").trim();
  return {
    kind: "dap",
    available: probe.status === 0,
    status: probe.status === 0 ? "available" : "unavailable",
    reason: probe.status === 0 ? output || "ok" : output || `exit ${probe.status ?? 1}`,
    command: commandLabel(command, args)
  };
}

export function discoverProtocolAdapters(config = {}, options = {}) {
  return {
    lsp: detectLsp(config.protocols?.lsp, options),
    dap: detectDap(config.protocols?.dap, options)
  };
}

export function summarizeProtocolAdapters(discovery) {
  return [discovery.lsp, discovery.dap].map((item) => `${item.kind}=${item.status}${item.reason ? ` (${item.reason})` : ""}`).join("; ");
}
