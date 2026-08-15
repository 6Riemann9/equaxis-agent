import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { listL1Decisions, recordL1Decision } from "../src/approval-queue.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-approval-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("recordL1Decision appends auditable pass-through decisions", (t) => {
  const root = workspace(t);
  const filePath = recordL1Decision(root, ".pi/runtime", {
    toolCallId: "call-1",
    toolName: "read",
    risk: "low",
    reason: "read-only operation",
    ruleVersion: "abc123"
  });
  assert.ok(filePath.endsWith("l1-decisions.jsonl"));
  const content = fs.readFileSync(filePath, "utf8").trim();
  const entry = JSON.parse(content);
  assert.equal(entry.toolName, "read");
  assert.equal(entry.risk, "low");
  assert.equal(entry.ruleVersion, "abc123");
  assert.ok(entry.decidedAt);
});

test("listL1Decisions returns newest first", (t) => {
  const root = workspace(t);
  recordL1Decision(root, ".pi/runtime", { toolCallId: "a", toolName: "read", risk: "low", ruleVersion: "v1" });
  recordL1Decision(root, ".pi/runtime", { toolCallId: "b", toolName: "write", risk: "medium", ruleVersion: "v2" });
  const decisions = listL1Decisions(root, ".pi/runtime");
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].toolCallId, "b");
  assert.equal(decisions[1].toolCallId, "a");
});

test("listL1Decisions tolerates corrupt lines and empty trail", (t) => {
  const root = workspace(t);
  assert.deepEqual(listL1Decisions(root, ".pi/runtime"), []);
  fs.mkdirSync(path.join(root, ".pi", "runtime", "approvals"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "runtime", "approvals", "l1-decisions.jsonl"), "not json\n{\"toolCallId\":\"ok\"}\n", "utf8");
  const decisions = listL1Decisions(root, ".pi/runtime");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].toolCallId, "ok");
});
