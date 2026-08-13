/**
 * Web approval bridge for the reliability harness.
 *
 * High-risk tool calls in headless sessions (pi-web-driven, subagents,
 * --mode json) currently get blocked because there is no TUI to confirm them.
 * This module persists approval requests as files and lets a web panel write
 * decisions back; the harness polls for the decision while the request is
 * pending.
 *
 * Layout (under the reliability trace dir):
 *   approvals/requests/<requestId>.json   { requestId, toolName, summary, reason, requestedAt }
 *   approvals/decisions/<requestId>.json  { requestId, decision: "approve" | "deny", decidedAt }
 */

import fs from "node:fs";
import path from "node:path";

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function approvalRoot(projectRoot, traceDir = ".pi/runtime") {
  return path.join(projectRoot, traceDir, "approvals");
}

export function approvalRequestPath(root, requestId) {
  return path.join(root, "requests", `${safeId(requestId)}.json`);
}

export function approvalDecisionPath(root, requestId) {
  return path.join(root, "decisions", `${safeId(requestId)}.json`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(path.join(dir, name)))
    .filter(Boolean);
}

export function writeApprovalRequest(projectRoot, traceDir, request) {
  const root = approvalRoot(projectRoot, traceDir);
  fs.mkdirSync(path.join(root, "requests"), { recursive: true });
  const filePath = approvalRequestPath(root, request.requestId);
  fs.writeFileSync(filePath, JSON.stringify({
    requestId: request.requestId,
    toolName: request.toolName,
    summary: request.summary ?? "",
    reason: request.reason ?? "",
    requestedAt: new Date().toISOString()
  }, null, 2), "utf8");
  return filePath;
}

export function writeApprovalDecision(projectRoot, traceDir, requestId, decision) {
  if (decision !== "approve" && decision !== "deny") throw new Error("decision must be approve or deny");
  const root = approvalRoot(projectRoot, traceDir);
  fs.mkdirSync(path.join(root, "decisions"), { recursive: true });
  const filePath = approvalDecisionPath(root, requestId);
  fs.writeFileSync(filePath, JSON.stringify({ requestId, decision, decidedAt: new Date().toISOString() }, null, 2), "utf8");
  return filePath;
}

/** Pending requests = requests without a decision file. */
export function listPendingApprovals(projectRoot, traceDir = ".pi/runtime", maxAgeMs = 10 * 60 * 1000) {
  const root = approvalRoot(projectRoot, traceDir);
  const pending = [];
  for (const request of listJson(path.join(root, "requests"))) {
    if (!request?.requestId) continue;
    if (fs.existsSync(approvalDecisionPath(root, request.requestId))) continue;
    const ageMs = Date.now() - new Date(request.requestedAt ?? 0).getTime();
    if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) continue;
    pending.push({ ...request, ageMs });
  }
  return pending.sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
}

/** All decisions, newest first (history for the web panel). */
export function listApprovalHistory(projectRoot, traceDir = ".pi/runtime", limit = 50) {
  const root = approvalRoot(projectRoot, traceDir);
  return listJson(path.join(root, "decisions"))
    .filter((entry) => entry?.requestId && (entry.decision === "approve" || entry.decision === "deny"))
    .sort((left, right) => String(right.decidedAt ?? "").localeCompare(String(left.decidedAt ?? "")))
    .slice(0, limit);
}

export function readApprovalDecision(projectRoot, traceDir, requestId) {
  return readJson(approvalDecisionPath(approvalRoot(projectRoot, traceDir), requestId));
}

/** Remove stale request files (decided or expired). Call at session start. */
export function cleanupApprovals(projectRoot, traceDir = ".pi/runtime", maxAgeMs = 10 * 60 * 1000) {
  const root = approvalRoot(projectRoot, traceDir);
  const requestsDir = path.join(root, "requests");
  if (!fs.existsSync(requestsDir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(requestsDir)) {
    if (!name.endsWith(".json")) continue;
    const requestId = name.slice(0, -5);
    const filePath = path.join(requestsDir, name);
    const decided = fs.existsSync(approvalDecisionPath(root, requestId));
    const request = readJson(filePath);
    const ageMs = request?.requestedAt ? Date.now() - new Date(request.requestedAt).getTime() : Infinity;
    if (decided || !Number.isFinite(ageMs) || ageMs > maxAgeMs) {
      try {
        fs.unlinkSync(filePath);
        removed += 1;
      } catch {
        // best effort
      }
    }
  }
  return removed;
}
