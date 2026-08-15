/**
 * Refine ledger (PrimeIntellect prime-agent Continual Harness /refine,
 * minimal slice).
 *
 * Self-improvement writes in Equaxis live in separate stores with separate
 * semantics (skills → versioned candidates, wisdom → immutable ring,
 * memory → dream promotion). This ledger is the single audit trail for
 * small evidence-backed refinement ops across *file-backed* kinds — notes,
 * prompt fragments, or any workspace file — each recorded with before/after
 * content snapshots and rolled back by id (prime-agent's /refine rollback
 * by recorded snapshot).
 *
 * Storage: append-only JSONL at <rootDir>/ledger.jsonl; content files land
 * under <rootDir>/notes|prompts|files/<target> so rollback never needs to
 * re-derive state.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const REFINE_LEDGER_SCHEMA_VERSION = 1;
export const REFINE_KINDS = Object.freeze(["note", "prompt", "file"]);
export const REFINE_ACTIONS = Object.freeze(["create", "update", "delete", "rollback"]);
const KIND_DIRS = Object.freeze({ note: "notes", prompt: "prompts", file: "files" });

function assertWorkspacePath(projectRoot, targetPath, label) {
  const relativePath = path.relative(path.resolve(projectRoot), path.resolve(targetPath));
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must stay inside the project root: ${relativePath}`);
  }
}

export function refineLedgerPath(projectRoot, rootDir) {
  return path.join(path.resolve(projectRoot), rootDir, "ledger.jsonl");
}

function safeRefineTarget(target) {
  const safe = String(target ?? "").replace(/^[/\\]+|[/\\]+$/g, "").replaceAll("\\", "/");
  if (!safe || safe.includes("..")) throw new Error(`invalid refine target: ${target}`);
  return safe;
}

/** Workspace-relative target for a kind: <kindDir>/<target>. */
export function refineTargetPath(projectRoot, rootDir, kind, target) {
  if (!REFINE_KINDS.includes(kind)) throw new Error(`invalid refine kind: ${kind}`);
  const safe = safeRefineTarget(target);
  return path.join(path.resolve(projectRoot), rootDir, KIND_DIRS[kind], ...safe.split("/"));
}

export function loadRefineLedger(filePath) {
  let records = [];
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // skip a corrupt line rather than failing the whole ledger
      }
    }
  } catch {
    return [];
  }
  return records;
}

function appendRecord(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function readFileOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Apply a refinement op and record it. `content` replaces the target for
 * create/update; `delete` removes the target. Every op snapshots before and
 * after, so rollbackRefine restores exactly.
 *
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} [options.rootDir]
 * @param {"note"|"prompt"|"file"} options.kind
 * @param {"create"|"update"|"delete"} options.action
 * @param {string} options.target relative path inside the kind directory
 * @param {string} [options.content] new content (required for create/update)
 * @param {string[]} [options.evidence] evidence links for the op
 * @param {() => string} [options.now]
 */
export function recordRefine({ projectRoot, rootDir = ".pi/runtime/refine", kind, action, target, content = "", evidence = [], now = () => new Date().toISOString() } = {}) {
  if (!REFINE_KINDS.includes(kind)) throw new Error(`invalid refine kind: ${kind}`);
  if (!REFINE_ACTIONS.slice(0, 3).includes(action)) throw new Error(`invalid refine action: ${action}`);
  const projectRootResolved = path.resolve(projectRoot);
  const ledgerFile = refineLedgerPath(projectRootResolved, rootDir);
  const safeTarget = safeRefineTarget(target);
  const targetPath = refineTargetPath(projectRootResolved, rootDir, kind, safeTarget);
  assertWorkspacePath(projectRootResolved, targetPath, "refine target");

  const before = readFileOrNull(targetPath);
  if (action === "create" && before !== null) throw new Error(`refine create refused: target already exists (use update): ${safeTarget}`);
  if (action === "update" && before === null) throw new Error(`refine update refused: target does not exist (use create): ${safeTarget}`);
  if (action === "delete" && before === null) throw new Error(`refine delete refused: target does not exist: ${safeTarget}`);
  if (action !== "delete" && !String(content ?? "")) throw new Error(`refine ${action} requires content`);

  const record = {
    id: `refine-${randomUUID()}`,
    schemaVersion: REFINE_LEDGER_SCHEMA_VERSION,
    at: now(),
    kind,
    action,
    rootDir: rootDir,
    target: safeTarget,
    before: action === "create" ? null : before,
    after: action === "delete" ? null : String(content),
    evidence: [...(evidence ?? [])].map(String),
    rolledBackAt: null
  };

  if (action === "delete") {
    fs.rmSync(targetPath, { force: true });
  } else {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, String(content), "utf8");
  }
  appendRecord(ledgerFile, record);
  return record;
}

/**
 * @param {{ projectRoot: string; rootDir?: string; kind?: string; limit?: number }} options
 */
export function listRefines({ projectRoot, rootDir = ".pi/runtime/refine", kind, limit = 50 } = {}) {
  const records = loadRefineLedger(refineLedgerPath(projectRoot, rootDir));
  const filtered = kind ? records.filter((record) => record.kind === kind) : records;
  return filtered.slice(-limit).reverse();
}

/**
 * Roll back a refinement by id: restore the recorded `before` snapshot
 * (create → delete the file; update/delete → rewrite previous content) and
 * append a rollback marker. A rolled-back record cannot roll back twice.
 *
 * @param {string} id
 * @param {{ projectRoot: string; rootDir?: string; now?: () => string }} options
 */
export function rollbackRefine(id, { projectRoot, rootDir = ".pi/runtime/refine", now = () => new Date().toISOString() } = {}) {
  const projectRootResolved = path.resolve(projectRoot);
  const ledgerFile = refineLedgerPath(projectRootResolved, rootDir);
  const records = loadRefineLedger(ledgerFile);
  const record = records.find((entry) => entry.id === id);
  if (!record) throw new Error(`no refine record: ${id}`);
  const alreadyRolledBack = records.some((entry) => entry.action === "rollback" && entry.ref === id);
  if (alreadyRolledBack) throw new Error(`refine record already rolled back: ${id}`);

  const targetPath = refineTargetPath(projectRootResolved, record.rootDir ?? rootDir, record.kind, record.target);
  assertWorkspacePath(projectRootResolved, targetPath, "refine rollback target");
  const current = readFileOrNull(targetPath);
  if (record.before === null) {
    fs.rmSync(targetPath, { force: true });
  } else {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, record.before, "utf8");
  }
  record.rolledBackAt = now();
  record.rolledBackFrom = current;
  appendRecord(ledgerFile, {
    id: `refine-${randomUUID()}`,
    schemaVersion: REFINE_LEDGER_SCHEMA_VERSION,
    at: record.rolledBackAt,
    kind: record.kind,
    action: "rollback",
    target: record.target,
    ref: record.id,
    before: current,
    after: record.before,
    evidence: [],
    rolledBackAt: null
  });
  return record;
}
