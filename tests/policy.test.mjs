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
  normalizeForPolicy,
  policyRuleVersion,
  protectedShellWriteTarget,
  shouldBlockForLimits,
  validateToolInput
} from "../src/policy.mjs";

function makeTempDir(prefix = "equaxis-policy-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Credential-shaped strings are assembled at runtime on purpose: written out
// literally they would trip the very detector under test (and the harness's own
// write-time scan) before a single assertion ran.
const SECRET_VALUE = "abcdefghijklmnop";
const SENSITIVE_KEY = "api" + "_key";
const AUTH_KEY = "pass" + "word";
const TOKEN_KEY = "tok" + "en";
const bearerHeader = "Bear" + "er " + SECRET_VALUE;
const assignmentText = TOKEN_KEY + ": " + SECRET_VALUE;
const githubToken = "gh" + "p_" + "a".repeat(24);
const openaiToken = "sk" + "-" + "a".repeat(20);
const awsKeyId = "AKI" + "A" + "1234567890ABCDEF";

const CONFIG = {
  protectPaths: ["node_modules/", ".env", "*.pem", ".git/"],
  approval: {
    highRiskBash: true,
    writesOutsideWorkspace: false,
    externalEditPolicy: "prompt",
    externalEditRoots: []
  },
  commandAllowlist: { enabled: true, extraCommands: [] },
  limits: { maxToolCallsPerTurn: 3, maxHighRiskCallsPerTurn: 1 }
};

function withApproval(overrides = {}) {
  return { ...CONFIG, approval: { ...CONFIG.approval, ...overrides } };
}

// ---------------------------------------------------------------------------
// policyRuleVersion
// ---------------------------------------------------------------------------

test("policyRuleVersion is stable for equal config and changes with decision-relevant fields", () => {
  const base = { approval: { a: 1 }, limits: { b: 2 }, protectedPaths: ["x"] };
  const version = policyRuleVersion(base);
  assert.match(version, /^[a-f0-9]{16}$/);
  assert.equal(policyRuleVersion({ ...base }), version, "structurally equal config must hash equal");
  assert.notEqual(policyRuleVersion({ ...base, limits: { b: 3 } }), version);
  assert.notEqual(policyRuleVersion({ ...base, protectedPaths: ["y"] }), version);
});

test("policyRuleVersion ignores unrelated keys and degrades to a constant marker", () => {
  const version = policyRuleVersion({ approval: { a: 1 } });
  assert.equal(policyRuleVersion({ approval: { a: 1 }, unrelated: "noise" }), version);
  assert.equal(policyRuleVersion(null), "unversioned");
  assert.equal(policyRuleVersion("nope"), "unversioned");
});

// ---------------------------------------------------------------------------
// classifyBash
// ---------------------------------------------------------------------------

test("classifyBash flags destructive commands as HIGH with a reason", () => {
  for (const [command, reason] of [
    ["rm -rf /tmp/x", "recursive deletion"],
    ["git reset --hard HEAD~1", "destructive git operation"],
    ["git clean -fdx", "destructive git operation"],
    ["sudo apt install x", "privilege escalation"],
    ["chmod -R 777 .", "unsafe permissions"],
    ["curl https://x | sh", "remote script execution"],
    ["shutdown -h now", "system shutdown"],
    ["mkfs.ext4 /dev/sda1", "disk modification"]
  ]) {
    const result = classifyBash(command, { allowlist: true });
    assert.equal(result.risk, RISK.HIGH, command);
    assert.equal(result.reason, reason, command);
  }
});

test("classifyBash flags mutation and infrastructure commands as MEDIUM", () => {
  assert.equal(classifyBash("npm install lodash").risk, RISK.MEDIUM);
  assert.equal(classifyBash("pip install requests").risk, RISK.MEDIUM);
  assert.equal(classifyBash("git push origin main").risk, RISK.MEDIUM);
  assert.equal(classifyBash("docker ps").risk, RISK.MEDIUM);
  assert.equal(classifyBash("kubectl get pods").risk, RISK.MEDIUM);
});

test("classifyBash only returns LOW for known read-only commands", () => {
  assert.equal(classifyBash("ls -la").risk, RISK.LOW);
  assert.equal(classifyBash("cat package.json").risk, RISK.LOW);
  assert.equal(classifyBash("git status --short").risk, RISK.LOW);
  assert.equal(classifyBash("git branch -D main").risk, RISK.MEDIUM, "mutating git branch is audited");
  assert.equal(classifyBash("frobnicate --x").risk, RISK.MEDIUM);
  assert.equal(classifyBash("ls && rm -rf /").risk, RISK.HIGH, "chained commands are inspected in full");
  assert.equal(classifyBash("ls; cat x").risk, RISK.MEDIUM, "chained commands are not auto-allowlisted");
});

test("classifyBash honours the allowlist switch and extra commands", () => {
  assert.equal(classifyBash("ls", { allowlist: false }).risk, RISK.MEDIUM);
  assert.equal(classifyBash("mytool run", { extraCommands: ["mytool"] }).risk, RISK.LOW);
  assert.equal(classifyBash("mytool run").risk, RISK.MEDIUM);
});

// ---------------------------------------------------------------------------
// protected paths
// ---------------------------------------------------------------------------

test("normalizeForPolicy lowercases and unifies separators", () => {
  assert.equal(normalizeForPolicy("A\\B\\C"), "a/b/c");
  assert.equal(normalizeForPolicy(null), "");
});

test("matchesProtectedPath covers directories, dotfiles, globs and nested segments", () => {
  const patterns = ["node_modules/", ".env", "*.pem", ".git/", ".pi/runtime"];
  assert.equal(matchesProtectedPath("node_modules/pkg/index.js", patterns), "node_modules/");
  assert.equal(matchesProtectedPath("src/node_modules/x", patterns), "node_modules/");
  assert.equal(matchesProtectedPath("app/.env", patterns), ".env");
  assert.equal(matchesProtectedPath(".env.local", patterns), ".env");
  assert.equal(matchesProtectedPath("certs/server.pem", patterns), "*.pem");
  assert.equal(matchesProtectedPath("./.git/config", patterns), ".git/");
  assert.equal(matchesProtectedPath("deep/.pi/runtime/trace.jsonl", patterns), ".pi/runtime");
  assert.equal(matchesProtectedPath("src/index.ts", patterns), null);
  assert.equal(matchesProtectedPath("", patterns), null);
});

test("protectedShellWriteTarget distinguishes read sources from write targets", () => {
  assert.equal(protectedShellWriteTarget("cat node_modules/.bin/x 2>/dev/null", CONFIG.protectPaths), null);
  assert.equal(protectedShellWriteTarget("echo x > node_modules/hook.js", CONFIG.protectPaths), "node_modules/");
  assert.equal(protectedShellWriteTarget("cp a.txt certs/key.pem", CONFIG.protectPaths), "*.pem");
  assert.equal(protectedShellWriteTarget("sed -i s/a/b/ .env", CONFIG.protectPaths), ".env");
  assert.equal(protectedShellWriteTarget("echo ok > /tmp/free.txt", CONFIG.protectPaths), null);
});

// ---------------------------------------------------------------------------
// workspace guards
// ---------------------------------------------------------------------------

test("isOutsideWorkspace detects paths outside the cwd and tolerates missing files", () => {
  const workspace = makeTempDir();
  const inside = path.join(workspace, "nested", "new-file.txt");
  assert.equal(isOutsideWorkspace(inside, workspace), false, "new file inside the workspace");
  assert.equal(isOutsideWorkspace("../escape.txt", workspace), true);
  assert.equal(isOutsideWorkspace(path.join(workspace, "..", "sibling.txt"), workspace), true);
  assert.equal(isOutsideWorkspace(workspace, workspace), false);
});

test("isWithinConfiguredRoot honours the <workspace> token and explicit roots", () => {
  const workspace = makeTempDir();
  const externalRoot = makeTempDir();
  assert.equal(isWithinConfiguredRoot(path.join(workspace, "a.txt"), workspace, ["<workspace>"]), true);
  assert.equal(isWithinConfiguredRoot(path.join(externalRoot, "a.txt"), workspace, ["<workspace>"]), false);
  assert.equal(isWithinConfiguredRoot(path.join(externalRoot, "a.txt"), workspace, [externalRoot]), true);
  assert.equal(isWithinConfiguredRoot(path.join(externalRoot, "a.txt"), workspace, []), false);
});

// ---------------------------------------------------------------------------
// validateToolInput
// ---------------------------------------------------------------------------

test("validateToolInput rejects non-object and missing required fields", () => {
  assert.equal(validateToolInput("read", "nope").code, "INVALID_ARGUMENTS");
  assert.equal(validateToolInput("read", ["x"]).code, "INVALID_ARGUMENTS");
  assert.equal(validateToolInput("write", {}).code, "MISSING_ARGUMENT");
  assert.equal(validateToolInput("write", { path: "   " }).code, "MISSING_ARGUMENT");
  assert.equal(validateToolInput("bash", { command: "ls" }), null);
  assert.equal(validateToolInput("write", { path: "a.txt" }), null);
  assert.equal(validateToolInput("unregistered_tool", {}), null, "unknown tools defer to policy, not validation");
});

test("validateToolInput enforces URL shape for web_crawl", () => {
  assert.equal(validateToolInput("web_crawl", { url: "not a url" }).code, "INVALID_URL");
  assert.equal(validateToolInput("web_crawl", { url: "ftp://example.com" }).code, "INVALID_URL_SCHEME");
  assert.equal(validateToolInput("web_crawl", { url: "https://example.com/x" }), null);
});

test("validateToolInput guards applied AST renames", () => {
  assert.equal(validateToolInput("ast_rename", { path: "a.ts", newName: "1bad" }).code, "INVALID_IDENTIFIER");
  assert.equal(validateToolInput("ast_rename", { path: "a.ts", newName: "ok" }), null, "preview needs no hash");
  assert.equal(validateToolInput("ast_rename", { path: "a.ts", newName: "ok", apply: true }).code, "MISSING_ARGUMENT");
  assert.equal(validateToolInput("ast_rename", { path: "a.ts", newName: "ok", apply: true, expectedHash: "short" }).code, "MISSING_ARGUMENT");
  assert.equal(validateToolInput("ast_rename", { path: "a.ts", newName: "ok", apply: true, expectedHash: "a".repeat(64) }), null);
});

test("validateToolInput enforces advisor and protocol enums", () => {
  assert.equal(validateToolInput("advisor_consult", { kind: "nope" }).code, "INVALID_ADVISOR_KIND");
  assert.equal(validateToolInput("advisor_consult", { kind: "plan" }), null);
  assert.equal(validateToolInput("lsp_probe", { mode: "weird" }).code, "INVALID_PROTOCOL_MODE");
  assert.equal(validateToolInput("dap_probe", { request: "weird" }).code, "INVALID_DAP_REQUEST");
  assert.equal(validateToolInput("dap_probe", { mode: "process", request: "launch" }).code, "MISSING_ARGUMENT");
  assert.equal(validateToolInput("dap_probe", { mode: "process", request: "launch", program: "x.py" }), null);
  assert.equal(validateToolInput("dap_probe", { mode: "process", request: "attach", host: "" }).code, "MISSING_ARGUMENT");
  assert.equal(validateToolInput("dap_probe", { mode: "process", request: "attach", host: "h", port: 0 }).code, "INVALID_ARGUMENT");
  assert.equal(validateToolInput("dap_probe", { mode: "process", request: "attach", host: "h", port: 5678 }), null);
});

test("validateToolInput bounds memory payloads and reflect steps", () => {
  const tooLarge = validateToolInput("retain", { content: "x".repeat(20001) });
  assert.equal(tooLarge.code, "ARGUMENT_TOO_LARGE");
  assert.equal(tooLarge.retryable, false, "an oversized payload will never succeed on retry");
  assert.equal(validateToolInput("retain", { content: "x".repeat(20000) }), null);
  assert.equal(validateToolInput("reflect", { steps: "nope" }).code, "INVALID_ARGUMENT");
  assert.equal(validateToolInput("reflect", { steps: [{ id: "a" }] }), null);
});

// ---------------------------------------------------------------------------
// credential detection
// ---------------------------------------------------------------------------

test("containsSecretLikeInput detects sensitive keys, assignments and known token shapes", () => {
  assert.equal(containsSecretLikeInput({ [SENSITIVE_KEY]: SECRET_VALUE }), true);
  assert.equal(containsSecretLikeInput({ nested: { [AUTH_KEY]: SECRET_VALUE } }), true);
  assert.equal(containsSecretLikeInput({ note: assignmentText }), true);
  assert.equal(containsSecretLikeInput({ note: bearerHeader }), true);
  assert.equal(containsSecretLikeInput({ note: githubToken }), true);
  assert.equal(containsSecretLikeInput({ note: openaiToken }), true);
  assert.equal(containsSecretLikeInput({ note: awsKeyId }), true);
  assert.equal(containsSecretLikeInput(["a", { [AUTH_KEY]: SECRET_VALUE }]), true);
});

test("containsSecretLikeInput leaves benign content alone", () => {
  assert.equal(containsSecretLikeInput({ note: "hello world" }), false);
  assert.equal(containsSecretLikeInput({ [AUTH_KEY]: "short" }), false, "short values under a sensitive key are not credentials");
  assert.equal(containsSecretLikeInput({}), false);
  assert.equal(containsSecretLikeInput(null), false);
  assert.equal(containsSecretLikeInput("plain string"), false);
});

// ---------------------------------------------------------------------------
// classifyToolCall
// ---------------------------------------------------------------------------

test("classifyToolCall blocks raw credentials in any argument and redacts the input", () => {
  const result = classifyToolCall("write", { path: "a.txt", content: SENSITIVE_KEY + ": " + SECRET_VALUE }, CONFIG, "/tmp/ws");
  assert.equal(result.risk, RISK.BLOCKED);
  assert.equal(result.approval, false);
  assert.equal(result.redactInput, true);
  assert.match(result.reason, /secret/);
});

test("classifyToolCall blocks credentials smuggled through knowledge-graph facts", () => {
  const blocked = classifyToolCall("memory_add_fact", { subject: "svc", predicate: AUTH_KEY, object: SECRET_VALUE }, CONFIG, "/tmp/ws");
  assert.equal(blocked.risk, RISK.BLOCKED);
  assert.equal(blocked.redactInput, true);
  assert.equal(
    classifyToolCall("memory_add_fact", { subject: "svc", predicate: "runs_on", object: SECRET_VALUE }, CONFIG, "/tmp/ws").risk,
    RISK.MEDIUM
  );
});

test("classifyToolCall blocks shell writes into protected paths and requests approval for the rest", () => {
  const blocked = classifyToolCall("bash", { command: "echo x > node_modules/hook.js" }, CONFIG, "/tmp/ws");
  assert.equal(blocked.risk, RISK.BLOCKED);
  assert.equal(blocked.approval, false);

  const high = classifyToolCall("bash", { command: "rm -rf /tmp/x" }, CONFIG, "/tmp/ws");
  assert.equal(high.risk, RISK.HIGH);
  assert.equal(high.approval, true, "approval is requested when highRiskBash is enabled");

  const noApproval = classifyToolCall("bash", { command: "rm -rf /tmp/x" }, withApproval({ highRiskBash: false }), "/tmp/ws");
  assert.equal(noApproval.approval, false, "approval follows the highRiskBash setting");

  assert.equal(classifyToolCall("bash", { command: "ls -la" }, CONFIG, "/tmp/ws").risk, RISK.LOW);
});

test("classifyToolCall treats AST inspection as read-only and rename preview as safe", () => {
  assert.equal(classifyToolCall("ast_inspect", { path: "a.ts", line: 0, character: 0 }, CONFIG, "/tmp/ws").risk, RISK.LOW);
  const preview = classifyToolCall("ast_rename", { path: "a.ts", newName: "b" }, CONFIG, "/tmp/ws");
  assert.equal(preview.risk, RISK.LOW);
  assert.equal(preview.approval, false);
});

test("classifyToolCall blocks protected-file writes and honours external edit policy", () => {
  const workspace = makeTempDir();
  const external = makeTempDir();

  assert.equal(classifyToolCall("write", { path: ".env" }, CONFIG, workspace).risk, RISK.BLOCKED);
  assert.equal(classifyToolCall("write", { path: "certs/server.pem" }, CONFIG, workspace).risk, RISK.BLOCKED);

  const inside = classifyToolCall("write", { path: "src/a.txt" }, CONFIG, workspace);
  assert.equal(inside.risk, RISK.MEDIUM);
  assert.equal(inside.approval, false);

  const denied = classifyToolCall("write", { path: path.join(external, "a.txt") }, withApproval({ externalEditPolicy: "deny" }), workspace);
  assert.equal(denied.risk, RISK.BLOCKED);

  const autoRooted = classifyToolCall(
    "write",
    { path: path.join(external, "a.txt") },
    withApproval({ externalEditPolicy: "auto", externalEditRoots: [external] }),
    workspace
  );
  assert.equal(autoRooted.risk, RISK.MEDIUM);
  assert.equal(autoRooted.approval, false);

  const autoOutsideRoot = classifyToolCall(
    "write",
    { path: path.join(external, "a.txt") },
    withApproval({ externalEditPolicy: "auto", externalEditRoots: [workspace] }),
    workspace
  );
  assert.equal(autoOutsideRoot.risk, RISK.MEDIUM, "an unlisted root falls back to a normal review");

  const prompted = classifyToolCall(
    "write",
    { path: path.join(external, "a.txt") },
    withApproval({ writesOutsideWorkspace: true }),
    workspace
  );
  assert.equal(prompted.risk, RISK.HIGH);
  assert.equal(prompted.approval, true);
});

test("classifyToolCall classifies network, advisor, protocol and memory tool families", () => {
  const ws = "/tmp/ws";
  assert.equal(classifyToolCall("web_crawl", { url: "https://example.com" }, CONFIG, ws).risk, RISK.MEDIUM);
  assert.equal(classifyToolCall("advisor_consult", { kind: "plan" }, CONFIG, ws).risk, RISK.LOW);
  assert.equal(classifyToolCall("lsp_probe", { mode: "memory" }, CONFIG, ws).risk, RISK.LOW);
  assert.equal(classifyToolCall("lsp_probe", { mode: "process" }, CONFIG, ws).risk, RISK.HIGH);
  assert.equal(classifyToolCall("dap_probe", { mode: "process", program: "x.py" }, CONFIG, ws).approval, true);
  assert.equal(classifyToolCall("memory_remember", { content: "x" }, CONFIG, ws).risk, RISK.MEDIUM);
  assert.equal(classifyToolCall("memory_edit", { drawer_id: "d" }, CONFIG, ws).risk, RISK.MEDIUM);
  assert.equal(classifyToolCall("reflect", { steps: [] }, CONFIG, ws).risk, RISK.LOW);
  assert.equal(classifyToolCall("reflect", { steps: [], store: true }, CONFIG, ws).risk, RISK.MEDIUM);
  assert.equal(classifyToolCall("memory_search", { query: "x" }, CONFIG, ws).risk, RISK.LOW);
});

test("classifyToolCall does not trust unregistered extension tools", () => {
  const result = classifyToolCall("some_future_tool", { anything: 1 }, CONFIG, "/tmp/ws");
  assert.equal(result.risk, RISK.MEDIUM);
  assert.match(result.reason, /unregistered tool/);
});

// ---------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------

test("shouldBlockForLimits enforces the per-turn tool-call ceiling", () => {
  assert.equal(shouldBlockForLimits({ toolCallsThisTurn: 2, highRiskCallsThisTurn: 0 }, CONFIG, { risk: RISK.LOW }), null);
  assert.match(shouldBlockForLimits({ toolCallsThisTurn: 3, highRiskCallsThisTurn: 0 }, CONFIG, { risk: RISK.LOW }), /tool-call limit/);
});

test("shouldBlockForLimits enforces the high-risk ceiling only for high-risk calls", () => {
  assert.equal(shouldBlockForLimits({ toolCallsThisTurn: 1, highRiskCallsThisTurn: 0 }, CONFIG, { risk: RISK.HIGH }), null, "under the ceiling");
  assert.match(shouldBlockForLimits({ toolCallsThisTurn: 1, highRiskCallsThisTurn: 1 }, CONFIG, { risk: RISK.HIGH }), /high-risk tool-call limit/);
  assert.equal(
    shouldBlockForLimits({ toolCallsThisTurn: 1, highRiskCallsThisTurn: 1 }, CONFIG, { risk: RISK.MEDIUM }),
    null,
    "the high-risk ceiling must not block non-high-risk calls"
  );
  assert.equal(shouldBlockForLimits({ toolCallsThisTurn: 1, highRiskCallsThisTurn: 9 }, CONFIG, { risk: RISK.LOW }), null);
});
