import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadSkillsFromDirectory, selectRelevantSkills } from "../src/skill-store.mjs";
import { VersionStore } from "../src/version-store.mjs";
import { applySkillCandidate, applySkillCandidateGuarded, createSkillCandidate, retireSkill, reviewSkillCandidate, rollbackSkillCandidate } from "../src/skill-lifecycle.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-skill-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const SKILL = {
  name: "review-flow",
  description: "Review code changes before merge",
  triggers: ["review", "merge"],
  body: "Check correctness, tests, and operational risks."
};

test("creates skill version candidates without writing SKILL.md", (t) => {
  const root = workspace(t);
  const candidate = createSkillCandidate({ projectRoot: root, skillsDir: ".pi/skills", skill: SKILL, id: "review-flow-v1", provenance: { source: "unit" } });
  assert.equal(candidate.kind, "skill");
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.provenance.source, "unit");
  assert.equal(fs.existsSync(path.join(root, ".pi", "skills", "review-flow", "SKILL.md")), false);
  assert.equal(new VersionStore({ projectRoot: root }).list("skill").length, 1);
});

test("applies and rolls back skill candidates through the version store", (t) => {
  const root = workspace(t);
  createSkillCandidate({ projectRoot: root, skillsDir: ".pi/skills", skill: SKILL, id: "review-flow-v1" });
  const applied = applySkillCandidate({ projectRoot: root, skillsDir: ".pi/skills", id: "review-flow-v1" });
  assert.equal(applied.status, "deployed");
  assert.equal(loadSkillsFromDirectory(path.join(root, ".pi", "skills"))[0].name, "review-flow");

  const rolledBack = rollbackSkillCandidate({ projectRoot: root, skillsDir: ".pi/skills", id: "review-flow-v1" });
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(loadSkillsFromDirectory(path.join(root, ".pi", "skills")).length, 0);
});

test("rollback restores the previous skill content", (t) => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, ".pi", "skills", "review-flow"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "skills", "review-flow", "SKILL.md"), "---\nname: review-flow\ndescription: old\n---\n\nOld body\n", "utf8");

  createSkillCandidate({ projectRoot: root, skillsDir: ".pi/skills", skill: SKILL, id: "review-flow-v2" });
  applySkillCandidate({ projectRoot: root, skillsDir: ".pi/skills", id: "review-flow-v2" });
  rollbackSkillCandidate({ projectRoot: root, skillsDir: ".pi/skills", id: "review-flow-v2" });

  const restored = fs.readFileSync(path.join(root, ".pi", "skills", "review-flow", "SKILL.md"), "utf8");
  assert.match(restored, /Old body/);
});

test("review gate passes create-only candidates", (t) => {
  const root = workspace(t);
  createSkillCandidate({ projectRoot: root, skillsDir: ".pi/skills", skill: SKILL, id: "review-create" });
  const review = reviewSkillCandidate({ projectRoot: root, skillsDir: ".pi/skills", id: "review-create" });
  assert.equal(review.verdict, "pass");
});

test("review gate blocks updates that add lines without evidence", (t) => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, ".pi", "skills", "review-flow"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "skills", "review-flow", "SKILL.md"), "---\nname: review-flow\ndescription: old\n---\n\nOld body\n", "utf8");
  createSkillCandidate({ projectRoot: root, skillsDir: ".pi/skills", skill: SKILL, id: "review-update" });
  const review = reviewSkillCandidate({ projectRoot: root, skillsDir: ".pi/skills", id: "review-update" });
  assert.equal(review.verdict, "needs_review");
  assert.ok(review.addedLines.length > 0);
  assert.throws(
    () => applySkillCandidateGuarded({ projectRoot: root, skillsDir: ".pi/skills", id: "review-update" }),
    (err) => err.code === "SKILL_REVIEW_BLOCKED"
  );
});

test("review gate passes updates when evidence is supplied", (t) => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, ".pi", "skills", "review-flow"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "skills", "review-flow", "SKILL.md"), "---\nname: review-flow\ndescription: old\n---\n\nOld body\n", "utf8");
  createSkillCandidate({ projectRoot: root, skillsDir: ".pi/skills", skill: SKILL, id: "review-evidenced", evidence: ["s1", "s2"] });
  const review = reviewSkillCandidate({ projectRoot: root, skillsDir: ".pi/skills", id: "review-evidenced", evidence: ["s1", "s2"] });
  assert.equal(review.verdict, "pass");
  const applied = applySkillCandidateGuarded({ projectRoot: root, skillsDir: ".pi/skills", id: "review-evidenced" });
  assert.equal(applied.status, "deployed");
});

test("retireSkill flips frontmatter and keeps content for audit", (t) => {
  const root = workspace(t);
  createSkillCandidate({ projectRoot: root, skillsDir: ".pi/skills", skill: SKILL, id: "retire-me" });
  applySkillCandidate({ projectRoot: root, skillsDir: ".pi/skills", id: "retire-me" });
  const retired = retireSkill({ projectRoot: root, skillsDir: ".pi/skills", name: "review-flow", reason: "no benign reuse in 30 days" });
  assert.equal(retired.status, "retired");
  const file = fs.readFileSync(path.join(root, ".pi", "skills", "review-flow", "SKILL.md"), "utf8");
  assert.match(file, /retired: true/);
  assert.match(file, /no benign reuse/);
  assert.match(file, /Check correctness/);
  const loaded = loadSkillsFromDirectory(path.join(root, ".pi", "skills"));
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].retired, true);
  const { selected } = selectRelevantSkills(loaded, "review");
  assert.equal(selected.length, 0, "retired skill must not be selected for injection");
});
