function rounded(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Number(Number(value).toFixed(digits));
}

function mean(values, digits = 4) {
  const usable = values.map(Number).filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return rounded(usable.reduce((sum, value) => sum + value, 0) / usable.length, digits);
}

function array(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function keyOf(record) {
  return [record.model.provider, record.model.id, record.tool.name, ...record.capabilities].join("|");
}

function groupKeyParts(key) {
  const [provider, model, tool, ...capabilities] = key.split("|");
  return { provider, model, tool, capabilities };
}

function normalizeOutcome(outcome) {
  if (outcome === true || outcome === "success" || outcome?.success === true) return "success";
  if (outcome === false || outcome === "failure" || outcome?.success === false) return "failure";
  if (typeof outcome === "string" && outcome.trim()) return outcome.trim();
  return "unknown";
}

export function createEvalEvent(input = {}) {
  const provider = String(input.model?.provider ?? input.provider ?? "unknown");
  const modelId = String(input.model?.id ?? input.modelId ?? "unknown");
  const toolName = String(input.tool?.name ?? input.toolName ?? "unknown");
  const capabilities = array(input.capabilities ?? input.capabilityTags ?? input.capability ?? "unlabeled");
  return {
    timestamp: input.timestamp ?? new Date().toISOString(),
    taskId: input.taskId ? String(input.taskId) : null,
    model: { provider, id: modelId },
    tool: { name: toolName, namespace: input.tool?.namespace ? String(input.tool.namespace) : null },
    capabilities: capabilities.length ? capabilities : ["unlabeled"],
    outcome: normalizeOutcome(input.outcome ?? input.success),
    errorCode: input.errorCode ? String(input.errorCode) : null,
    latencyMs: input.latencyMs ?? null,
    inputTokens: Number(input.inputTokens ?? 0),
    outputTokens: Number(input.outputTokens ?? 0),
    costUsd: input.costUsd ?? null,
    traceId: input.traceId ? String(input.traceId) : null
  };
}

export class EvalLoop {
  constructor(options = {}) {
    this.events = [];
    this.trace = options.trace ?? (() => {});
  }

  record(input) {
    const event = createEvalEvent(input);
    this.events.push(event);
    this.trace("eval_outcome_recorded", event);
    return event;
  }

  snapshot(filter = {}) {
    const events = this.events.filter((event) => {
      if (filter.provider && event.model.provider !== filter.provider) return false;
      if (filter.model && event.model.id !== filter.model) return false;
      if (filter.tool && event.tool.name !== filter.tool) return false;
      if (filter.capability && !event.capabilities.includes(filter.capability)) return false;
      return true;
    });
    const byKey = new Map();
    for (const event of events) {
      const key = keyOf(event);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(event);
    }
    const matrix = [...byKey.entries()].map(([key, rows]) => {
      const parts = groupKeyParts(key);
      const successes = rows.filter((row) => row.outcome === "success").length;
      const failures = rows.filter((row) => row.outcome === "failure").length;
      const errors = {};
      for (const row of rows) {
        if (!row.errorCode) continue;
        errors[row.errorCode] = (errors[row.errorCode] ?? 0) + 1;
      }
      return {
        ...parts,
        attempts: rows.length,
        successes,
        failures,
        successRate: rounded(successes / rows.length),
        averageLatencyMs: mean(rows.map((row) => row.latencyMs), 2),
        averageInputTokens: mean(rows.map((row) => row.inputTokens), 2),
        averageOutputTokens: mean(rows.map((row) => row.outputTokens), 2),
        averageCostUsd: mean(rows.map((row) => row.costUsd), 6),
        errorCodes: errors
      };
    }).sort((left, right) => left.provider.localeCompare(right.provider)
      || left.model.localeCompare(right.model)
      || left.tool.localeCompare(right.tool)
      || left.capabilities.join(",").localeCompare(right.capabilities.join(",")));
    const successes = events.filter((event) => event.outcome === "success").length;
    return {
      attempts: events.length,
      successes,
      failures: events.filter((event) => event.outcome === "failure").length,
      successRate: events.length ? rounded(successes / events.length) : null,
      matrix
    };
  }
}
