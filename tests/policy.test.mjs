import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RISK,
  classifyBash,
  classifyToolCall,
  containsSecretLikeInput,
  isOutsideWorkspace,
  isWithinConfiguredRoot,
  matchesProtectedPath,
  policyRuleVersion,
  shouldBlockForLimits,
  validateToolInput
} from "../src/policy.mjs";

const config = {
  protectPaths: [".env", ".git/", "*.pem"],
  approval: { highRiskBash: true, writesOutsideWorkspace: true },
  limits: { maxToolCallsPerTurn: 3, maxHighRiskCallsPerTurn: 1 }
};

test("classifies destructive bash as high risk", () => {
  assert.equal(classifyBash("git reset --hard HEAD~1").risk, RISK.HIGH);
  assert.equal(classifyBash("Remove-Item ./out -Recurse -Force").risk, RISK.HIGH);
  assert.equal(classifyBash("rm --recursive ./out").risk, RISK.HIGH);
  assert.equal(classifyBash("powershell -EncodedCommand ZQBjAGgAbwA=").risk, RISK.HIGH);
  assert.equal(classifyBash("git clean --force -d").risk, RISK.HIGH);
});

test("classifies package installation as medium risk", () => {
  assert.equal(classifyBash("npm install fastify").risk, RISK.MEDIUM);
});

test("protects sensitive file paths", () => {
  assert.equal(matchesProtectedPath("./.env", config.protectPaths), ".env");
  assert.equal(matchesProtectedPath("certs/server.pem", config.protectPaths), "*.pem");
  assert.equal(matchesProtectedPath("src/.environment.ts", config.protectPaths), null);
  assert.equal(matchesProtectedPath("src/.env.local", config.protectPaths), ".env");
});

test("detects writes outside workspace", () => {
  assert.equal(isOutsideWorkspace("../outside.txt", "D:/workspace/project"), true);
  assert.equal(isOutsideWorkspace("src/file.ts", "D:/workspace/project"), false);
});

test("auto-approves only explicitly rooted external edits", () => {
  const workspace = "D:/workspace/project";
  const approvedRoot = "D:/workspace/shared";
  const autoConfig = {
    ...config,
    approval: {
      ...config.approval,
      externalEditPolicy: "auto",
      externalEditRoots: [approvedRoot]
    }
  };
  assert.equal(isWithinConfiguredRoot("D:/workspace/shared/file.txt", workspace, [approvedRoot]), true);
  const approved = classifyToolCall("write", { path: "../shared/file.txt" }, autoConfig, workspace);
  assert.equal(approved.risk, RISK.MEDIUM);
  assert.equal(approved.approval, false);
  const unapproved = classifyToolCall("write", { path: "../other/file.txt" }, autoConfig, workspace);
  assert.equal(unapproved.risk, RISK.HIGH);
  assert.equal(unapproved.approval, true);
});

test("denies external edits when configured to deny", () => {
  const denyConfig = {
    ...config,
    approval: { ...config.approval, externalEditPolicy: "deny", externalEditRoots: [] }
  };
  const result = classifyToolCall("edit", { path: "../outside/file.ts" }, denyConfig, "D:/workspace/project");
  assert.equal(result.risk, RISK.BLOCKED);
  assert.equal(result.approval, false);
});

test("resolves symlinked paths before workspace boundary checks", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equaxis-policy-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "equaxis-outside-"));
  try {
    await fs.symlink(outside, path.join(root, "linked"), "junction");
    assert.equal(isOutsideWorkspace("linked/secret.txt", root), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("rejects malformed semantic tool arguments", () => {
  assert.equal(validateToolInput("write", { path: "" }).code, "MISSING_ARGUMENT");
  assert.equal(validateToolInput("web_crawl", { url: "file:///etc/passwd" }).code, "INVALID_URL_SCHEME");
  assert.equal(validateToolInput("memory_search", { query: "   " }).retryable, true);
  assert.equal(validateToolInput("advisor_consult", { kind: "other" }).code, "INVALID_ADVISOR_KIND");
  assert.equal(validateToolInput("dap_probe", { mode: "process", request: "launch" }).field, "program");
  assert.equal(validateToolInput("dap_probe", { mode: "process", request: "attach", port: 5678 }).field, "host");
  assert.equal(validateToolInput("dap_probe", { mode: "process", request: "attach", host: "127.0.0.1", port: 70000 }).field, "port");
  assert.equal(validateToolInput("dap_probe", { mode: "process", request: "attach", host: "127.0.0.1", port: 5678 }), null);
  assert.equal(validateToolInput("bash", { command: "Get-ChildItem" }), null);
});

test("unregistered tools are not classified as low risk", () => {
  assert.equal(classifyToolCall("new_extension_tool", {}, config, process.cwd()).risk, RISK.MEDIUM);
});

test("blocks raw secrets before approval", () => {
  assert.equal(containsSecretLikeInput({ content: 'api_key="abcdefgh123456"' }), true);
  assert.equal(classifyToolCall("write", { path: "notes.txt", content: 'token="abcdefgh123456"' }, config, process.cwd()).risk, RISK.BLOCKED);
  assert.equal(containsSecretLikeInput({ value: "sk-abcdefghijklmnopqrstuv" }), true);
});

test("blocks indirect shell writes to protected paths", () => {
  const result = classifyToolCall("bash", { command: "Set-Content .env 'DEBUG=true'" }, config, process.cwd());
  assert.equal(result.risk, RISK.BLOCKED);
  assert.match(result.reason, /protected path/);
});

test("enforces per-turn tool limits", () => {
  assert.match(shouldBlockForLimits({ toolCallsThisTurn: 3, highRiskCallsThisTurn: 0 }, config, { risk: RISK.LOW }), /limit exceeded/);
});

test("classifies web crawling as external network access", () => {
  assert.equal(
    classifyToolCall("web_crawl", { url: "https://example.com" }, config, process.cwd()).risk,
    RISK.MEDIUM
  );
});

test("classifies protocol tools as low-risk local probes", () => {
  assert.equal(classifyToolCall("advisor_consult", { kind: "plan" }, config, process.cwd()).risk, RISK.LOW);
  assert.equal(classifyToolCall("lsp_probe", {}, config, process.cwd()).risk, RISK.LOW);
  assert.equal(classifyToolCall("dap_probe", {}, config, process.cwd()).risk, RISK.LOW);
});

test("governs AST inspection preview and application", () => {
  assert.equal(classifyToolCall("ast_inspect", { path: "src/app.ts" }, config, process.cwd()).risk, RISK.LOW);
  assert.equal(classifyToolCall("ast_rename", { path: "src/app.ts", newName: "next" }, config, process.cwd()).risk, RISK.LOW);
  assert.equal(classifyToolCall("ast_rename", { path: "src/app.ts", newName: "next", apply: true, expectedHash: "a".repeat(64) }, config, process.cwd()).risk, RISK.MEDIUM);
  assert.equal(classifyToolCall("ast_rename", { path: ".env", newName: "next", apply: true, expectedHash: "a".repeat(64) }, config, process.cwd()).risk, RISK.BLOCKED);
});

test("governs durable memory mutations", () => {
  assert.equal(
    classifyToolCall("memory_remember", { content: "User prefers concise answers" }, config, process.cwd()).risk,
    RISK.MEDIUM
  );
  assert.equal(
    classifyToolCall("memory_search", { query: "user preference" }, config, process.cwd()).risk,
    RISK.LOW
  );
  assert.equal(
    classifyToolCall("reflect", { steps: [] }, config, process.cwd()).risk,
    RISK.LOW
  );
  assert.equal(
    classifyToolCall("reflect", { steps: [], store: true }, config, process.cwd()).risk,
    RISK.MEDIUM
  );
  assert.equal(
    classifyToolCall("memory_remember", { content: 'token="abcdefgh123456"' }, config, process.cwd()).risk,
    RISK.BLOCKED
  );
  assert.equal(
    classifyToolCall(
      "memory_add_fact",
      { subject: "service", predicate: "api_key", object: "abcdefgh123456" },
      config,
      process.cwd()
    ).risk,
    RISK.BLOCKED
  );
});

test("policyRuleVersion fingerprints decision-relevant config", () => {
  const base = { approval: { highRiskBash: true }, limits: { maxRepeatedCalls: 3 }, policy: { mode: "enforce" } };
  const same = { approval: { highRiskBash: true }, limits: { maxRepeatedCalls: 3 }, policy: { mode: "enforce" } };
  const changed = { approval: { highRiskBash: false }, limits: { maxRepeatedCalls: 3 }, policy: { mode: "enforce" } };
  assert.equal(policyRuleVersion(base), policyRuleVersion(same));
  assert.notEqual(policyRuleVersion(base), policyRuleVersion(changed));
  assert.match(policyRuleVersion(base), /^[0-9a-f]{16}$/);
  assert.equal(policyRuleVersion(undefined), "unversioned");
});

test("rm combination flags trigger HIGH recursive-deletion classification", () => {
  for (const command of ["rm -fr ./out", "rm -rfv ./out", "rm -rvf ./out", "rm -rf ./out", "rm --recursive ./out"]) {
    const result = classifyBash(command, {});
    assert.equal(result.risk, RISK.HIGH, command);
    assert.match(result.reason, /recursive deletion/);
  }
  assert.notEqual(classifyBash("rm file.txt", {}).risk, RISK.HIGH, "plain rm is not recursive");
});

test("write-shaped commands that touch protected paths are blocked", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-policy-write-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const config = { approval: { highRiskBash: true }, protectPaths: [".env"], toolRouting: {} };
  for (const command of ['printf "x" > .env', "sed -i s/a/b/ .env", "find . -name '.env' -delete"]) {
    const result = classifyToolCall("bash", { command }, config, workspace);
    assert.equal(result.risk, RISK.BLOCKED, command);
  }
  const safe = classifyToolCall("bash", { command: "cat .env" }, config, workspace);
  assert.notEqual(safe.risk, RISK.BLOCKED);
});
