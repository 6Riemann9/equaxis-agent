import test from "node:test";
import assert from "node:assert/strict";
import { buildAdvisorRequest, consultAdvisor, shouldConsultAdvisor } from "../src/advisor.mjs";

test("advisor is optional and disabled by default", () => {
  assert.deepEqual(shouldConsultAdvisor({ kind: "tool_call", risk: "high" }, { enabled: false }), { consult: false, reason: "advisor disabled" });
});

test("advisor triggers on high-risk tools and complex plans", () => {
  const config = { enabled: true, triggers: ["high_risk_tool", "complex_plan"], complexPlanStepThreshold: 3 };
  assert.equal(shouldConsultAdvisor({ kind: "tool_call", risk: "high" }, config).consult, true);
  assert.equal(shouldConsultAdvisor({ kind: "plan", steps: 3 }, config).consult, true);
  assert.equal(shouldConsultAdvisor({ kind: "plan", steps: 2 }, config).consult, false);
});

test("advisor request redacts sensitive fields and remains recommendation-only", () => {
  const request = buildAdvisorRequest({
    kind: "result",
    needsReview: true,
    evidence: { apiKey: "short", note: "ordinary evidence" }
  }, { enabled: true, provider: "p", model: "m", triggers: ["result_review"] });
  assert.equal(request.consult, true);
  assert.equal(request.evidence.apiKey, "[REDACTED]");
  assert.equal(request.evidence.note, "ordinary evidence");
  assert.ok(request.constraints.some((item) => item.includes("Do not execute tools")));
});

test("consultAdvisor calls a supplied client only when triggered", async () => {
  const skipped = await consultAdvisor({ kind: "plan", steps: 1 }, { enabled: true, complexPlanStepThreshold: 4 }, async () => "no");
  assert.equal(skipped.consulted, false);
  const result = await consultAdvisor({ kind: "plan", steps: 5 }, { enabled: true, triggers: ["complex_plan"], complexPlanStepThreshold: 4 }, async () => ({ recommendation: "continue" }));
  assert.equal(result.consulted, true);
  assert.deepEqual(result.recommendation, { recommendation: "continue" });
});
