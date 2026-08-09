import fs from "node:fs";
import path from "node:path";
import { runDoctor } from "./doctor.mjs";
import { EvalLoop } from "./eval-loop.mjs";
import { VersionStore } from "./version-store.mjs";
import { discoverProtocolAdapters } from "./protocol-adapters.mjs";
import { evaluateRuntimeGates } from "./runtime-gates.mjs";

function fileInfo(projectRoot, relativePath) {
  const absolute = path.resolve(projectRoot, relativePath);
  const inside = !path.relative(projectRoot, absolute).startsWith("..");
  if (!inside || !fs.existsSync(absolute)) return { path: relativePath, exists: false, bytes: 0 };
  const stat = fs.statSync(absolute);
  return { path: relativePath, exists: true, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
}

function groupCounts(items, key) {
  return items.reduce((counts, item) => {
    const value = String(item[key] ?? "unknown");
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

export function buildRuntimeDashboard(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const config = options.config;
  const doctor = runDoctor({ projectRoot, cwd: options.cwd ?? projectRoot, env: options.env ?? process.env, spawnSyncImpl: options.spawnSyncImpl, nodeVersion: options.nodeVersion });
  const evaluationConfig = config?.evaluation ?? { enabled: true, rootDir: ".pi/runtime/eval-loop" };
  const evalLoop = new EvalLoop({
    persist: evaluationConfig?.enabled !== false,
    projectRoot,
    rootDir: evaluationConfig?.rootDir ?? ".pi/runtime/eval-loop"
  });
  const snapshot = evalLoop.snapshot();
  const versions = new VersionStore({ projectRoot }).list();
  const protocols = config ? discoverProtocolAdapters(config, { cwd: projectRoot, env: options.env, spawnSyncImpl: options.spawnSyncImpl }) : null;
  const gates = evaluateRuntimeGates(options.gateMetrics ?? {}, config?.runtime?.gates ?? {});
  const memoryGovernance = config?.memory?.governance ?? null;
  const checks = Array.isArray(doctor.checks) ? doctor.checks : [];
  const matrix = Array.isArray(snapshot.matrix) ? snapshot.matrix : [];
  const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
  const versionItems = Array.isArray(versions) ? versions : [];
  return {
    generatedAt: new Date().toISOString(),
    projectRoot,
    health: { ok: Boolean(doctor.ok), failing: checks.filter((item) => !item.status).map((item) => item.name), checks: checks.length },
    protocols,
    gates: { ok: gates.ok, enabled: gates.enabled, failing: gates.checks.filter((item) => !item.status).map((item) => item.name), checks: gates.checks.length },
    evaluation: {
      enabled: evaluationConfig?.enabled !== false,
      attempts: snapshot.attempts,
      successRate: snapshot.successRate,
      matrixRows: matrix.length,
      candidates: candidates.length,
      eventLog: fileInfo(projectRoot, path.join(evaluationConfig?.rootDir ?? ".pi/runtime/eval-loop", "events.jsonl"))
    },
    memoryGovernance: memoryGovernance ? {
      enabled: memoryGovernance.enabled !== false,
      retentionDays: memoryGovernance.retentionDays,
      auditLog: fileInfo(projectRoot, memoryGovernance.auditPath)
    } : null,
    versions: { total: versionItems.length, byKind: groupCounts(versionItems, "kind"), byStatus: groupCounts(versionItems, "status") },
    runtimeFiles: {
      protocolTrace: fileInfo(projectRoot, ".pi/runtime/protocols/traces.jsonl"),
      subagentEvents: fileInfo(projectRoot, ".pi/runtime/subagents/events.jsonl")
    }
  };
}

export function formatRuntimeDashboard(dashboard) {
  const lines = ["Equaxis runtime dashboard", `Runtime: ${dashboard.projectRoot}`, `Health: ${dashboard.health.ok ? "READY" : "NOT READY"}`];
  const failing = Array.isArray(dashboard.health.failing) ? dashboard.health.failing : [];
  if (failing.length) lines.push(`Failing: ${failing.join(", ")}`);
  if (dashboard.protocols) lines.push(`Protocols: lsp=${dashboard.protocols.lsp.status}; dap=${dashboard.protocols.dap.status}`);
  lines.push(`Gates: ${dashboard.gates.ok ? "READY" : "NOT READY"}${dashboard.gates.failing?.length ? ` (${dashboard.gates.failing.join(", ")})` : ""}`);
  lines.push(`Evaluation: attempts=${dashboard.evaluation.attempts}; successRate=${dashboard.evaluation.successRate ?? "n/a"}; candidates=${dashboard.evaluation.candidates}`);
  if (dashboard.memoryGovernance) lines.push(`Memory governance: ${dashboard.memoryGovernance.enabled ? "enabled" : "disabled"}; audit=${dashboard.memoryGovernance.auditLog.exists ? `${dashboard.memoryGovernance.auditLog.bytes} bytes` : "missing"}`);
  lines.push(`Versions: total=${dashboard.versions.total}`);
  lines.push(`Protocol trace: ${dashboard.runtimeFiles.protocolTrace.exists ? `${dashboard.runtimeFiles.protocolTrace.bytes} bytes` : "missing"}`);
  lines.push(`Subagent events: ${dashboard.runtimeFiles.subagentEvents.exists ? `${dashboard.runtimeFiles.subagentEvents.bytes} bytes` : "missing"}`);
  return lines.join("\n");
}
