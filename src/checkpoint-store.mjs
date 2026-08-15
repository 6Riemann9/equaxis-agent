/**
 * Tool-level checkpoints (Claude Code / omp inspiration).
 *
 * Before a mutating tool (write/edit) executes, the target files are backed
 * up to .pi/runtime/checkpoints/<id>/ preserving their relative layout.
 * /equaxis-checkpoint restore <id> rewinds the workspace to that snapshot.
 *
 * Audit-oriented: checkpoints are immutable once written; retention is a
 * simple ring (newest K). No kernel involvement — the harness layer owns it.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
}

export function checkpointRoot(projectRoot, traceDir = ".pi/runtime") {
  return path.join(projectRoot, traceDir, "checkpoints");
}

export function checkpointDir(root, id) {
  return path.join(root, safeSegment(id));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Snapshot the given absolute file paths (must exist) under a checkpoint id.
 * Returns { id, files, createdAt } with the files copied into the store.
 */
export function createCheckpoint({ projectRoot, id, files, traceDir = ".pi/runtime", reason = "" }) {
  const root = checkpointRoot(projectRoot, traceDir);
  const target = checkpointDir(root, id);
  if (fs.existsSync(target)) throw new Error(`checkpoint already exists: ${id}`);
  fs.mkdirSync(target, { recursive: true });
  const projectRootResolved = path.resolve(projectRoot);
  const copied = [];
  for (const filePath of files) {
    const absolute = path.resolve(filePath);
    if (!absolute.startsWith(projectRootResolved)) continue; // never snapshot outside the workspace
    if (!fs.existsSync(absolute)) continue;
    const relative = path.relative(projectRootResolved, absolute);
    const dest = path.join(target, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(absolute, dest);
    copied.push(relative.replaceAll("\\", "/"));
  }
  if (!copied.length) {
    fs.rmSync(target, { recursive: true, force: true });
    return { id, files: [], createdAt: new Date().toISOString(), skipped: true };
  }
  const meta = { id, files: copied, reason, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(target, ".checkpoint.json"), JSON.stringify(meta, null, 2), "utf8");
  pruneCheckpoints(projectRoot, traceDir);
  return meta;
}

/** List checkpoints newest first. */
export function listCheckpoints(projectRoot, traceDir = ".pi/runtime", limit = 20) {
  const root = checkpointRoot(projectRoot, traceDir);
  if (!fs.existsSync(root)) return [];
  const entries = [];
  for (const name of fs.readdirSync(root)) {
    const meta = readJson(path.join(root, name, ".checkpoint.json"));
    if (!meta?.id) continue;
    entries.push({ id: meta.id, files: meta.files ?? [], reason: meta.reason ?? "", createdAt: meta.createdAt });
  }
  return entries
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

/** Restore a checkpoint's files back into the workspace. Returns restored paths. */
export function restoreCheckpoint({ projectRoot, id, traceDir = ".pi/runtime" }) {
  const root = checkpointRoot(projectRoot, traceDir);
  const source = checkpointDir(root, id);
  const meta = readJson(path.join(source, ".checkpoint.json"));
  if (!meta?.id) throw new Error(`checkpoint not found: ${id}`);
  const projectRootResolved = path.resolve(projectRoot);
  const restored = [];
  for (const relative of meta.files) {
    const srcFile = path.join(source, relative);
    const destFile = path.resolve(projectRootResolved, relative);
    if (!destFile.startsWith(projectRootResolved)) continue;
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(srcFile, destFile);
    restored.push(relative);
  }
  return { id, restored, restoredAt: new Date().toISOString() };
}

/** Keep at most `keep` checkpoints; oldest removed. Returns removed ids. */
export function pruneCheckpoints(projectRoot, traceDir = ".pi/runtime", keep = 20) {
  const root = checkpointRoot(projectRoot, traceDir);
  if (!fs.existsSync(root)) return [];
  const entries = listCheckpoints(projectRoot, traceDir, keep + 100);
  const removed = [];
  for (const entry of entries.slice(keep)) {
    try {
      fs.rmSync(checkpointDir(root, entry.id), { recursive: true, force: true });
      removed.push(entry.id);
    } catch {
      // best effort
    }
  }
  return removed;
}

/** Stable checkpoint id for a tool call: sha256(toolCallId)[:12]. */
export function checkpointIdFor(toolCallId) {
  return crypto.createHash("sha256").update(String(toolCallId ?? "unknown")).digest("hex").slice(0, 12);
}
