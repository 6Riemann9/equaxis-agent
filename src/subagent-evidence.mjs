/**
 * Default evidence verifier for subagent completion claims (Vero,
 * arXiv 2608.13522 audit principle: claims must be machine-checkable).
 *
 * Scans the subagent result for common artifact fields (path, file, artifact,
 * filePath, outputPath, files, artifacts) and verifies each value that looks
 * like a filesystem path exists relative to the workspace root. Non-path
 * values (URLs, inline content) are skipped. Verification is audit-only: an
 * unverified claim is flagged, never a run failure.
 */

import fs from "node:fs";
import path from "node:path";

const ARTIFACT_FIELDS = ["path", "file", "artifact", "filePath", "outputPath", "outputFile", "target", "output"];
const COLLECTION_FIELDS = ["files", "artifacts", "paths", "outputs", "created", "written"];

function looksLikePath(value) {
  return typeof value === "string" && value.length > 0 && value.length < 1024
    && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) // skip URLs
    && !value.startsWith("data:") // skip inline data URIs
    && !value.includes("\n");
}

function collectCandidates(result, out, seen) {
  if (!result || typeof result !== "object" || seen.has(result)) return;
  seen.add(result);
  if (Array.isArray(result)) {
    for (const item of result) collectCandidates(item, out, seen);
    return;
  }
  for (const [key, value] of Object.entries(result)) {
    if (COLLECTION_FIELDS.includes(key) && Array.isArray(value)) {
      for (const item of value) {
        if (looksLikePath(item)) out.push(item);
      }
    } else if (ARTIFACT_FIELDS.includes(key) && looksLikePath(value)) {
      out.push(value);
    } else if (typeof value === "object" && value !== null) {
      collectCandidates(value, out, seen);
    }
  }
}

/**
 * @param {{ projectRoot?: string }} options workspace root for relative paths
 * @returns {import("./subagent-runtime.mjs").VerifyEvidence}
 */
export function createFileEvidenceVerifier({ projectRoot } = {}) {
  const root = path.resolve(projectRoot ?? process.cwd());
  return async (_task, result) => {
    const candidates = [];
    collectCandidates(result, candidates, new Set());
    if (!candidates.length) return { ok: true, issues: [] };
    const issues = [];
    const verified = [];
    for (const candidate of candidates) {
      const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
      const exists = fs.existsSync(absolute);
      if (exists) verified.push(candidate);
      else issues.push(`claimed artifact not found: ${candidate}`);
    }
    return issues.length ? { ok: false, issues } : { ok: true, issues: [], verified };
  };
}
