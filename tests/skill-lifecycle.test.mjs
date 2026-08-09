import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadSkillsFromDirectory } from "../src/skill-store.mjs";
import { VersionStore } from "../src/version-store.mjs";
import { applySkillCandidate, createSkillCandidate, rollbackSkillCandidate } from "../src/skill-lifecycle.mjs";

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
