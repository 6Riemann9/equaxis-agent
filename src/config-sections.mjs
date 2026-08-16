/**
 * Curated metadata for the Equaxis settings UI: section tree with per-key
 * labels, types, and descriptions. Keys use dot paths into the layer objects
 * (e.g. "approval.highRiskBash"). Undocumented keys still render — the UI
 * falls back to the raw key name.
 */

export const CONFIG_SECTIONS = [
  {
    id: "agent",
    label: "Agent",
    file: "settings",
    description: "Model provider defaults and thinking level (.pi/settings.json)",
    keys: [
      { key: "defaultProvider", label: "Default provider", type: "string", description: "Provider used when none is chosen" },
      { key: "defaultModel", label: "Default model", type: "string", description: "Model used when none is chosen" },
      { key: "defaultThinkingLevel", label: "Default thinking level", type: "enum", options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], description: "Reasoning effort for the default model" },
      { key: "enabledModels", label: "Enabled models", type: "array", description: "Whitelist of provider/model pairs; empty shows the full catalog" },
      { key: "compaction.enabled", label: "Context compaction", type: "boolean", description: "Auto-compact long sessions" },
      { key: "compaction.reserveTokens", label: "Compaction reserve tokens", type: "number", description: "Tokens kept after compaction" }
    ]
  },
  {
    id: "reliability",
    label: "Governance",
    file: "equaxis",
    description: "Policy mode, approvals, limits and guardrails",
    keys: [
      { key: "mode", label: "Mode", type: "enum", options: ["enforce", "audit", "off"], description: "enforce blocks violations; audit logs them" },
      { key: "protectPaths", label: "Protected paths", type: "array", description: "Patterns never readable/writable by tools" },
      { key: "approval.highRiskBash", label: "High-risk bash approval", type: "boolean", description: "Require approval for dangerous shell commands" },
      { key: "approval.writesOutsideWorkspace", label: "Outside-workspace writes", type: "boolean", description: "Require approval for writes outside the project" },
      { key: "approval.externalEditPolicy", label: "External edit policy", type: "enum", options: ["prompt", "auto", "deny"], description: "How external edits are handled" },
      { key: "approval.sessionFork", label: "Session fork approval", type: "boolean", description: "Require approval before forking a session" },
      { key: "limits.maxToolCallsPerTurn", label: "Max tool calls per turn", type: "number", description: "Hard cap on tool calls in one turn" },
      { key: "limits.maxHighRiskCallsPerTurn", label: "Max high-risk calls per turn", type: "number", description: "Cap on dangerous calls before approval is forced" },
      { key: "toolRouting.enabled", label: "Tool routing", type: "boolean", description: "Route tool calls through the candidate ranking" },
      { key: "costBrake.enabled", label: "Cost brake", type: "boolean", description: "Stop work when the cost budget is exceeded" },
      { key: "commandAllowlist", label: "Bash allowlist", type: "object", description: "Read-only commands treated as LOW risk" }
    ]
  },
  {
    id: "memory",
    label: "Memory",
    file: "equaxis",
    description: "Short-term history, long-term drawers, knowledge graph and dream consolidation",
    keys: [
      { key: "enabled", label: "Enabled", type: "boolean", description: "Master switch for the memory system" },
      { key: "rootDir", label: "Data directory", type: "string", description: "Where memory data lives (gitignored)" },
      { key: "pythonCommand", label: "Python command", type: "string", description: "Interpreter running the memory bridge" },
      { key: "autoRecall", label: "Auto recall", type: "boolean", description: "Inject relevant memory before each turn" },
      { key: "recallLimit", label: "Recall limit", type: "number", description: "Max memories injected per turn" },
      { key: "maxContextChars", label: "Max context chars", type: "number", description: "Cap on recalled context" },
      { key: "dream.enabled", label: "Dream consolidation", type: "boolean", description: "Summarize history into long-term memory at session end" },
      { key: "dream.onShutdown", label: "Dream on shutdown", type: "boolean", description: "Run consolidation automatically at session end" },
      { key: "dream.model", label: "Dream model", type: "string", description: "Model used for extraction (defaults to the session model)" },
      { key: "governance.enabled", label: "Retention governance", type: "boolean", description: "Tiered retention and audit log" }
    ]
  },
  {
    id: "skills",
    label: "Skills",
    file: "equaxis",
    description: "SKILL.md loading, scoring and injection",
    keys: [
      { key: "enabled", label: "Enabled", type: "boolean", description: "Master switch" },
      { key: "rootDir", label: "Skills directory", type: "string", description: "Where SKILL.md files live" },
      { key: "autoInject", label: "Auto inject", type: "boolean", description: "Inject relevant skills into the system prompt" },
      { key: "maxContextTokens", label: "Max context tokens", type: "number", description: "Budget for injected skill content" },
      { key: "requiredNames", label: "Required skills", type: "array", description: "Skills always injected regardless of relevance" }
    ]
  },
  {
    id: "subagents",
    label: "Subagents",
    file: "equaxis",
    description: "DAG subagent engine: concurrency, budgets, persistence, isolation",
    keys: [
      { key: "enabled", label: "Enabled", type: "boolean", description: "Master switch" },
      { key: "maxConcurrent", label: "Max concurrent", type: "number", description: "Parallel subagent cap" },
      { key: "budgets.timeoutMs", label: "Timeout (ms)", type: "number", description: "Per-subagent timeout" },
      { key: "budgets.maxRetries", label: "Max retries", type: "number", description: "Retries before failing a subagent" },
      { key: "persistence.enabled", label: "Persistence", type: "boolean", description: "Record events and snapshots" },
      { key: "isolation.enabled", label: "Isolation", type: "boolean", description: "Scrub env and confine outputs" },
      { key: "isolation.worktree", label: "Worktree sandbox", type: "boolean", description: "Run subagents in a detached git worktree" }
    ]
  },
  {
    id: "evaluation",
    label: "Evaluation",
    file: "equaxis",
    description: "Eval loop and A/B decision thresholds",
    keys: [
      { key: "enabled", label: "Enabled", type: "boolean", description: "Record eval outcomes" },
      { key: "rootDir", label: "Data directory", type: "string", description: "Where eval events are persisted" },
      { key: "minSamples", label: "Min samples", type: "number", description: "Sample size before deciding A/B" },
      { key: "minSuccessRateDelta", label: "Min success delta", type: "number", description: "Required improvement to deploy" },
      { key: "maxLatencyRegression", label: "Max latency regression", type: "number", description: "Allowed latency increase ratio" },
      { key: "maxCostRegression", label: "Max cost regression", type: "number", description: "Allowed cost increase ratio" }
    ]
  },
  {
    id: "protocols",
    label: "Protocols",
    file: "equaxis",
    description: "LSP and DAP adapter processes",
    keys: [
      { key: "lsp.command", label: "LSP command", type: "string", description: "Language server executable" },
      { key: "lsp.args", label: "LSP args", type: "array", description: "Arguments (e.g. --stdio)" },
      { key: "lsp.requestTimeoutMs", label: "LSP timeout (ms)", type: "number", description: "Probe timeout" },
      { key: "dap.command", label: "DAP command", type: "string", description: "Debug adapter executable" },
      { key: "dap.args", label: "DAP args", type: "array", description: "Arguments" }
    ]
  },
  {
    id: "runtime",
    label: "Runtime",
    file: "equaxis",
    description: "Profile, shared services and release gates",
    keys: [
      { key: "profile", label: "Profile", type: "enum", options: ["minimal", "standard", "full"], description: "Which extension sets are active" },
      { key: "gates.enabled", label: "Release gates", type: "boolean", description: "Enforce eval benchmarks before release" }
    ]
  },
  {
    id: "extensions",
    label: "Extensions",
    file: "equaxis",
    description: "Extension manifest and enable/disable overrides",
    keys: [
      { key: "manifest", label: "Manifest", type: "string", description: "Path to the contracts manifest" },
      { key: "enabled", label: "Enabled", type: "array", description: "Extensions force-enabled for this project" },
      { key: "disabled", label: "Disabled", type: "array", description: "Extensions disabled for this project" }
    ]
  },
  {
    id: "advisor",
    label: "Advisor",
    file: "equaxis",
    description: "Recommendation advisor (not yet wired to an LLM)",
    keys: [
      { key: "enabled", label: "Enabled", type: "boolean", description: "Master switch" },
      { key: "provider", label: "Provider", type: "string", description: "LLM provider for advice" },
      { key: "model", label: "Model", type: "string", description: "LLM model for advice" }
    ]
  },
  {
    id: "codeGraph",
    label: "Code graph",
    file: "equaxis",
    description: "TS symbol / import / call index",
    keys: [
      { key: "enabled", label: "Enabled", type: "boolean", description: "Build and serve the code index" },
      { key: "rootDir", label: "Data directory", type: "string", description: "Where the index is stored" },
      { key: "includeDirs", label: "Include dirs", type: "array", description: "Directories indexed" },
      { key: "maxFiles", label: "Max files", type: "number", description: "Index size cap" }
    ]
  },
  {
    id: "goalState",
    label: "Long tasks",
    file: "equaxis",
    description: "Durable goal state with quotas and wake-up",
    keys: [
      { key: "enabled", label: "Enabled", type: "boolean", description: "Track durable goals" },
      { key: "defaultQuota", label: "Default quota", type: "number", description: "Default token quota per goal" }
    ]
  },
  {
    id: "intentGate",
    label: "Intent gate",
    file: "equaxis",
    description: "Pattern-based intent blocking before tool calls",
    keys: [
      { key: "enabled", label: "Enabled", type: "boolean", description: "Apply the intent patterns" },
      { key: "patterns", label: "Patterns", type: "array", description: "Intent patterns to block" }
    ]
  }
];

export function sectionMetadataById(id) {
  return CONFIG_SECTIONS.find((section) => section.id === id) ?? null;
}

/** Flatten a section's keys to dot-path rows, appending undocumented keys. */
export function sectionKeyRows(sectionId, layerObject) {
  const section = sectionMetadataById(sectionId);
  const known = new Set((section?.keys ?? []).map((entry) => entry.key));
  const rows = [...(section?.keys ?? [])];
  const walk = (prefix, value) => {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (known.has(path)) continue;
      if (child !== null && typeof child === "object" && !Array.isArray(child)) {
        walk(path, child);
      } else {
        rows.push({ key: path });
      }
    }
  };
  walk("", layerObject ?? {});
  return rows;
}

/** Read a dot path from a layer object (undefined when missing). */
export function getAtPath(object, path) {
  let current = object;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

/** Set (or delete when value === undefined) a dot path, returning the new object. */
export function setAtPath(object, path, value) {
  const parts = path.split(".");
  const result = JSON.parse(JSON.stringify(object ?? {}));
  let current = result;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (current[part] === null || typeof current[part] !== "object") current[part] = {};
    current = current[part];
  }
  const leaf = parts[parts.length - 1];
  if (value === undefined) delete current[leaf];
  else current[leaf] = value;
  return result;
}
