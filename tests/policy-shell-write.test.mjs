import test from "node:test";
import assert from "node:assert/strict";
import { classifyToolCall, protectedShellWriteTarget, RISK } from "../src/policy.mjs";

const CONFIG = {
  protectPaths: ["node_modules", ".env", ".pi/runtime"],
  approval: { highRiskBash: true },
  commandAllowlist: { enabled: true, extraCommands: [] }
};

function bashRisk(command) {
  return classifyToolCall("bash", { command }, CONFIG, "/tmp/workspace");
}

test("read-only commands with stderr redirect mentioning protected paths are not blocked", () => {
  // Regression: `cat ... 2>/dev/null` used to be treated as a shell write,
  // so any protected path mentioned anywhere in the command blocked the call.
  assert.equal(bashRisk("ls -la ~/.local/lib/node_modules/equaxis-agent/ 2>/dev/null").risk !== RISK.BLOCKED, true);
  assert.equal(bashRisk("cat node_modules/pkg/package.json 2>/dev/null").risk !== RISK.BLOCKED, true);
  assert.equal(bashRisk("grep -rn version node_modules/ 2>/dev/null | head").risk !== RISK.BLOCKED, true);
});

test("fd duplication and /dev/null redirects are not file writes", () => {
  assert.equal(protectedShellWriteTarget("cmd 2>&1", CONFIG.protectPaths), null);
  assert.equal(protectedShellWriteTarget("cmd > /dev/null 2>&1", CONFIG.protectPaths), null);
  assert.equal(protectedShellWriteTarget("cmd &> /dev/null", CONFIG.protectPaths), null);
  assert.equal(protectedShellWriteTarget("cmd 2> errors.log", CONFIG.protectPaths), null);
});

test("redirects writing into protected paths are blocked", () => {
  assert.equal(bashRisk("echo x > node_modules/hook.js").risk, RISK.BLOCKED);
  assert.equal(bashRisk("echo x >> .env").risk, RISK.BLOCKED);
  assert.equal(bashRisk("cat a.txt b.txt > node_modules/out").risk, RISK.BLOCKED);
  assert.equal(bashRisk("printf 'x' > ./.pi/runtime/traces.jsonl").risk, RISK.BLOCKED);
  assert.equal(bashRisk('echo x > "node_modules/spaced dir/f.js"').risk, RISK.BLOCKED);
});

test("redirects to unprotected paths are allowed through to risk classification", () => {
  const result = bashRisk("echo hello > /tmp/out.txt");
  assert.notEqual(result.risk, RISK.BLOCKED);
});

test("mutating commands keep conservative whole-command protection", () => {
  assert.equal(bashRisk("cp /tmp/a node_modules/").risk, RISK.BLOCKED);
  assert.equal(bashRisk("mv a .env").risk, RISK.BLOCKED);
  assert.equal(bashRisk("tee node_modules/x < /dev/null").risk, RISK.BLOCKED);
  assert.equal(bashRisk("sed -i 's/a/b/' node_modules/x.js").risk, RISK.BLOCKED);
  assert.equal(bashRisk("find node_modules -name '*.tmp' -delete").risk, RISK.BLOCKED);
  // exfil caution: copying FROM a protected path is still blocked
  assert.equal(bashRisk("cp .env /tmp/leak").risk, RISK.BLOCKED);
});

test("process substitution and heredocs are not treated as writes", () => {
  assert.equal(protectedShellWriteTarget("diff <(cat node_modules/a) <(cat b)", CONFIG.protectPaths), null);
  assert.equal(protectedShellWriteTarget("cat <<EOF\nnode_modules\nEOF", CONFIG.protectPaths), null);
});
