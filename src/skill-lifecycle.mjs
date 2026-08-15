import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { serializeSkill } from "./skill-store.mjs";
import { VersionStore } from "./version-store.mjs";

function assertInside(root, target, label) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay inside the workspace: ${relative}`);
}

function safeName(value) {
  const cleaned = String(value || "skill").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "skill";
  // Reject dot-only names: "." and ".." would resolve outside the skills dir.
  return cleaned.replace(/^\.+$/, "skill") || "skill";
}

function hashText(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function skillPath(projectRoot, skillsDir, name) {
  const dir = path.resolve(projectRoot, skillsDir ?? ".pi/skills", safeName(name));
  assertInside(projectRoot, dir, "skill path");
  return path.join(dir, "SKILL.md");
}

function storeFor(options) {
  return options.store ?? new VersionStore({ projectRoot: options.projectRoot, rootDir: options.versionRootDir });
}

export function createSkillCandidate(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const skill = options.skill ?? {};
  const id = options.id ?? `${safeName(skill.name)}-${new Date().toISOString().replaceAll(":", "-")}`;
  const filePath = skillPath(projectRoot, options.skillsDir, skill.name);
  const previousContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  const content = serializeSkill(skill);
  return storeFor({ ...options, projectRoot }).writeCandidate({
    kind: "skill",
    id,
    version: { kind: "skill", id, sha: hashText(content) },
    status: "candidate",
    provenance: options.provenance ?? {},
    changes: [{
      path: path.relative(projectRoot, filePath).replaceAll("\\", "/"),
      op: previousContent === null ? "create" : "update",
      content,
      contentSha: hashText(content),
      previousContent,
      previousSha: previousContent === null ? null : hashText(previousContent)
    }],
    metadata: { skillName: skill.name, description: skill.description ?? "", evidence: options.evidence ?? skill.evidence ?? [] }
  });
}

export function applySkillCandidate(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const store = storeFor({ ...options, projectRoot });
  const artifact = store.read("skill", options.id);
  if (artifact.kind !== "skill") throw new Error(`not a skill candidate: ${options.id}`);
  const change = artifact.changes?.[0];
  if (!change?.content) throw new Error(`skill candidate has no content: ${options.id}`);
  const filePath = path.resolve(projectRoot, change.path);
  assertInside(projectRoot, filePath, "skill path");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, change.content, "utf8");
  return store.updateStatus("skill", artifact.id, "deployed", { decision: options.decision ?? { action: "deploy", reason: "applied skill candidate" } });
}

export function rollbackSkillCandidate(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const store = storeFor({ ...options, projectRoot });
  const artifact = store.read("skill", options.id);
  const change = artifact.changes?.[0];
  if (!change) throw new Error(`skill candidate has no changes: ${options.id}`);
  const filePath = path.resolve(projectRoot, change.path);
  assertInside(projectRoot, filePath, "skill path");
  if (change.previousContent === null || change.previousContent === undefined) {
    fs.rmSync(filePath, { force: true });
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, change.previousContent, "utf8");
  }
  return store.updateStatus("skill", artifact.id, "rolled_back", { decision: options.decision ?? { action: "rollback", reason: "restored previous skill content" } });
}

/**
 * 写前审查门 — "只删不增" (delete-only hardening).
 *
 * PracticeUnsafe (arXiv 2608.12851) shows self-improving agents固化 unsafe
 * successes into skill files that get reused across sessions; its SAFEEVOLVE
 * wrapper hardens by *deletion* only. This review compares a skill candidate
 * against the previous deployed content and verifies that any net-new body
 * lines are covered by the candidate's evidence trail. A candidate that adds
 * unreviewed procedure lines (or silently rewrites existing guidance) must not
 * be deployed without an explicit approval decision.
 */
export function reviewSkillCandidate(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const store = storeFor({ ...options, projectRoot });
  const artifact = store.read("skill", options.id);
  if (artifact.kind !== "skill") throw new Error(`not a skill candidate: ${options.id}`);
  const change = artifact.changes?.[0];
  if (!change) throw new Error(`skill candidate has no changes: ${options.id}`);

  const previous = String(change.previousContent ?? "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  const current = String(change.content ?? "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  const prevSet = new Set(previous);
  const addedLines = current.filter((line) => !prevSet.has(line));
  const evidence = Array.isArray(artifact.metadata?.evidence) ? artifact.metadata.evidence
    : Array.isArray(options.evidence) ? options.evidence : [];

  let verdict = "pass";
  let reason = "create or delete-only change";
  if (change.previousContent !== null && addedLines.length > 0 && evidence.length === 0) {
    // Update that adds content without any evidence trail: needs explicit review.
    verdict = "needs_review";
    reason = `${addedLines.length} net-new line(s) with no evidence trail (delete-only hardening)`;
  }
  const review = { verdict, reason, addedLines, removedLines: previous.filter((line) => !new Set(current).has(line)), reviewedAt: new Date().toISOString() };
  store.updateStatus("skill", artifact.id, "reviewed", { decision: { action: "review", verdict, reason } });
  return { ...review, artifactId: artifact.id };
}

/** Apply a skill candidate; refuses deployment when a review gate exists and fails. */
export function applySkillCandidateGuarded(options = {}) {
  const review = reviewSkillCandidate(options);
  if (review.verdict === "needs_review" && options.requireReview !== false) {
    const error = new Error(`skill candidate ${review.artifactId} blocked by delete-only review gate: ${review.reason}`);
    error.code = "SKILL_REVIEW_BLOCKED";
    throw error;
  }
  return applySkillCandidate({ ...options, decision: { action: "deploy", reason: `reviewed: ${review.reason}` } });
}

/**
 * 证据驱动退役 — retire (not delete) a skill.
 *
 * A skill is retired by flipping `retired: true` in its frontmatter with an
 * evidence-backed reason; content is preserved for audit (delete-only principle:
 * never silently rewrite what the agent learned). Retired skills are excluded
 * from context injection by selectRelevantSkills.
 */
export function retireSkill(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const filePath = skillPath(projectRoot, options.skillsDir, options.name);
  assertInside(projectRoot, filePath, "skill path");
  if (!fs.existsSync(filePath)) throw new Error(`skill not found: ${options.name}`);
  const existing = fs.readFileSync(filePath, "utf8");
  const reason = String(options.reason ?? "retired by evidence-driven governance").replace(/\n/g, " ");
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(existing);
  let content;
  if (!fmMatch) {
    content = `---\nretired: true\nretiredReason: ${reason}\n---\n\n${existing.trim()}\n`;
  } else {
    const lines = fmMatch[1].split(/\r?\n/).filter((line) => line.trim().length > 0);
    const kept = lines.filter((line) => !/^(retired|retiredReason):/i.test(line.trim()));
    kept.push("retired: true", `retiredReason: ${reason}`);
    content = `---\n${kept.join("\n")}\n---\n${existing.slice(fmMatch[0].length)}`;
  }
  fs.writeFileSync(filePath, content, "utf8");
  const id = options.id ?? `${safeName(options.name)}-${new Date().toISOString().replaceAll(":", "-")}`;
  return storeFor({ ...options, projectRoot }).writeCandidate({
    kind: "skill_retirement",
    id,
    version: { kind: "skill", id, sha: hashText(content) },
    status: "retired",
    provenance: options.provenance ?? { source: "skill_governance" },
    changes: [{
      path: path.relative(projectRoot, filePath).replaceAll("\\", "/"),
      op: "retire",
      content,
      contentSha: hashText(content),
      previousContent: existing,
      previousSha: hashText(existing)
    }],
    metadata: { skillName: options.name, reason }
  });
}
