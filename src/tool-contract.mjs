// Unified tool execution contract (docs/ARCHITECTURE_REDUCTION_DIRECTIVE.md P4).
// Adapters only transport; policy only reads risk metadata; result middleware
// validates declared result contracts. These shapes are the canonical,
// versioned interchange form so one call never passes through two parallel
// retryers or two argument repairers.

export const TOOL_CONTRACT_VERSION = 1;

export function toolDescriptor(input = {}) {
  const name = String(input.name ?? "");
  if (!name) throw new Error("toolDescriptor requires a name");
  return {
    name,
    namespace: input.namespace ? String(input.namespace) : null,
    inputSchema: input.inputSchema ?? null,
    risk: String(input.risk ?? "medium"),
    sideEffect: String(input.sideEffect ?? "unknown"), // read | write | side-effect | unknown
    resultContract: input.resultContract ?? null
  };
}

export function createToolInvocation(input = {}) {
  if (!input.toolName) throw new Error("createToolInvocation requires toolName");
  return {
    invocationId: String(input.invocationId ?? input.toolCallId ?? `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    toolName: String(input.toolName),
    arguments: input.arguments ?? {},
    source: String(input.source ?? "agent"),
    risk: String(input.risk ?? "unknown"),
    reason: input.reason ? String(input.reason) : null,
    traceRef: input.traceRef ?? null
  };
}

export function createToolOutcome(input = {}) {
  const failed = input.ok === false || input.error !== undefined && input.error !== null;
  return {
    invocationId: String(input.invocationId ?? input.toolCallId ?? ""),
    toolName: String(input.toolName ?? ""),
    ok: !failed,
    result: failed ? null : (input.result ?? null),
    error: failed ? String(input.error ?? "tool failed") : null,
    evidence: input.evidence ?? null,
    retryable: Boolean(input.retryable ?? false),
    traceRef: input.traceRef ?? null
  };
}

export function riskMetadataFromPolicy(classification = {}) {
  return {
    risk: String(classification.risk ?? "unknown"),
    reason: classification.reason ? String(classification.reason) : null,
    approval: Boolean(classification.approval)
  };
}