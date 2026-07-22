export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(text.length / 4);
}

function relevance(item) {
  return Number(item.relevance ?? item.score ?? 0) + Number(item.priority ?? 0) * 0.1;
}

/** Select context items under a hard token budget while preserving required items. */
export function selectWithinBudget(items, options = {}) {
  const maxTokens = Math.max(1, Math.floor(Number(options.maxTokens ?? 2000)));
  const required = new Set(options.requiredNames ?? []);
  const ordered = [...items].sort((left, right) => {
    const requiredDelta = Number(required.has(right.name)) - Number(required.has(left.name));
    return requiredDelta || relevance(right) - relevance(left) || String(left.name).localeCompare(String(right.name));
  });
  const selected = [];
  const omitted = [];
  let usedTokens = 0;
  for (const item of ordered) {
    const tokens = estimateTokens(item.content ?? item.summary ?? item);
    if (required.has(item.name) || usedTokens + tokens <= maxTokens) {
      selected.push({ ...item, estimatedTokens: tokens });
      usedTokens += tokens;
    } else omitted.push({ name: item.name, estimatedTokens: tokens, reason: "context_budget" });
  }
  return { selected, omitted, usedTokens, maxTokens, utilization: Number((usedTokens / maxTokens).toFixed(4)) };
}

export function buildSkillManifest(skills) {
  return skills.map((skill) => ({
    name: skill.name,
    summary: String(skill.summary ?? "").slice(0, 240),
    triggers: [...(skill.triggers ?? [])],
    estimatedTokens: estimateTokens(String(skill.summary ?? "").slice(0, 240) || skill.name)
  }));
}
