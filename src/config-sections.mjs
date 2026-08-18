/**
 * Curated metadata for the Equaxis settings UI: section tree with per-key
 * labels, types, and descriptions. Keys use dot paths into the layer objects
 * (e.g. "approval.highRiskBash"). Undocumented keys still render — the UI
 * falls back to the raw key name.
 *
 * Reorganized into 6 logical categories for better UX:
 * - providers: Model provider selection and thinking
 * - governance: Security, approvals, limits
 * - memory: Memory, code graph, wiki
 * - tasks: Subagents, goal state, refine
 * - extensions: Tools, skills, protocols
 * - monitoring: Evaluation, intent gate, runtime, compaction
 */

export const CONFIG_SECTIONS = [
  // ─── Providers ──────────────────────────────────────────────────────
  {
    id: "providers",
    label: "Providers",
    file: "equaxis",
    description: "Model provider selection, thinking levels, and advisor configuration",
    icon: "🧠",
    order: 1,
    keys: [
      // From runtime.profile
      { key: "runtime.profile", label: "Runtime profile", type: "enum", options: ["minimal", "standard", "full"], description: "Which extension sets are active" },
      // From advisor
      { key: "advisor.enabled", label: "Advisor enabled", type: "boolean", description: "Enable the recommendation advisor" },
      { key: "advisor.provider", label: "Advisor provider", type: "string", description: "LLM provider for advisor" },
      { key: "advisor.model", label: "Advisor model", type: "string", description: "LLM model for advisor" },
      { key: "advisor.mode", label: "Advisor mode", type: "enum", options: ["recommend", "review", "block_on_negative"], description: "Advisor operation mode" },
      // From agent settings (settings.json)
      { key: "defaultProvider", label: "Default provider", type: "string", description: "Provider used when none is chosen", file: "settings" },
      { key: "defaultModel", label: "Default model", type: "string", description: "Model used when none is chosen", file: "settings" },
      { key: "defaultThinkingLevel", label: "Thinking level", type: "enum", options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], description: "Reasoning effort for the default model", file: "settings" },
      { key: "enabledModels", label: "Enabled models", type: "array", description: "Whitelist of provider/model pairs; empty shows full catalog", file: "settings" }
    ]
  },

  // ─── Governance ─────────────────────────────────────────────────────
  {
    id: "governance",
    label: "Governance",
    file: "equaxis",
    description: "Policy mode, approvals, limits, and guardrails",
    icon: "🛡️",
    order: 2,
    keys: [
      { key: "reliability.mode", label: "Mode", type: "enum", options: ["enforce", "audit", "off"], description: "enforce blocks violations; audit logs them" },
      { key: "reliability.protectPaths", label: "Protected paths", type: "array", description: "Patterns never readable/writable by tools" },
      { key: "reliability.approval.highRiskBash", label: "High-risk bash approval", type: "boolean", description: "Require approval for dangerous shell commands" },
      { key: "reliability.approval.writesOutsideWorkspace", label: "Outside-workspace writes", type: "boolean", description: "Require approval for writes outside the project" },
      { key: "reliability.approval.externalEditPolicy", label: "External edit policy", type: "enum", options: ["prompt", "auto", "deny"], description: "How external edits are handled" },
      { key: "reliability.approval.sessionFork", label: "Session fork approval", type: "boolean", description: "Require approval before forking a session" },
      { key: "reliability.limits.maxToolCallsPerTurn", label: "Max tool calls per turn", type: "number", description: "Hard cap on tool calls in one turn" },
      { key: "reliability.limits.maxHighRiskCallsPerTurn", label: "Max high-risk calls per turn", type: "number", description: "Cap on dangerous calls before approval forced" },
      { key: "reliability.toolRouting.enabled", label: "Tool routing", type: "boolean", description: "Route tool calls through candidate ranking" },
      { key: "reliability.costBrake.enabled", label: "Cost brake", type: "boolean", description: "Stop work when cost budget exceeded" },
      { key: "reliability.commandAllowlist.enabled", label: "Bash allowlist", type: "boolean", description: "Read-only commands treated as LOW risk" }
    ]
  },

  // ─── Memory ─────────────────────────────────────────────────────────
  {
    id: "memory",
    label: "Memory",
    file: "equaxis",
    description: "Short-term history, long-term drawers, knowledge graph, code index, and wiki",
    icon: "🧠",
    order: 3,
    keys: [
      // Memory core
      { key: "memory.enabled", label: "Memory enabled", type: "boolean", description: "Master switch for the memory system" },
      { key: "memory.backend", label: "Backend", type: "enum", options: ["native", "python"], description: "Memory storage backend" },
      { key: "memory.rootDir", label: "Data directory", type: "string", description: "Where memory data lives (gitignored)" },
      { key: "memory.autoRecall", label: "Auto recall", type: "boolean", description: "Inject relevant memory before each turn" },
      { key: "memory.recallLimit", label: "Recall limit", type: "number", description: "Max memories injected per turn" },
      { key: "memory.maxContextChars", label: "Max context chars", type: "number", description: "Cap on recalled context" },
      // Dream consolidation
      { key: "memory.dream.enabled", label: "Dream consolidation", type: "boolean", description: "Summarize history into long-term memory" },
      { key: "memory.dream.onShutdown", label: "Dream on shutdown", type: "boolean", description: "Run consolidation at session end" },
      { key: "memory.dream.model", label: "Dream model", type: "string", description: "Model for extraction (defaults to session model)" },
      // Governance
      { key: "memory.governance.enabled", label: "Retention governance", type: "boolean", description: "Tiered retention and audit log" },
      // Segmentation
      { key: "memory.segmentation.enabled", label: "Segmentation", type: "boolean", description: "Split long memories into segments" },
      // Code graph
      { key: "codeGraph.enabled", label: "Code graph enabled", type: "boolean", description: "Build and serve the code index" },
      { key: "codeGraph.rootDir", label: "Code graph directory", type: "string", description: "Where the index is stored" },
      { key: "codeGraph.includeDirs", label: "Include dirs", type: "array", description: "Directories indexed" },
      { key: "codeGraph.maxFiles", label: "Max files", type: "number", description: "Index size cap" },
      // Wiki
      { key: "wiki.enabled", label: "Wiki enabled", type: "boolean", description: "Enable documentation wiki" },
      { key: "wiki.rootDir", label: "Wiki directory", type: "string", description: "Where wiki data lives" },
      { key: "wiki.includeDirs", label: "Wiki include dirs", type: "array", description: "Directories to index" }
    ]
  },

  // ─── Tasks ──────────────────────────────────────────────────────────
  {
    id: "tasks",
    label: "Tasks",
    file: "equaxis",
    description: "Subagent engine, durable goals, and optimization ledger",
    icon: "🤖",
    order: 4,
    keys: [
      // Subagents
      { key: "subagents.enabled", label: "Subagents enabled", type: "boolean", description: "Enable DAG subagent engine" },
      { key: "subagents.maxConcurrent", label: "Max concurrent", type: "number", description: "Parallel subagent cap" },
      { key: "subagents.budgets.timeoutMs", label: "Timeout (ms)", type: "number", description: "Per-subagent timeout" },
      { key: "subagents.budgets.maxRetries", label: "Max retries", type: "number", description: "Retries before failing" },
      { key: "subagents.persistence.enabled", label: "Persistence", type: "boolean", description: "Record events and snapshots" },
      { key: "subagents.isolation.enabled", label: "Isolation", type: "boolean", description: "Scrub env and confine outputs" },
      { key: "subagents.isolation.worktree", label: "Worktree sandbox", type: "boolean", description: "Run in detached git worktree" },
      // Goal state
      { key: "goalState.enabled", label: "Goal state enabled", type: "boolean", description: "Track durable goals" },
      { key: "goalState.rootDir", label: "Goals directory", type: "string", description: "Where goal state lives" },
      { key: "goalState.defaultQuota.tokenBudget", label: "Token budget", type: "number", description: "Default token quota per goal" },
      { key: "goalState.autoWake.enabled", label: "Auto wake", type: "boolean", description: "Scheduled auto-wake for goals" },
      // Refine
      { key: "refine.enabled", label: "Refine enabled", type: "boolean", description: "Optimization ledger" },
      { key: "refine.rootDir", label: "Refine directory", type: "string", description: "Where refine data lives" }
    ]
  },

  // ─── Extensions ─────────────────────────────────────────────────────
  {
    id: "extensions",
    label: "Extensions",
    file: "equaxis",
    description: "Extension manifest, skills, protocols, and tool configuration",
    icon: "🔧",
    order: 5,
    keys: [
      // Extensions
      { key: "extensions.manifest", label: "Manifest", type: "string", description: "Path to contracts manifest" },
      { key: "extensions.enabled", label: "Enabled extensions", type: "array", description: "Extensions force-enabled" },
      { key: "extensions.disabled", label: "Disabled extensions", type: "array", description: "Extensions disabled" },
      // Skills
      { key: "skills.enabled", label: "Skills enabled", type: "boolean", description: "Enable SKILL.md loading" },
      { key: "skills.rootDir", label: "Skills directory", type: "string", description: "Where SKILL.md files live" },
      { key: "skills.autoInject", label: "Auto inject", type: "boolean", description: "Inject relevant skills into system prompt" },
      { key: "skills.maxContextTokens", label: "Max context tokens", type: "number", description: "Budget for injected skill content" },
      { key: "skills.requiredNames", label: "Required skills", type: "array", description: "Skills always injected" },
      // Protocols
      { key: "protocols.lsp.command", label: "LSP command", type: "string", description: "Language server executable" },
      { key: "protocols.lsp.args", label: "LSP args", type: "array", description: "LSP arguments" },
      { key: "protocols.lsp.requestTimeoutMs", label: "LSP timeout (ms)", type: "number", description: "Probe timeout" },
      { key: "protocols.dap.command", label: "DAP command", type: "string", description: "Debug adapter executable" },
      { key: "protocols.dap.args", label: "DAP args", type: "array", description: "DAP arguments" }
    ]
  },

  // ─── Monitoring ─────────────────────────────────────────────────────
  {
    id: "monitoring",
    label: "Monitoring",
    file: "equaxis",
    description: "Evaluation loop, intent gate, runtime gates, and context compaction",
    icon: "📊",
    order: 6,
    keys: [
      // Evaluation
      { key: "evaluation.enabled", label: "Evaluation enabled", type: "boolean", description: "Record eval outcomes" },
      { key: "evaluation.rootDir", label: "Eval directory", type: "string", description: "Where eval events persist" },
      { key: "evaluation.minSamples", label: "Min samples", type: "number", description: "Sample size before A/B decision" },
      { key: "evaluation.minSuccessRateDelta", label: "Min success delta", type: "number", description: "Required improvement to deploy" },
      { key: "evaluation.maxLatencyRegression", label: "Max latency regression", type: "number", description: "Allowed latency increase ratio" },
      { key: "evaluation.maxCostRegression", label: "Max cost regression", type: "number", description: "Allowed cost increase ratio" },
      // Intent gate
      { key: "intentGate.enabled", label: "Intent gate enabled", type: "boolean", description: "Pattern-based intent blocking" },
      { key: "intentGate.patterns", label: "Intent patterns", type: "array", description: "Patterns to block" },
      // Runtime gates
      { key: "runtime.gates.enabled", label: "Release gates", type: "boolean", description: "Enforce eval benchmarks before release" },
      { key: "runtime.services.config", label: "Config service", type: "boolean", description: "Enable config service" },
      { key: "runtime.services.trace", label: "Trace service", type: "boolean", description: "Enable trace service" },
      // Compaction (from settings.json)
      { key: "compaction.enabled", label: "Compaction enabled", type: "boolean", description: "Auto-compact long sessions", file: "settings" },
      { key: "compaction.strategy", label: "Compaction strategy", type: "enum", options: ["snapcompact", "context-full", "handoff", "shake", "off"], description: "Compaction algorithm", file: "settings" },
      { key: "compaction.thresholdPercent", label: "Threshold percent", type: "number", description: "Percent of context to trigger compaction", file: "settings" },
      { key: "compaction.reserveTokens", label: "Reserve tokens", type: "number", description: "Tokens kept after compaction", file: "settings" }
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

  // Append any keys present in the layer object but not in the section metadata
  if (layerObject && typeof layerObject === "object") {
    for (const key of Object.keys(layerObject)) {
      if (!known.has(key)) {
        rows.push({ key, label: key, type: typeof layerObject[key] === "boolean" ? "boolean" : "string", description: "" });
      }
    }
  }
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
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (current[parts[i]] === undefined || current[parts[i]] === null) {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  if (value === undefined) {
    delete current[parts[parts.length - 1]];
  } else {
    current[parts[parts.length - 1]] = value;
  }
  return result;
}
