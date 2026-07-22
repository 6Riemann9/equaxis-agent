import test from "node:test";
import assert from "node:assert/strict";
import {
  RISK,
  classifyBash,
  classifyToolCall,
  containsSecretLikeInput,
  isOutsideWorkspace,
  matchesProtectedPath,
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
});

test("classifies package installation as medium risk", () => {
  assert.equal(classifyBash("npm install fastify").risk, RISK.MEDIUM);
});

test("protects sensitive file paths", () => {
  assert.equal(matchesProtectedPath("./.env", config.protectPaths), ".env");
  assert.equal(matchesProtectedPath("certs/server.pem", config.protectPaths), "*.pem");
});

test("detects writes outside workspace", () => {
  assert.equal(isOutsideWorkspace("../outside.txt", "D:/workspace/project"), true);
  assert.equal(isOutsideWorkspace("src/file.ts", "D:/workspace/project"), false);
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
  assert.equal(validateToolInput("bash", { command: "Get-ChildItem" }), null);
});

test("unregistered tools are not classified as low risk", () => {
  assert.equal(classifyToolCall("new_extension_tool", {}, config, process.cwd()).risk, RISK.MEDIUM);
});

test("blocks raw secrets before approval", () => {
  assert.equal(containsSecretLikeInput({ content: 'api_key="abcdefgh123456"' }), true);
  assert.equal(classifyToolCall("write", { path: "notes.txt", content: 'token="abcdefgh123456"' }, config, process.cwd()).risk, RISK.BLOCKED);
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
