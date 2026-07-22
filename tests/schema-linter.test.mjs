import test from "node:test";
import assert from "node:assert/strict";
import { lintToolSchema } from "../src/schema-linter.mjs";

test("accepts a bounded, explicit tool contract", () => {
  const result = lintToolSchema({
    name: "search_knowledge",
    description: "Search approved knowledge sources and return evidence.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: { query: { type: "string", description: "Non-empty query" }, limit: { type: "integer", minimum: 1, maximum: 10, description: "Result count" } }
    },
    metadata: { risk: "low", readOnly: true }
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("flags missing required fields, extra properties and write metadata", () => {
  const result = lintToolSchema({
    name: "write_file", description: "Write a file.", inputSchema: { type: "object", required: ["path"], properties: {} },
    metadata: { readOnly: false }
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("required field")));
  assert.ok(result.warnings.some((warning) => warning.includes("additionalProperties")));
  assert.ok(result.warnings.some((warning) => warning.includes("idempotent")));
});

test("warns when a tool becomes a generic mega-tool", () => {
  const properties = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`field_${index}`, { type: "string", description: "field" }]));
  const result = lintToolSchema({ name: "execute", description: "Execute many unrelated operations in one place.", inputSchema: { type: "object", properties }, metadata: { risk: "high", readOnly: false, idempotent: true } });
  assert.ok(result.warnings.some((warning) => warning.includes("too many parameters")));
  assert.ok(result.warnings.some((warning) => warning.includes("generic tool name")));
});
