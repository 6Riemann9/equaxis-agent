import test from "node:test";
import assert from "node:assert/strict";
import { ROLE_TEMPLATES, buildRolePrompt, resolveRole, roleTools } from "../src/role-templates.mjs";

test("built-in roles resolve with system prompts and tool whitelists", () => {
  assert.equal(resolveRole("architect").description, "System design: decompose, choose patterns, weigh tradeoffs");
  assert.ok(ROLE_TEMPLATES.engineer.systemPrompt.includes("smallest correct change"));
  assert.ok(roleTools("analyst").includes("recall"));
  assert.equal(resolveRole("nonexistent"), null);
  assert.equal(resolveRole("ARCHITECT").description, ROLE_TEMPLATES.architect.description, "case-insensitive");
});

test("buildRolePrompt wraps the task prompt and unknown roles pass through", () => {
  const wrapped = buildRolePrompt("expert", "Review the diff");
  assert.match(wrapped, /EXPERT/);
  assert.match(wrapped, /--- task ---/);
  assert.match(wrapped, /Review the diff/);
  assert.equal(buildRolePrompt("unknown-role", "plain task"), "plain task");
});

test("role prompts compose with empty tasks", () => {
  const wrapped = buildRolePrompt("engineer", "");
  assert.match(wrapped, /ENGINEER/);
  assert.match(wrapped, /--- task ---/);
});
