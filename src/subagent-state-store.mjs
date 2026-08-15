import fs from "node:fs";
import path from "node:path";

function safeTaskFile(id) {
  return `${String(id).replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;
}

function ensureWorkspacePath(projectRoot, relativePath) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return target;
  throw new Error(`subagent state path must stay inside the workspace: ${relativePath}`);
}

function publicStatus(task) {
  return {
    id: task.id,
    label: task.label,
    status: task.status,
    dependencies: [...(task.dependencies ?? [])],
    traceId: task.traceId,
    timeoutMs: task.timeoutMs,
    maxRetries: task.maxRetries,
    attempts: task.attempts,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    result: task.result,
    error: task.error,
    errorCode: task.errorCode ?? null,
    failurePhase: task.failurePhase ?? null,
    failureKind: task.failureKind ?? null
  };
}

export class SubagentStateStore {
  constructor(options = {}) {
    this.projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    this.rootDir = ensureWorkspacePath(this.projectRoot, options.rootDir ?? ".pi/runtime/subagents");
    this.snapshotDir = path.join(this.rootDir, "snapshots");
    this.eventFile = path.join(this.rootDir, "events.jsonl");
  }

  ensure() {
    fs.mkdirSync(this.snapshotDir, { recursive: true });
  }

  record(event, task) {
    this.ensure();
    const status = publicStatus(task);
    const entry = JSON.stringify({ ts: new Date().toISOString(), event, task: status });
    fs.appendFileSync(this.eventFile, `${entry}\n`, "utf8");
    fs.writeFileSync(path.join(this.snapshotDir, safeTaskFile(task.id)), JSON.stringify(status, null, 2), "utf8");
  }

  loadSnapshots() {
    if (!fs.existsSync(this.snapshotDir)) return [];
    const snapshots = [];
    for (const name of fs.readdirSync(this.snapshotDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const value = JSON.parse(fs.readFileSync(path.join(this.snapshotDir, name), "utf8"));
        if (value?.id && typeof value.id === "string") snapshots.push(value);
      } catch {
        // Ignore corrupt historical snapshots; runtime execution should not fail because recovery data is stale.
      }
    }
    return snapshots;
  }
}

export function describeSubagentPersistence(config) {
  const persistence = config?.subagents?.persistence;
  if (!persistence?.enabled) return { enabled: false, detail: "disabled" };
  return { enabled: true, detail: `snapshotDir=${persistence.rootDir}/snapshots` };
}

/**
 * MARC v1 (arXiv 2608.13476) stage-level failure attribution over persisted
 * subagent events. Input rows are state-store entries ({ event, task });
 * failed/cancelled tasks are aggregated by (failurePhase, failureKind) and
 * by errorCode, returning the dominant failure stage/kind for triage.
 */
export function attributeFailures(rows) {
  const failed = rows.filter((row) => {
    const task = row?.task ?? row;
    return task && ["failed", "cancelled"].includes(task.status);
  });
  const byPhase = {};
  const byKind = {};
  const byCode = {};
  for (const row of failed) {
    const task = row?.task ?? row;
    const phase = task.failurePhase ?? "unknown";
    const kind = task.failureKind ?? "unknown";
    const code = task.errorCode ?? null;
    byPhase[phase] = (byPhase[phase] ?? 0) + 1;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (code) byCode[code] = (byCode[code] ?? 0) + 1;
  }
  const topPhase = Object.entries(byPhase).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const topKind = Object.entries(byKind).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    total: failed.length,
    byPhase,
    byKind,
    byCode,
    topPhase,
    topKind,
    triage: topPhase && topKind ? `dominant failure: ${topPhase}/${topKind}` : "no failures"
  };
}
