import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_CONTRACT_VERSION, createToolInvocation, createToolOutcome, riskMetadataFromPolicy, toolDescriptor } from "../src/tool-contract.mjs";

test("toolDescriptor normalizes name namespace risk and contracts", () => {
  const descriptor = toolDescriptor({ name: "write", namespace: "fs", risk: "high", sideEffect: "write", resultContract: { type: "object", required: ["path"] } });
  assert.equal(descriptor.name, "write");
  assert.equal(descriptor.namespace, "fs");
  assert.equal(descriptor.risk, "high");
  assert.equal(descriptor.sideEffect, "write");
  assert.deepEqual(descriptor.resultContract, { type: "object", required: ["path"] });
  assert.throws(() => toolDescriptor({}), /requires a name/);
});

test("createToolInvocation builds a stable invocation envelope", () => {
  const invocation = createToolInvocation({ toolCallId: "tc-1", toolName: "bash", arguments: { command: "ls" }, risk: "low", reason: "read-only" });
  assert.equal(invocation.invocationId, "tc-1");
  assert.equal(invocation.toolName, "bash");
  assert.equal(invocation.source, "agent");
  assert.equal(invocation.risk, "low");
  assert.equal(invocation.reason, "read-only");
  assert.throws(() => createToolInvocation({}), /requires toolName/);
});

test("createToolOutcome distinguishes success from failure with retryable", () => {
  const ok = createToolOutcome({ toolCallId: "tc-1", toolName: "read", result: "data", evidence: "file exists" });
  assert.equal(ok.ok, true);
  assert.equal(ok.result, "data");
  assert.equal(ok.error, null);
  const fail = createToolOutcome({ toolCallId: "tc-2", toolName: "edit", ok: false, error: "stale hash", retryable: true });
  assert.equal(fail.ok, false);
  assert.equal(fail.error, "stale hash");
  assert.equal(fail.retryable, true);
  assert.equal(fail.result, null);
});

test("riskMetadataFromPolicy maps policy classifications", () => {
  const metadata = riskMetadataFromPolicy({ risk: "blocked", reason: "possible raw secret", approval: false });
  assert.deepEqual(metadata, { risk: "blocked", reason: "possible raw secret", approval: false });
  assert.deepEqual(riskMetadataFromPolicy(), { risk: "unknown", reason: null, approval: false });
});

test("contract version is stable", () => {
  assert.equal(TOOL_CONTRACT_VERSION, 1);
});