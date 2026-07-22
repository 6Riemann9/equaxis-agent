import test from "node:test";
import assert from "node:assert/strict";
import { registerRepairAttempt, repairKey, validationFeedback } from "../src/tool-repair.mjs";

const validation = {
  code: "MISSING_ARGUMENT",
  field: "path",
  message: "path must be a non-empty string",
  retryable: true
};

test("bounds retries for the same tool error and field", () => {
  const attempts = new Map();
  const first = registerRepairAttempt(attempts, "write", validation, 2);
  const second = registerRepairAttempt(attempts, "write", validation, 2);
  const third = registerRepairAttempt(attempts, "write", validation, 2);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert.equal(third.attempt, 3);
  assert.equal(repairKey("write", validation), "write:MISSING_ARGUMENT:path");
});

test("non-retryable validation never becomes retryable", () => {
  const attempts = new Map();
  const result = registerRepairAttempt(attempts, "memory_remember", { ...validation, retryable: false }, 2);
  assert.equal(result.allowed, false);
  assert.equal(validationFeedback("memory_remember", { ...validation, retryable: false }, result).retryable, false);
});
