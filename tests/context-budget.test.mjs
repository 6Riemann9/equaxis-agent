import test from "node:test";
import assert from "node:assert/strict";
import { buildSkillManifest, estimateTokens, selectWithinBudget } from "../src/context-budget.mjs";

test("selects high relevance context under a hard budget", () => {
  const result = selectWithinBudget([
    { name: "low", content: "x".repeat(100), relevance: 0.1 },
    { name: "high", content: "x".repeat(20), relevance: 1 },
    { name: "mid", content: "x".repeat(20), relevance: 0.5 }
  ], { maxTokens: 12 });
  assert.equal(result.selected[0].name, "high");
  assert.ok(result.omitted.some((item) => item.name === "low"));
  assert.ok(result.usedTokens <= result.maxTokens);
});

test("preserves required context and reports budget overflow", () => {
  const result = selectWithinBudget([{ name: "policy", content: "x".repeat(100) }], { maxTokens: 2, requiredNames: ["policy"] });
  assert.equal(result.selected[0].name, "policy");
  assert.ok(result.usedTokens > result.maxTokens);
});

test("builds compact skill manifests instead of loading full skill bodies", () => {
  const manifest = buildSkillManifest([{ name: "deploy", summary: "x".repeat(500), triggers: ["release"] }]);
  assert.equal(manifest[0].summary.length, 240);
  assert.equal(manifest[0].triggers[0], "release");
  assert.ok(manifest[0].estimatedTokens < estimateTokens("x".repeat(500)));
});

