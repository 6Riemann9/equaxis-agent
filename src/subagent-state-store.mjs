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
    error: task.error
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
