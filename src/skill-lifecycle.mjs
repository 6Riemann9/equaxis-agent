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
  return String(value || "skill").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "skill";
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
    metadata: { skillName: skill.name, description: skill.description ?? "" }
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
