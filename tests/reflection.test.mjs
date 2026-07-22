import test from "node:test";
import assert from "node:assert/strict";
import { reflectRun } from "../src/reflection.mjs";

test("derives evidence-backed lessons from run failures", () => {
  const result = reflectRun({ goal: "repair service", status: "failed", steps: [
    { id: "s1", toolName: "search", status: "failed", errorCode: "RESULT_INCOMPLETE" }
  ] });
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.lessons.map((lesson) => lesson.type), ["tool_failure", "result_incomplete"]);
  assert.equal(result.promotable, true);
});

test("does not invent lessons for a clean run", () => {
  const result = reflectRun({ goal: "read", status: "completed", steps: [{ id: "s1", toolName: "read", status: "completed" }] });
  assert.equal(result.lessonCount, 0);
  assert.equal(result.promotable, false);
});

