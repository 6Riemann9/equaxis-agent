/**
 * Task artifacts: what a teammate actually changed in its workspace.
 *
 * A task result is text; the deliverable is usually a file. This module
 * captures a before/after view of the workspace so a finished task can say
 * "2 added, 1 modified" and show a real diff instead of a claim.
 *
 * Design constraints:
 *   - bounded: snapshots cap the file count, and only small text files are
 *     copied into the baseline directory (a binary blob is listed, not copied)
 *   - no trust in paths: every artifact path is resolved and re-checked to be
 *     inside the workspace, so a symlink or "../" cannot escape on read
 *   - no git required: diffs are computed with a small LCS over lines, and
 *     large or binary files report a size change instead of a fake diff
 *
 * Layout: <rootDir>/artifacts/<taskId>/manifest.json + before/<relPath>
 */

import fs from "node:fs";
import path from "node:path";

/** Directories that are never part of a teammate's deliverable. */
const IGNORED_DIRS = new Set([".git", "node_modules", ".next", "__pycache__", ".venv", "dist", "build"]);

export const SNAPSHOT_LIMITS = {
  maxFiles: 2000,
  maxBaselineBytes: 64 * 1024,
  maxDiffBytes: 256 * 1024,
  listedArtifacts: 200
};

function isTextName(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return new Set([
    ".txt", ".md", ".json", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".html",
    ".yml", ".yaml", ".toml", ".ini", ".cfg", ".sh", ".py", ".rb", ".go", ".rs", ".java",
    ".c", ".h", ".cpp", ".sql", ".env", ".log", ".csv", ".xml", ".svg"
  ]).has(ext);
}

/**
 * Snapshot a workspace: relative path -> { size, mtimeMs }.
 * Symlinks are recorded but never followed (a follow could escape the tree).
 */
export function snapshotWorkspace(workspaceDir, { maxFiles = SNAPSHOT_LIMITS.maxFiles } = {}) {
  const files = new Map();
  const root = path.resolve(workspaceDir);
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.size >= maxFiles) return;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(absolute);
        continue;
      }
      const relPath = path.relative(root, absolute).split(path.sep).join("/");
      try {
        const stat = fs.lstatSync(absolute);
        files.set(relPath, { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), symlink: entry.isSymbolicLink() });
      } catch {
        // a file that vanished mid-walk is simply not part of the snapshot
      }
    }
  };
  walk(root);
  return files;
}

/** Copy small text files into the baseline dir so a real diff is possible. */
function copyBaseline(root, beforeDir, snapshot) {
  for (const [relPath, info] of snapshot) {
    if (info.symlink) continue;
    if (info.size > SNAPSHOT_LIMITS.maxBaselineBytes) continue;
    if (!isTextName(relPath)) continue;
    const source = path.join(root, relPath);
    const target = path.join(beforeDir, relPath);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    } catch {
      // an unreadable file just means "no baseline"; the manifest still lists it
    }
  }
}

export function artifactDir(rootDir, taskId) {
  return path.join(rootDir, "artifacts", String(taskId).replace(/[^A-Za-z0-9-]/g, ""));
}

/**
 * Capture the pre-task state. Returns { files, takenAt } for later comparison;
 * the worker stores it next to the task so a crashed run leaves evidence.
 */
export function captureBaseline(rootDir, taskId, workspaceDir) {
  const dir = artifactDir(rootDir, taskId);
  const beforeDir = path.join(dir, "before");
  fs.rmSync(beforeDir, { recursive: true, force: true });
  fs.mkdirSync(beforeDir, { recursive: true });
  const snapshot = snapshotWorkspace(workspaceDir);
  copyBaseline(path.resolve(workspaceDir), beforeDir, snapshot);
  const record = { taskId, takenAt: new Date().toISOString(), files: [...snapshot.entries()] };
  fs.writeFileSync(path.join(dir, "baseline.json"), JSON.stringify(record), "utf8");
  return { dir, beforeDir, snapshot };
}

/** Compare against the baseline and write manifest.json. */
export function captureResult(rootDir, taskId, workspaceDir) {
  const dir = artifactDir(rootDir, taskId);
  const beforeDir = path.join(dir, "before");
  let before = new Map();
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dir, "baseline.json"), "utf8"));
    before = new Map(record.files ?? []);
  } catch {
    // no baseline (task started before artifacts existed): everything is "added"
  }
  const after = snapshotWorkspace(workspaceDir);
  const added = [];
  const modified = [];
  const deleted = [];

  for (const [relPath, info] of after) {
    const previous = before.get(relPath);
    if (!previous) {
      added.push({ path: relPath, size: info.size, diffable: isTextName(relPath) && info.size <= SNAPSHOT_LIMITS.maxDiffBytes });
      continue;
    }
    if (previous.size !== info.size || previous.mtimeMs !== info.mtimeMs) {
      const previousInBaseline = fs.existsSync(path.join(beforeDir, relPath));
      modified.push({
        path: relPath,
        size: info.size,
        previousSize: previous.size,
        diffable: previousInBaseline && isTextName(relPath) && info.size <= SNAPSHOT_LIMITS.maxDiffBytes
      });
    }
  }
  for (const [relPath, info] of before) {
    if (!after.has(relPath)) deleted.push({ path: relPath, size: info.size, previousSize: info.size });
  }

  const manifest = {
    taskId,
    workspace: path.resolve(workspaceDir),
    capturedAt: new Date().toISOString(),
    counts: { added: added.length, modified: modified.length, deleted: deleted.length },
    added: added.slice(0, SNAPSHOT_LIMITS.listedArtifacts),
    modified: modified.slice(0, SNAPSHOT_LIMITS.listedArtifacts),
    deleted: deleted.slice(0, SNAPSHOT_LIMITS.listedArtifacts),
    truncated: added.length + modified.length + deleted.length > SNAPSHOT_LIMITS.listedArtifacts
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

export function readManifest(rootDir, taskId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(artifactDir(rootDir, taskId), "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

export function readBaselineDir(rootDir, taskId) {
  return path.join(artifactDir(rootDir, taskId), "before");
}

/**
 * Resolve an artifact path for reading: it must be inside the workspace and
 * must appear in the manifest. Returns the absolute path or null.
 */
export function resolveArtifactFile({ rootDir, taskId, workspace, relPath }) {
  const manifest = readManifest(rootDir, taskId);
  if (!manifest) return null;
  const listed = [...manifest.added, ...manifest.modified, ...manifest.deleted].some((entry) => entry.path === relPath);
  if (!listed) return null;
  // The manifest records the workspace the worker actually used at capture
  // time; a caller's guess (derived from config today) may have drifted, so
  // the recorded path wins. Falling back to the caller keeps old manifests
  // readable.
  const root = path.resolve(manifest.workspace ?? workspace);
  const absolute = path.resolve(root, relPath);
  // Defense in depth: never serve something outside the workspace.
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return null;
  return absolute;
}

/** Longest-common-subsequence line diff, bounded and dependency-free. */
export function lineDiff(beforeText, afterText) {
  const a = beforeText.split("\n");
  const b = afterText.split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    return [{ type: "too-large", text: `cannot diff ${n}×${m} lines; showing sizes only` }];
  }
  const lengths = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "context", text: a[i] });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      out.push({ type: "removed", text: a[i] });
      i += 1;
    } else {
      out.push({ type: "added", text: b[j] });
      j += 1;
    }
  }
  while (i < n) { out.push({ type: "removed", text: a[i] }); i += 1; }
  while (j < m) { out.push({ type: "added", text: b[j] }); j += 1; }
  return out;
}

/** Build a diff for one artifact (added file = whole file as additions). */
export function artifactDiff({ rootDir, taskId, workspace, relPath }) {
  const absolute = resolveArtifactFile({ rootDir, taskId, workspace, relPath });
  if (!absolute) return { ok: false, error: "artifact not listed for this task" };
  let afterText = "";
  try {
    const stat = fs.statSync(absolute);
    if (stat.size > SNAPSHOT_LIMITS.maxDiffBytes) {
      return { ok: false, error: `file is too large to diff (${stat.size} bytes)` };
    }
    afterText = fs.readFileSync(absolute, "utf8");
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
  const baselinePath = path.join(readBaselineDir(rootDir, taskId), relPath);
  let beforeText = "";
  let mode = "added";
  if (fs.existsSync(baselinePath)) {
    try {
      beforeText = fs.readFileSync(baselinePath, "utf8");
      mode = "modified";
    } catch {
      mode = "modified";
    }
  }
  return { ok: true, path: relPath, mode, hunks: lineDiff(beforeText, afterText) };
}

/** One-line summary for a feed entry or notification. */
export function formatArtifactSummary(manifest) {
  if (!manifest) return "";
  const { added, modified, deleted } = manifest.counts;
  if (!added && !modified && !deleted) return "no files changed";
  const parts = [];
  if (added) parts.push(`${added} added`);
  if (modified) parts.push(`${modified} modified`);
  if (deleted) parts.push(`${deleted} deleted`);
  return `${parts.join(", ")}`;
}
