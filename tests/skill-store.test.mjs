import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveSkillFromRun,
  parseSkillFile,
  loadSkillsFromDirectory,
  scoreSkill,
  selectRelevantSkills,
  renderSkillBlock,
  serializeSkill,
  writeSkillFile
} from "../src/skill-store.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-skills-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const SUBAGENTS_MD = `---
name: subagents
description: invoke when the user asks to use subagents
triggers: [subagent, delegate, parallel]
---

# Subagents

Give every child a self-contained prompt with paths and constraints.
`;

test("parses frontmatter name, description, triggers, and body", () => {
  const skill = parseSkillFile(SUBAGENTS_MD, "/tmp/skills/subagents/SKILL.md");
  assert.equal(skill.name, "subagents");
  assert.equal(skill.description, "invoke when the user asks to use subagents");
  assert.deepEqual(skill.triggers, ["subagent", "delegate", "parallel"]);
  assert.match(skill.body, /self-contained prompt/);
  assert.equal(skill.baseDir, "/tmp/skills/subagents");
});

test("falls back to the parent directory name when no frontmatter is present", () => {
  const skill = parseSkillFile("# Plain\n\nBody text", "/tmp/skills/plain/SKILL.md");
  assert.equal(skill.name, "plain");
  assert.equal(skill.description, "");
  assert.match(skill.body, /Body text/);
});

test("loads every SKILL.md recursively under a directory", (t) => {
  const root = workspace(t);
  const a = path.join(root, "subagents", "SKILL.md");
  const b = path.join(root, "nested", "deeper", "SKILL.md");
  fs.mkdirSync(path.dirname(a), { recursive: true });
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.writeFileSync(a, SUBAGENTS_MD);
  fs.writeFileSync(b, "---\nname: deeper\n---\nBody");
  const skills = loadSkillsFromDirectory(root);
  assert.deepEqual(skills.map((s) => s.name).sort(), ["deeper", "subagents"]);
});

test("returns an empty array when the directory does not exist", () => {
  assert.deepEqual(loadSkillsFromDirectory("/no/such/dir"), []);
});

test("scores name matches above trigger and description matches", () => {
  const skill = parseSkillFile(SUBAGENTS_MD, "subagents/SKILL.md");
  const nameScore = scoreSkill(skill, ["subagents"]);
  const triggerScore = scoreSkill(skill, ["delegate"]);
  const descriptionScore = scoreSkill(skill, ["invoke"]);
  assert.ok(nameScore > triggerScore);
  assert.ok(triggerScore > descriptionScore);
  assert.equal(scoreSkill(skill, ["unrelated"]), 0);
});

test("selects only relevant skills under a token budget", () => {
  const skills = [
    parseSkillFile("---\nname: subagents\n---\n".repeat(0) + SUBAGENTS_MD, "subagents/SKILL.md"),
    parseSkillFile("---\nname: web-crawling\n---\n# Crawl\n\nFetch pages.", "web/SKILL.md")
  ];
  const { selected } = selectRelevantSkills(skills, "spawn a subagent to delegate work", { maxTokens: 4000 });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].name, "subagents");
  assert.ok(selected[0].estimatedTokens > 0);
  assert.ok(!selected.some((s) => s.name === "web-crawling"), "irrelevant skill must not be selected");
});

test("respects a hard token budget by omitting low-priority skills", () => {
  const skills = [
    parseSkillFile("---\nname: subagents\n---\n".repeat(0) + SUBAGENTS_MD, "subagents/SKILL.md"),
    parseSkillFile(SUBAGENTS_MD.replace("name: subagents", "name: subagents-copy"), "subagents-copy/SKILL.md")
  ];
  const { selected } = selectRelevantSkills(skills, "subagent delegate", { maxTokens: 20 });
  assert.ok(selected.length < 2, "tiny budget must drop at least one skill");
});

test("renders a skill as an injectable block with baseDir reference", () => {
  const skill = parseSkillFile(SUBAGENTS_MD, "/tmp/skills/subagents/SKILL.md");
  const block = renderSkillBlock(skill);
  assert.match(block, /> invoke when the user asks to use subagents/);
  assert.match(block, /<skill name="subagents"/);
  assert.match(block, /location="\/tmp\/skills\/subagents\/SKILL.md"/);
  assert.match(block, /References are relative to \/tmp\/skills\/subagents/);
  assert.match(block, /<\/skill>$/);
});

test("round-trips serialize then write then reload", (t) => {
  const root = workspace(t);
  const filePath = writeSkillFile(root, {
    name: "code-review",
    description: "review code before merging",
    triggers: ["review", "merge"],
    body: "Check correctness and maintainability."
  });
  const reloaded = loadSkillsFromDirectory(root);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].name, "code-review");
  assert.equal(reloaded[0].description, "review code before merging");
  assert.deepEqual(reloaded[0].triggers, ["review", "merge"]);
  assert.ok(path.basename(filePath).toLowerCase() === "skill.md");
  assert.ok(reloaded[0].baseDir.endsWith("code-review"));
});

test("derives a skill only from evidence-backed lessons", () => {
  const run = {
    goal: "repair service",
    lessons: [
      { type: "tool_failure", evidence: ["s1", "s2"], lesson: "Isolate failing dependencies before continuing." }
    ]
  };
  const draft = deriveSkillFromRun(run);
  assert.ok(draft, "must produce a draft when evidence exists");
  assert.equal(draft.name, "reliability-tool-failure");
  assert.deepEqual(draft.triggers, ["tool", "failure", "retry", "error"]);
  assert.match(draft.body, /Isolate failing dependencies/);
  assert.deepEqual(draft.evidence, ["s1", "s2"]);
});

test("does not invent a skill when lessons lack evidence", () => {
  const draft = deriveSkillFromRun({ goal: "repair", lessons: [{ type: "tool_failure", evidence: [], lesson: "fix it" }] });
  assert.equal(draft, null);
});

test("returns null for an empty or lesson-free run", () => {
  assert.equal(deriveSkillFromRun({ goal: "read", lessons: [] }), null);
  assert.equal(deriveSkillFromRun({ goal: "read" }), null);
  assert.equal(deriveSkillFromRun(undefined), null);
});

test("serialize/parse round-trips provenance (evidence, source, retired)", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-skill-provenance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = writeSkillFile(root, {
    name: "traceable-skill",
    description: "desc",
    triggers: ["go"],
    body: "Do the thing.",
    evidence: ["e1", "e2"],
    source: "failed run: deploy pipeline"
  });
  const reloaded = loadSkillsFromDirectory(root);
  assert.equal(reloaded.length, 1);
  assert.deepEqual(reloaded[0].evidence, ["e1", "e2"]);
  assert.match(reloaded[0].source, /deploy pipeline/);
  assert.equal(reloaded[0].retired, false);
  assert.ok(reloaded[0].created, "created timestamp must be auto-added for evidence-backed skills");
});

test("retired skills are excluded from selection but stay on disk", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-skill-retired-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeSkillFile(root, { name: "safe-skill", description: "safe one", triggers: ["safe"], body: "ok" });
  writeSkillFile(root, { name: "risky-skill", description: "risky one", triggers: ["risky"], body: "not ok", retired: true, retiredReason: "no benign reuse" });

  const all = loadSkillsFromDirectory(root);
  assert.equal(all.length, 2);
  const { selected } = selectRelevantSkills(all, "risky");
  assert.ok(!selected.some((s) => s.name === "risky-skill"), "retired skill must not be injected");
  const { selected: safe } = selectRelevantSkills(all, "safe");
  assert.equal(safe.length, 1);
});

test("parses Google Agent Skills metadata: category, dontUse, related", () => {
  const skill = parseSkillFile(`---
name: bigquery-basics
description: Query BigQuery datasets
category: data
dontUse: Use this skill for fully-managed RAG or SaaS search
related: [bigquery-ai-ml, spanner-basics]
---

# Body
`, "bigquery-basics/SKILL.md");
  assert.equal(skill.category, "data");
  assert.equal(skill.dontUse, "Use this skill for fully-managed RAG or SaaS search");
  assert.deepEqual(skill.related, ["bigquery-ai-ml", "spanner-basics"]);
});

test("negative space excludes wrong-skill injection with a reason", () => {
  const skills = [
    parseSkillFile("---\nname: rag-search\n---\n# RAG\n\nSemantic search.", "rag/SKILL.md"),
    parseSkillFile("---\nname: saas-search\n---\n# SaaS\n\nManaged search.", "saas/SKILL.md")
  ];
  skills[0].dontUse = "fully-managed RAG or SaaS search";
  const { selected, omitted } = selectRelevantSkills(skills, "saas search", { maxTokens: 4000 });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].name, "saas-search");
  assert.ok(omitted.some((entry) => entry.name === "rag-search" && entry.reason === "negative_space"));

  // a query that matches both the positive space and the negative space is excluded
  const onlyNegative = selectRelevantSkills(skills, "rag", { maxTokens: 4000 });
  assert.equal(onlyNegative.selected.length, 0);
  assert.ok(onlyNegative.omitted.some((entry) => entry.name === "rag-search"));
});

test("related skills are pulled in at the anchor's score and marked viaRelated", () => {
  const skills = [
    parseSkillFile("---\nname: alpha-task\nrelated: [beta-help]\n---\n# Alpha\n\nRun the alpha pipeline.", "alpha-task/SKILL.md"),
    parseSkillFile("---\nname: beta-help\n---\n# Beta\n\nUnrelated content.", "beta-help/SKILL.md")
  ];
  const { selected } = selectRelevantSkills(skills, "alpha pipeline", { maxTokens: 4000 });
  const anchor = selected.find((s) => s.name === "alpha-task");
  const related = selected.find((s) => s.name === "beta-help");
  assert.ok(anchor, "anchor must be selected");
  assert.ok(related, "related skill must be pulled in");
  assert.equal(related.viaRelated, "alpha-task");
  assert.equal(related.score, anchor.score);
});

test("related expansion respects the token budget and skips missing skills", () => {
  const skills = [
    parseSkillFile("---\nname: alpha-task\nrelated: [missing, beta-help]\n---\n# Alpha\n\n" + "x".repeat(2000), "alpha-task/SKILL.md"),
    parseSkillFile("---\nname: beta-help\n---\n# Beta\n\n" + "y".repeat(2000), "beta-help/SKILL.md")
  ];
  const { selected } = selectRelevantSkills(skills, "alpha", { maxTokens: 800 });
  assert.equal(selected.length, 1, "budget fits the anchor but not the related pull-in");
  const { selected: generous } = selectRelevantSkills(skills, "alpha", { maxTokens: 2000 });
  assert.deepEqual(generous.map((s) => s.name).sort(), ["alpha-task", "beta-help"]);
  assert.ok(!generous.some((s) => s.name === "missing"));
});

test("serialize/parse round-trips category, dontUse and related", () => {
  const md = serializeSkill({ name: "demo", description: "d", category: "cloud", dontUse: "Do not use for local ad-hoc queries", related: ["bigquery-ai-ml"], body: "b" });
  const parsed = parseSkillFile(md, "x/SKILL.md");
  assert.equal(parsed.category, "cloud");
  assert.equal(parsed.dontUse, "Do not use for local ad-hoc queries");
  assert.deepEqual(parsed.related, ["bigquery-ai-ml"]);
});

