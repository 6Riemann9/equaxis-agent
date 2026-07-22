import test from "node:test";
import assert from "node:assert/strict";
import { createResultMiddleware, validateToolResult } from "../src/result-middleware.mjs";

test("distinguishes transport success from semantically complete result", () => {
  const contract = { required: ["ok", "data.findings"], nonEmptyArrays: ["data.findings"] };
  const incomplete = validateToolResult("analyze_logs", { ok: true, data: { findings: [] } }, contract);
  const complete = validateToolResult("analyze_logs", { ok: true, data: { findings: ["pool_exhausted"] } }, contract);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.usable, false);
  assert.equal(complete.complete, true);
});

test("requires evidence when a result is used for grounded answers", () => {
  const result = validateToolResult("search", { ok: true, data: { answer: "x" } }, { requiresEvidence: true });
  assert.deepEqual(result.missing, ["evidence"]);
});

test("middleware turns incomplete output into a structured execution failure", async () => {
  const middleware = createResultMiddleware({ search: { required: ["data.documents"] } });
  await assert.rejects(
    () => middleware({ toolName: "search" }, { ok: true, data: {} }),
    (error) => error.code === "RESULT_INCOMPLETE" && error.validation.missing[0] === "data.documents"
  );
});

