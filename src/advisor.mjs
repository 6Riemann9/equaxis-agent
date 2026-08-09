import { RISK } from "./policy.mjs";

const DEFAULT_TRIGGERS = Object.freeze(["high_risk_tool", "complex_plan", "result_review"]);

export function shouldConsultAdvisor(input = {}, config = {}) {
  const advisor = config.advisor ?? config;
  if (!advisor?.enabled) return { consult: false, reason: "advisor disabled" };
  const triggers = new Set(advisor.triggers ?? DEFAULT_TRIGGERS);
  if (input.kind === "tool_call" && input.risk === RISK.HIGH && triggers.has("high_risk_tool")) {
    return { consult: true, reason: "high risk tool call" };
  }
  if (input.kind === "plan" && Number(input.steps ?? 0) >= Number(advisor.complexPlanStepThreshold ?? 4) && triggers.has("complex_plan")) {
    return { consult: true, reason: "complex plan" };
  }
  if (input.kind === "result" && input.needsReview === true && triggers.has("result_review")) {
    return { consult: true, reason: "result review requested" };
  }
  return { consult: false, reason: "no advisor trigger matched" };
}

function redact(value) {
  const sensitive = /^(?:api[_-]?key|password|secret|token|access[_-]?token|auth[_-]?token|private[_-]?key)$/i;
  if (typeof value === "string") {
    return value.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sensitive.test(key) ? "[REDACTED]" : redact(child)]));
  }
  return value;
}

export function buildAdvisorRequest(input = {}, config = {}) {
  const advisor = config.advisor ?? config;
  const decision = shouldConsultAdvisor(input, advisor);
  return {
    enabled: Boolean(advisor?.enabled),
    consult: decision.consult,
    reason: decision.reason,
    provider: advisor?.provider ?? null,
    model: advisor?.model ?? null,
    mode: advisor?.mode ?? "recommend",
    question: input.question ?? "Review this Equaxis decision and return risks, recommendation, and required evidence.",
    evidence: redact(input.evidence ?? {}),
    constraints: [
      "Do not execute tools.",
      "Do not approve actions directly; return a recommendation only.",
      "Base the recommendation only on supplied evidence."
    ]
  };
}

export async function consultAdvisor(input = {}, config = {}, client) {
  const request = buildAdvisorRequest(input, config);
  if (!request.consult) return { consulted: false, request, recommendation: null };
  if (!client) return { consulted: false, request, recommendation: null, skipped: "advisor client unavailable" };
  const recommendation = await client(request);
  return { consulted: true, request, recommendation };
}
