import test from "node:test";
import assert from "node:assert/strict";
import { classifyBash, RISK } from "../src/policy.mjs";
import { isAllowlistedCommand, leadingCommandToken } from "../src/shell-allowlist.mjs";

test("leadingCommandToken normalizes paths quotes and wrappers", () => {
  assert.equal(leadingCommandToken("ls -la"), "ls");
  assert.equal(leadingCommandToken("  \"C:\\Program Files\\git\\bin\\git\" status"), "git");
  assert.equal(leadingCommandToken("python -m unittest"), "python");
  assert.equal(leadingCommandToken("(cd /tmp && ls)"), "cd");
  assert.equal(leadingCommandToken(""), null);
});

test("allowlisted read commands classify as low risk", () => {
  assert.equal(classifyBash("ls -la .").risk, RISK.LOW);
  assert.equal(classifyBash("cat package.json").risk, RISK.LOW);
  assert.equal(classifyBash("grep -r \"foo\" src").risk, RISK.LOW);
  assert.equal(classifyBash("git status --short").risk, RISK.LOW);
  assert.equal(classifyBash("git diff HEAD").risk, RISK.LOW);
  assert.equal(classifyBash("node -v").risk, RISK.LOW);
});

test("unrecognized commands default to medium risk", () => {
  assert.equal(classifyBash("mystery-binary --purge").risk, RISK.MEDIUM);
  assert.equal(classifyBash("git stash").risk, RISK.MEDIUM, "git stash mutates and is not allowlisted");
  assert.equal(classifyBash("git fetch origin").risk, RISK.MEDIUM, "fetch writes refs");
  assert.equal(classifyBash("custom-tool deploy").risk, RISK.MEDIUM);
});

test("destructive and mutating commands keep their existing classification", () => {
  assert.equal(classifyBash("git reset --hard HEAD~1").risk, RISK.HIGH);
  assert.equal(classifyBash("rm --recursive ./out").risk, RISK.HIGH);
  assert.equal(classifyBash("npm install fastify").risk, RISK.MEDIUM);
});

test("extraCommands extends the allowlist", () => {
  assert.equal(classifyBash("my-readonly-tool").risk, RISK.MEDIUM);
  assert.equal(classifyBash("my-readonly-tool", { extraCommands: ["my-readonly-tool"] }).risk, RISK.LOW);
  assert.equal(classifyBash("my-readonly-tool", { allowlist: false }).risk, RISK.MEDIUM);
});

test("isAllowlistedCommand accepts extra commands", () => {
  assert.equal(isAllowlistedCommand("ls"), true);
  assert.equal(isAllowlistedCommand("git log --oneline"), true);
  assert.equal(isAllowlistedCommand("git reset --hard"), false);
  assert.equal(isAllowlistedCommand("rando", ["rando"]), true);
});