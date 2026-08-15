import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInstallSkill,
  fetchSkillMarkdown,
  installSkillFromGithub,
  parseGitHubSkillRef,
  skillRawUrl
} from "../src/skill-install.mjs";
import { loadSkillsFromDirectory } from "../src/skill-store.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-skill-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const REMOTE_SKILL_MD = `---
name: BigQuery Basics
description: Query BigQuery datasets efficiently
category: data
dontUse: Use this for fully-managed RAG
related: [bigquery-ai-ml]
triggers: [bigquery, sql]
---

# BigQuery

Run cost-efficient queries.
`;

test("parseGitHubSkillRef accepts owner/repo, paths and web URLs", () => {
  assert.deepEqual(parseGitHubSkillRef("google/skills/skills/cloud/bigquery-basics"), { owner: "google", repo: "skills", path: "skills/cloud/bigquery-basics" });
  assert.deepEqual(parseGitHubSkillRef("google/skills"), { owner: "google", repo: "skills", path: null });
  assert.deepEqual(parseGitHubSkillRef("https://github.com/google/skills/tree/main/skills/cloud/bigquery-basics"), { owner: "google", repo: "skills", path: "skills/cloud/bigquery-basics" });
  assert.deepEqual(parseGitHubSkillRef("https://github.com/a/b"), { owner: "a", repo: "b", path: null });
  assert.equal(parseGitHubSkillRef(""), null);
  assert.equal(parseGitHubSkillRef("just-one"), null);
  assert.equal(parseGitHubSkillRef("owner/../evil"), null);
  assert.equal(parseGitHubSkillRef("https://example.com/not-github/x/y"), null);
});

test("skillRawUrl builds deterministic raw URLs and rejects bare refs", () => {
  assert.equal(
    skillRawUrl({ owner: "google", repo: "skills", path: "skills/cloud/bigquery-basics" }),
    "https://raw.githubusercontent.com/google/skills/main/skills/cloud/bigquery-basics/SKILL.md"
  );
  assert.equal(
    skillRawUrl({ owner: "a", repo: "b", path: "p/q", branch: "master" }),
    "https://raw.githubusercontent.com/a/b/master/p/q/SKILL.md"
  );
  assert.throws(() => skillRawUrl({ owner: "a", repo: "b", path: null }), /skill directory path is required/);
  assert.throws(() => skillRawUrl({ owner: "", repo: "b", path: "p" }), /owner and repo are required/);
});

test("fetchSkillMarkdown enforces status, size caps and timeout", async () => {
  const ok = async (url) => new Response("# Skill\n\nbody", { status: 200, headers: { "content-length": "12" } });
  assert.equal(await fetchSkillMarkdown("https://x/SKILL.md", { fetchImpl: ok }), "# Skill\n\nbody");

  const notFound = async () => new Response("nope", { status: 404 });
  await assert.rejects(() => fetchSkillMarkdown("https://x/SKILL.md", { fetchImpl: notFound }), /HTTP 404/);

  const oversize = async () => new Response("x".repeat(1000), { status: 200, headers: { "content-length": "1000" } });
  await assert.rejects(() => fetchSkillMarkdown("https://x/SKILL.md", { fetchImpl: oversize, maxBytes: 100 }), /too large/);

  const throws = async () => { throw new Error("network down"); };
  await assert.rejects(() => fetchSkillMarkdown("https://x/SKILL.md", { fetchImpl: throws }), /skill fetch failed/);

  const empty = async () => new Response("   ", { status: 200 });
  await assert.rejects(() => fetchSkillMarkdown("https://x/SKILL.md", { fetchImpl: empty }), /empty content/);
});

test("buildInstallSkill normalizes metadata and provenance", () => {
  const skill = buildInstallSkill({ raw: REMOTE_SKILL_MD, ref: "google/skills/skills/cloud/bigquery-basics" });
  assert.equal(skill.name, "bigquery-basics");
  assert.equal(skill.category, "data");
  assert.equal(skill.dontUse, "Use this for fully-managed RAG");
  assert.deepEqual(skill.related, ["bigquery-ai-ml"]);
  assert.deepEqual(skill.triggers, ["bigquery", "sql"]);
  assert.equal(skill.source, "github:google/skills/skills/cloud/bigquery-basics");
  assert.deepEqual(skill.evidence, ["github:google/skills/skills/cloud/bigquery-basics"]);
});

test("installSkillFromGithub installs through the versioned lifecycle", async (t) => {
  const root = workspace(t);
  let requested = null;
  const fetchImpl = async (url) => {
    requested = url;
    return new Response(REMOTE_SKILL_MD, { status: 200 });
  };
  const result = await installSkillFromGithub({ projectRoot: root, skillsDir: ".pi/skills", ref: "google/skills/skills/cloud/bigquery-basics", fetchImpl });
  assert.equal(requested, "https://raw.githubusercontent.com/google/skills/main/skills/cloud/bigquery-basics/SKILL.md");
  assert.equal(result.name, "bigquery-basics");
  assert.equal(result.status, "deployed");
  assert.equal(result.candidateId.includes("bigquery-basics"), true);

  const installed = loadSkillsFromDirectory(path.join(root, ".pi", "skills"));
  assert.equal(installed.length, 1);
  assert.equal(installed[0].name, "bigquery-basics");
  assert.equal(installed[0].category, "data");
  assert.equal(installed[0].source, "github:google/skills/skills/cloud/bigquery-basics");
});

test("installSkillFromGithub falls back to master branch", async (t) => {
  const root = workspace(t);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/main/")) return new Response("nope", { status: 404 });
    return new Response(REMOTE_SKILL_MD, { status: 200 });
  };
  const result = await installSkillFromGithub({ projectRoot: root, skillsDir: ".pi/skills", ref: "a/b/p", fetchImpl });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("/master/p/SKILL.md"));
  assert.equal(result.name, "bigquery-basics");
  assert.equal(result.sourceUrl, calls[1]);
});

test("installSkillFromGithub rejects bare refs and preserves rollback trail", async (t) => {
  const root = workspace(t);
  await assert.rejects(
    () => installSkillFromGithub({ projectRoot: root, ref: "google/skills", fetchImpl: async () => new Response("x", { status: 200 }) }),
    /skill directory path is required/
  );
  // failed installs leave nothing behind
  assert.equal(loadSkillsFromDirectory(path.join(root, ".pi", "skills")).length, 0);
});
