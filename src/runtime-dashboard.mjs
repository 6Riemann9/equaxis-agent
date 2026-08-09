import fs from "node:fs";
import path from "node:path";
import { runDoctor } from "./doctor.mjs";
import { EvalLoop } from "./eval-loop.mjs";
import { VersionStore } from "./version-store.mjs";
import { discoverProtocolAdapters } from "./protocol-adapters.mjs";

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
  return {
    generatedAt: new Date().toISOString(),
    projectRoot,
    health: { ok: doctor.ok, failing: doctor.checks.filter((item) => !item.status).map((item) => item.name), checks: doctor.checks.length },
    protocols,
    evaluation: {
      enabled: evaluationConfig?.enabled !== false,
      attempts: snapshot.attempts,
      successRate: snapshot.successRate,
      matrixRows: snapshot.matrix.length,
      candidates: snapshot.candidates.length,
      eventLog: fileInfo(projectRoot, path.join(evaluationConfig?.rootDir ?? ".pi/runtime/eval-loop", "events.jsonl"))
    },
    versions: { total: versions.length, byKind: groupCounts(versions, "kind"), byStatus: groupCounts(versions, "status") },
    runtimeFiles: {
      protocolTrace: fileInfo(projectRoot, ".pi/runtime/protocols/traces.jsonl"),
      subagentEvents: fileInfo(projectRoot, ".pi/runtime/subagents/events.jsonl")
    }
  };
}

export function formatRuntimeDashboard(dashboard) {
  const lines = ["Equaxis runtime dashboard", `Runtime: ${dashboard.projectRoot}`, `Health: ${dashboard.health.ok ? "READY" : "NOT READY"}`];
  if (dashboard.health.failing.length) lines.push(`Failing: ${dashboard.health.failing.join(", ")}`);
  if (dashboard.protocols) lines.push(`Protocols: lsp=${dashboard.protocols.lsp.status}; dap=${dashboard.protocols.dap.status}`);
  lines.push(`Evaluation: attempts=${dashboard.evaluation.attempts}; successRate=${dashboard.evaluation.successRate ?? "n/a"}; candidates=${dashboard.evaluation.candidates}`);
  lines.push(`Versions: total=${dashboard.versions.total}`);
  lines.push(`Protocol trace: ${dashboard.runtimeFiles.protocolTrace.exists ? `${dashboard.runtimeFiles.protocolTrace.bytes} bytes` : "missing"}`);
  lines.push(`Subagent events: ${dashboard.runtimeFiles.subagentEvents.exists ? `${dashboard.runtimeFiles.subagentEvents.bytes} bytes` : "missing"}`);
  return lines.join("\n");
}
