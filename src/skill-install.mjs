/**
 * Remote skill install (google/skills "skills add <owner>/<repo>" pattern).
 *
 * Fetches a SKILL.md package from a GitHub repository (raw.githubusercontent,
 * branch-agnostic with main→master fallback), normalizes it into a skill
 * candidate, and pushes it through the existing versioned lifecycle
 * (createSkillCandidate → delete-only review gate → apply), so remote
 * installs get the same audit/rollback trail as locally learned skills.
 *
 * The ref grammar is `owner/repo[/path/to/skill-dir]` or a full
 * github.com URL. A bare `owner/repo` without a path is rejected: locating
 * SKILL.md without a path needs the GitHub API (rate-limited) — the path
 * form is deterministic and sufficient (google/skills layout is
 * skills/<category>/<skill-name>/SKILL.md).
 */

import path from "node:path";
import { createSkillCandidate, applySkillCandidateGuarded } from "./skill-lifecycle.mjs";
import { parseSkillFile } from "./skill-store.mjs";

const RAW_BASE = "https://raw.githubusercontent.com";
const GITHUB_WEB_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/[^/]+)?(?:\/(.+))?$/i;
const MAX_DEFAULT_BYTES = 512 * 1024;
const TIMEOUT_DEFAULT_MS = 15000;

/**
 * Parse a skill install ref into { owner, repo, path }.
 * Accepts `owner/repo`, `owner/repo/path/to/skill`, and github.com URLs.
 * Returns null for anything malformed.
 */
export function parseGitHubSkillRef(ref) {
  const raw = String(ref ?? "").trim();
  if (!raw) return null;
  const webMatch = GITHUB_WEB_RE.exec(raw);
  if (webMatch) {
    const owner = webMatch[1];
    const repo = webMatch[2].replace(/\.git$/, "");
    const skillPath = (webMatch[3] ?? "").replace(/^\/+|\/+$/g, "");
    if (!owner || !repo) return null;
    return { owner, repo, path: skillPath || null };
  }
  const parts = raw.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (parts.some((part) => part === "." || part === "..")) return null;
  const [owner, repo, ...rest] = parts;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return { owner, repo, path: rest.length ? rest.join("/") : null };
}

/** raw.githubusercontent URL for <path>/SKILL.md on the given branch. */
export function skillRawUrl({ owner, repo, path: skillPath, branch = "main" }) {
  if (!owner || !repo) throw new Error("owner and repo are required");
  if (!skillPath) throw new Error("a skill directory path is required (ref form: owner/repo/path/to/skill)");
  const safePath = String(skillPath).replace(/^\/+|\/+$/g, "");
  const safeBranch = String(branch).replace(/[^A-Za-z0-9._-]/g, "");
  return `${RAW_BASE}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(safeBranch)}/${safePath.split("/").map(encodeURIComponent).join("/")}/SKILL.md`;
}

/**
 * Fetch a SKILL.md over HTTP with timeout and size caps. Injectable
 * fetchImpl for tests; returns the response text or throws.
 */
export async function fetchSkillMarkdown(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_DEFAULT_MS, maxBytes = MAX_DEFAULT_BYTES } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
  } catch (error) {
    throw new Error(`skill fetch failed: ${String(error?.message ?? error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`skill fetch failed: HTTP ${response.status} for ${url}`);
  }
  const declared = Number(response.headers?.get?.("content-length") ?? 0);
  if (declared > maxBytes) throw new Error(`skill too large: ${declared} bytes > ${maxBytes}`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`skill too large: ${Buffer.byteLength(text, "utf8")} bytes > ${maxBytes}`);
  if (!text.trim()) throw new Error(`skill fetch returned empty content for ${url}`);
  return text;
}

function safeSkillName(value) {
  return String(value ?? "skill").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().replace(/^\.+$/, "skill") || "skill";
}

/**
 * Normalize fetched SKILL.md into an installable skill. The frontmatter is
 * parsed with the standard parser (metadata passthrough), the name is
 * sanitized to the on-disk convention, and provenance pins the source repo.
 */
export function buildInstallSkill({ raw, ref }) {
  const parsed = parseSkillFile(raw, "remote/SKILL.md");
  const name = safeSkillName(parsed.name);
  if (!name) throw new Error("remote SKILL.md has no usable name");
  return {
    name,
    description: String(parsed.description ?? ""),
    triggers: Array.isArray(parsed.triggers) ? parsed.triggers : [],
    body: String(parsed.body ?? ""),
    category: String(parsed.category ?? ""),
    dontUse: String(parsed.dontUse ?? ""),
    related: Array.isArray(parsed.related) ? parsed.related : [],
    source: `github:${ref}`,
    evidence: [`github:${ref}`]
  };
}

/**
 * Install a skill from GitHub through the versioned lifecycle:
 * fetch → normalize → candidate → delete-only review gate → deploy.
 * Returns the applied artifact plus the fetched URL.
 */
export async function installSkillFromGithub({ projectRoot, skillsDir = ".pi/skills", ref, branch = "main", fetchImpl = fetch, timeoutMs = TIMEOUT_DEFAULT_MS }) {
  const parsed = parseGitHubSkillRef(ref);
  if (!parsed) throw new Error(`invalid skill ref: ${ref} (expected owner/repo/path/to/skill)`);
  const url = skillRawUrl({ ...parsed, branch });
  let raw;
  try {
    raw = await fetchSkillMarkdown(url, { fetchImpl, timeoutMs });
  } catch (error) {
    // main → master fallback for repos whose default branch differs
    if (branch !== "master") {
      const masterUrl = skillRawUrl({ ...parsed, branch: "master" });
      raw = await fetchSkillMarkdown(masterUrl, { fetchImpl, timeoutMs });
      return finish(parsed, raw, masterUrl);
    }
    throw error;
  }
  return finish(parsed, raw, url);

  function finish(refParts, markdown, sourceUrl) {
    const skill = buildInstallSkill({ raw: markdown, ref: `${refParts.owner}/${refParts.repo}/${refParts.path}` });
    const candidate = createSkillCandidate({
      projectRoot,
      skillsDir,
      skill,
      provenance: { source: skill.source },
      evidence: [sourceUrl]
    });
    const applied = applySkillCandidateGuarded({ projectRoot, skillsDir, id: candidate.id });
    const skillPath = path.join(path.resolve(projectRoot), skillsDir, skill.name, "SKILL.md");
    return { name: skill.name, candidateId: candidate.id, status: applied.status, path: skillPath, sourceUrl };
  }
}
