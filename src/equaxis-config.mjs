import fs from "node:fs";
import path from "node:path";

const UNIFIED_CONFIG_FILE = ".pi/equaxis.json";
const LEGACY_RELIABILITY_FILE = ".pi/reliability.json";
const LEGACY_MEMORY_FILE = ".pi/memory.json";

export const EQUAXIS_CONFIG_SCHEMA_VERSION = 1;

export const DEFAULT_EQUAXIS_CONFIG = Object.freeze({
  schemaVersion: EQUAXIS_CONFIG_SCHEMA_VERSION,
  runtime: {
    profile: "standard",
    services: { config: true, diagnostics: true, trace: true, status: true },
    gates: {
      enabled: true,
      minBenchmarkPassRate: 0.8,
      maxReliabilityRegression: 0.02,
      maxUnitCostUsd: 0.05,
      maxLatencyMs: 30000,
      minImprovementDelta: 0.01
    }
  },
  extensions: {
    manifest: ".pi/extensions/contracts.json",
    enabled: [],
    disabled: []
  },
  reliability: {
    mode: "enforce",
    traceDir: ".pi/runtime",
    trace: { maxFileBytes: 5 * 1024 * 1024, maxFiles: 3 },
    protectPaths: [".env", ".git/", "node_modules/", "*.pem", "*.key"],
    eval: {
      cohort: "",
      versionId: ""
    },
    approval: {
      highRiskBash: true,
      writesOutsideWorkspace: true,
      externalEditPolicy: "prompt",
      externalEditRoots: [],
      sessionFork: false,
      webQueue: { enabled: true, timeoutMs: 60000 },
      denyRephrase: true,
      batchPerTurn: true
    },
    limits: { maxToolCallsPerTurn: 30, maxHighRiskCallsPerTurn: 3, maxRepairAttemptsPerError: 2, maxRepeatedCalls: 3 },
    toolRouting: { enabled: true, maxCandidates: 5 },
    costBrake: { enabled: true, maxSessionCostUsd: 2.0, warnAtFraction: 0.8 },
    commandAllowlist: { enabled: true, extraCommands: [] }
  },
  advisor: {
    enabled: false,
    provider: "",
    model: "",
    mode: "recommend",
    triggers: ["high_risk_tool", "complex_plan", "result_review"],
    complexPlanStepThreshold: 4
  },
  memory: {
    enabled: true,
    pythonCommand: "python",
    rootDir: ".equaxis/memory",
    autoRecall: true,
    defaultWing: "equaxis",
    defaultRoom: "general",
    recallLimit: 5,
    maxContextChars: 8000,
    maxStoredMessageChars: 24000,
    requestTimeoutMs: 60000,
    governance: {
      enabled: true,
      auditPath: ".pi/runtime/memory-governance/memories.jsonl",
      retentionDays: { hot: 3650, warm: 365, cold: 180 }
    },
    dream: {
      enabled: true,
      onShutdown: false,
      maxEntries: 200,
      provider: "",
      model: ""
    },
    segmentation: {
      enabled: true,
      threshold: 0.75,
      maxSegmentChars: 3000
    }
  },
  skills: {
    enabled: true,
    rootDir: ".equaxis/skills",
    autoInject: true,
    maxContextTokens: 3000,
    requiredNames: []
  },
  protocols: {
    lsp: { command: "", args: [], cwd: "", requestTimeoutMs: 15_000, allowCommandOverride: false },
    dap: { command: "", args: [], cwd: "", requestTimeoutMs: 15_000, allowCommandOverride: false }
  },
  evaluation: {
    enabled: true,
    rootDir: ".pi/runtime/eval-loop",
    minSamples: 5,
    minSuccessRateDelta: 0.02,
    maxLatencyRegression: 0.1,
    maxCostRegression: 0.15,
    confidenceZ: 1.96
  },
  subagents: {
    enabled: true,
    maxConcurrent: 2,
    piEntry: "",
    jsonArgs: [],
    budgets: {
      timeoutMs: 60000,
      maxRetries: 1
    },
    persistence: {
      enabled: true,
      rootDir: ".pi/runtime/subagents"
    },
    evidence: {
      enabled: true
    },
    isolation: {
      enabled: true,
      scrubEnv: true,
      outputRoot: ".pi/runtime/isolated",
      extraEnvAllowlist: [],
      worktree: false
    }
  }
});

function configError(configPath, field, message) {
  return new Error(`Invalid Equaxis config ${configPath}: ${field} ${message}`);
}

function assertRecord(value, configPath, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError(configPath, field, "must be a JSON object");
  }
}

function assertBoolean(value, configPath, field) {
  if (typeof value !== "boolean") throw configError(configPath, field, "must be a boolean");
}

function assertInteger(value, configPath, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw configError(configPath, field, `must be an integer between ${min} and ${max}`);
  }
}

function assertNumber(value, configPath, field, min, max) {
  if (!Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) {
    throw configError(configPath, field, `must be a number between ${min} and ${max}`);
  }
}

function assertLocalPath(value, configPath, field) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw configError(configPath, field, "must be a non-empty path");
  }
  const relative = path.normalize(value);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw configError(configPath, field, "must stay inside the workspace");
  }
}

function isPortableAbsolute(value) {
  return path.isAbsolute(value) || /^([A-Za-z]:[\\/]|[\\/]{2})/.test(value);
}

function assertExternalRoots(value, configPath) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || item.includes("\0"))) {
    throw configError(configPath, "reliability.approval.externalEditRoots", "must be an array of non-empty paths");
  }
  for (const root of value) {
    if (root === "<workspace>") continue; // portable token, resolved at use time
    if (!isPortableAbsolute(root)) {
      throw configError(configPath, "reliability.approval.externalEditRoots", "must contain absolute paths or the <workspace> token");
    }
  }
}

function parseJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse Equaxis config ${filePath}: ${error.message}`);
  }
}

function readOptionalJson(cwd, relativePath) {
  const filePath = path.join(cwd, relativePath);
  return fs.existsSync(filePath) ? parseJson(filePath) : undefined;
}

function migrateSchemaV0(raw) {
  const migrated = structuredClone(raw);
  migrated.schemaVersion = EQUAXIS_CONFIG_SCHEMA_VERSION;
  if (typeof raw.runtimeProfile === "string") {
    migrated.runtime = { ...(migrated.runtime ?? {}), profile: raw.runtimeProfile };
    delete migrated.runtimeProfile;
  }
  if (typeof raw.reliabilityTraceDir === "string") {
    migrated.reliability = { ...(migrated.reliability ?? {}), traceDir: raw.reliabilityTraceDir };
    delete migrated.reliabilityTraceDir;
  }
  if (raw.protocols?.typescript) {
    migrated.protocols = { ...(migrated.protocols ?? {}), lsp: { ...(migrated.protocols.lsp ?? {}), ...raw.protocols.typescript } };
    delete migrated.protocols.typescript;
  }
  if (raw.protocols?.pythonDebug) {
    migrated.protocols = { ...(migrated.protocols ?? {}), dap: { ...(migrated.protocols.dap ?? {}), ...raw.protocols.pythonDebug } };
    delete migrated.protocols.pythonDebug;
  }
  if (raw.evaluation?.eventDir) {
    migrated.evaluation = { ...(migrated.evaluation ?? {}), rootDir: raw.evaluation.eventDir };
    delete migrated.evaluation.eventDir;
  }
  if (raw.evaluation?.costRegressionLimit !== undefined) {
    migrated.evaluation = { ...(migrated.evaluation ?? {}), maxCostRegression: raw.evaluation.costRegressionLimit };
    delete migrated.evaluation.costRegressionLimit;
  }
  if (raw.evaluation?.confidenceLevel !== undefined) {
    migrated.evaluation = { ...(migrated.evaluation ?? {}), confidenceZ: raw.evaluation.confidenceLevel };
    delete migrated.evaluation.confidenceLevel;
  }
  if (raw.subagents?.timeoutMs !== undefined || raw.subagents?.maxRetries !== undefined) {
    migrated.subagents = {
      ...(migrated.subagents ?? {}),
      budgets: {
        ...(migrated.subagents?.budgets ?? {}),
        ...(raw.subagents.timeoutMs !== undefined ? { timeoutMs: raw.subagents.timeoutMs } : {}),
        ...(raw.subagents.maxRetries !== undefined ? { maxRetries: raw.subagents.maxRetries } : {})
      }
    };
    delete migrated.subagents.timeoutMs;
    delete migrated.subagents.maxRetries;
  }
  if (raw.subagents?.stateDir) {
    migrated.subagents = { ...(migrated.subagents ?? {}), persistence: { ...(migrated.subagents?.persistence ?? {}), rootDir: raw.subagents.stateDir } };
    delete migrated.subagents.stateDir;
  }
  if (raw.subagents?.isolationOutputRoot) {
    migrated.subagents = { ...(migrated.subagents ?? {}), isolation: { ...(migrated.subagents?.isolation ?? {}), outputRoot: raw.subagents.isolationOutputRoot } };
    delete migrated.subagents.isolationOutputRoot;
  }
  return migrated;
}

export function migrateEquaxisConfig(raw, configPath = UNIFIED_CONFIG_FILE) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const version = raw.schemaVersion ?? EQUAXIS_CONFIG_SCHEMA_VERSION;
  if (version === EQUAXIS_CONFIG_SCHEMA_VERSION) return raw;
  if (version === 0) return migrateSchemaV0(raw);
  throw configError(configPath, "schemaVersion", `unsupported version ${version}; expected ${EQUAXIS_CONFIG_SCHEMA_VERSION}`);
}

function assertKnownKeys(value, field, baseValue, configPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (!baseValue || typeof baseValue !== "object" || Array.isArray(baseValue)) return;
  const known = new Set(Object.keys(baseValue));
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw configError(configPath, `${field}.${key}`, `unknown key (known: ${[...known].sort().join(", ")})`);
    }
  }
}

function mergeConfig(base, custom) {
  // DSH-style discipline: unknown keys in custom config are rejected so a
  // typo surfaces at load time instead of being silently merged away.
  const SECTIONS = ["runtime", "extensions", "reliability", "advisor", "protocols", "memory", "skills", "evaluation", "subagents"];
  const SUB_SECTIONS = [
    ["runtime", "services"], ["runtime", "gates"],
    ["reliability", "trace"], ["reliability", "approval"], ["reliability", "limits"], ["reliability", "toolRouting"], ["reliability", "eval"],
    ["protocols", "lsp"], ["protocols", "dap"],
    ["memory", "governance"], ["memory", "dream"], ["memory", "segmentation"],
    ["subagents", "budgets"], ["subagents", "persistence"], ["subagents", "isolation"], ["subagents", "evidence"]
  ];
  for (const section of SECTIONS) {
    if (custom[section]) assertKnownKeys(custom[section], `custom.${section}`, base[section], UNIFIED_CONFIG_FILE);
  }
  for (const [section, sub] of SUB_SECTIONS) {
    if (custom[section]?.[sub]) assertKnownKeys(custom[section][sub], `custom.${section}.${sub}`, base[section]?.[sub], UNIFIED_CONFIG_FILE);
  }
  return {
    ...structuredClone(base),
    ...custom,
    runtime: {
      ...base.runtime,
      ...(custom.runtime ?? {}),
      services: { ...base.runtime.services, ...(custom.runtime?.services ?? {}) },
      gates: { ...base.runtime.gates, ...(custom.runtime?.gates ?? {}) }
    },
    extensions: { ...base.extensions, ...(custom.extensions ?? {}) },
    reliability: {
      ...base.reliability,
      ...(custom.reliability ?? {}),
      trace: { ...base.reliability.trace, ...(custom.reliability?.trace ?? {}) },
      approval: { ...base.reliability.approval, ...(custom.reliability?.approval ?? {}) },
      limits: { ...base.reliability.limits, ...(custom.reliability?.limits ?? {}) },
      toolRouting: { ...base.reliability.toolRouting, ...(custom.reliability?.toolRouting ?? {}) },
      eval: { ...base.reliability.eval, ...(custom.reliability?.eval ?? {}) }
    },
    advisor: { ...base.advisor, ...(custom.advisor ?? {}) },
    protocols: {
      lsp: { ...base.protocols.lsp, ...(custom.protocols?.lsp ?? {}) },
      dap: { ...base.protocols.dap, ...(custom.protocols?.dap ?? {}) }
    },
    memory: {
      ...base.memory,
      ...(custom.memory ?? {}),
      governance: {
        ...base.memory.governance,
        ...(custom.memory?.governance ?? {}),
        retentionDays: { ...base.memory.governance.retentionDays, ...(custom.memory?.governance?.retentionDays ?? {}) }
      },
      dream: { ...base.memory.dream, ...(custom.memory?.dream ?? {}) }
    },
    skills: { ...base.skills, ...(custom.skills ?? {}) },
    evaluation: { ...base.evaluation, ...(custom.evaluation ?? {}) },
    subagents: {
      ...base.subagents,
      ...(custom.subagents ?? {}),
      budgets: { ...base.subagents.budgets, ...(custom.subagents?.budgets ?? {}) },
      persistence: { ...base.subagents.persistence, ...(custom.subagents?.persistence ?? {}) },
      isolation: { ...base.subagents.isolation, ...(custom.subagents?.isolation ?? {}) }
    }
  };
}

export function validateEquaxisConfig(config, configPath = UNIFIED_CONFIG_FILE) {
  assertRecord(config, configPath, "root");
  if (config.schemaVersion !== EQUAXIS_CONFIG_SCHEMA_VERSION) {
    throw configError(configPath, "schemaVersion", `unsupported version ${config.schemaVersion}; expected ${EQUAXIS_CONFIG_SCHEMA_VERSION}`);
  }

  assertRecord(config.runtime, configPath, "runtime");
  if (!["raw", "minimal", "standard", "full"].includes(config.runtime.profile)) {
    throw configError(configPath, "runtime.profile", "must be raw, minimal, standard, or full");
  }
  assertRecord(config.runtime.services, configPath, "runtime.services");
  for (const field of ["config", "diagnostics", "trace", "status"]) {
    assertBoolean(config.runtime.services[field], configPath, `runtime.services.${field}`);
  }
  assertRecord(config.runtime.gates, configPath, "runtime.gates");
  assertBoolean(config.runtime.gates.enabled, configPath, "runtime.gates.enabled");
  assertNumber(config.runtime.gates.minBenchmarkPassRate, configPath, "runtime.gates.minBenchmarkPassRate", 0, 1);
  assertNumber(config.runtime.gates.maxReliabilityRegression, configPath, "runtime.gates.maxReliabilityRegression", 0, 10);
  assertNumber(config.runtime.gates.maxUnitCostUsd, configPath, "runtime.gates.maxUnitCostUsd", 0, 1000000);
  assertInteger(config.runtime.gates.maxLatencyMs, configPath, "runtime.gates.maxLatencyMs", 1, 600000);
  assertNumber(config.runtime.gates.minImprovementDelta, configPath, "runtime.gates.minImprovementDelta", -10, 10);

  assertRecord(config.extensions, configPath, "extensions");
  assertLocalPath(config.extensions.manifest, configPath, "extensions.manifest");
  for (const field of ["enabled", "disabled"]) {
    if (!Array.isArray(config.extensions[field]) || config.extensions[field].some((item) => typeof item !== "string" || !item.trim())) {
      throw configError(configPath, `extensions.${field}`, "must be an array of non-empty strings");
    }
  }
  const extensionOverlap = config.extensions.enabled.filter((id) => config.extensions.disabled.includes(id));
  if (extensionOverlap.length) throw configError(configPath, "extensions", `enabled and disabled overlap: ${extensionOverlap.join(", ")}`);

  assertRecord(config.reliability, configPath, "reliability");
  if (!["enforce", "audit", "off"].includes(config.reliability.mode)) {
    throw configError(configPath, "reliability.mode", "must be enforce, audit, or off");
  }
  assertLocalPath(config.reliability.traceDir, configPath, "reliability.traceDir");
  if (!Array.isArray(config.reliability.protectPaths) || config.reliability.protectPaths.some((item) => typeof item !== "string" || !item.trim())) {
    throw configError(configPath, "reliability.protectPaths", "must be an array of non-empty strings");
  }
  assertRecord(config.reliability.trace, configPath, "reliability.trace");
  assertInteger(config.reliability.trace.maxFileBytes, configPath, "reliability.trace.maxFileBytes", 4096, 1024 * 1024 * 1024);
  assertInteger(config.reliability.trace.maxFiles, configPath, "reliability.trace.maxFiles", 1, 20);
  assertRecord(config.reliability.approval, configPath, "reliability.approval");
  for (const field of ["highRiskBash", "writesOutsideWorkspace", "sessionFork", "denyRephrase", "batchPerTurn"]) {
    assertBoolean(config.reliability.approval[field], configPath, `reliability.approval.${field}`);
  }
  if (!["prompt", "auto", "deny"].includes(config.reliability.approval.externalEditPolicy)) {
    throw configError(configPath, "reliability.approval.externalEditPolicy", "must be prompt, auto, or deny");
  }
  assertExternalRoots(config.reliability.approval.externalEditRoots, configPath);
  if (config.reliability.approval.externalEditPolicy === "auto" && config.reliability.approval.externalEditRoots.length === 0) {
    throw configError(configPath, "reliability.approval.externalEditRoots", "must not be empty when externalEditPolicy is auto");
  }
  assertRecord(config.reliability.limits, configPath, "reliability.limits");
  assertInteger(config.reliability.limits.maxToolCallsPerTurn, configPath, "reliability.limits.maxToolCallsPerTurn", 1, 1000);
  assertInteger(config.reliability.limits.maxHighRiskCallsPerTurn, configPath, "reliability.limits.maxHighRiskCallsPerTurn", 0, 100);
  assertInteger(config.reliability.limits.maxRepairAttemptsPerError, configPath, "reliability.limits.maxRepairAttemptsPerError", 0, 10);
  assertInteger(config.reliability.limits.maxRepeatedCalls, configPath, "reliability.limits.maxRepeatedCalls", 1, 50);
  assertRecord(config.reliability.toolRouting, configPath, "reliability.toolRouting");
  assertBoolean(config.reliability.toolRouting.enabled, configPath, "reliability.toolRouting.enabled");
  assertInteger(config.reliability.toolRouting.maxCandidates, configPath, "reliability.toolRouting.maxCandidates", 1, 50);
  assertRecord(config.reliability.commandAllowlist, configPath, "reliability.commandAllowlist");
  assertBoolean(config.reliability.commandAllowlist.enabled, configPath, "reliability.commandAllowlist.enabled");
  if (!Array.isArray(config.reliability.commandAllowlist.extraCommands) || config.reliability.commandAllowlist.extraCommands.some((item) => typeof item !== "string" || !item.trim())) {
    throw configError(configPath, "reliability.commandAllowlist.extraCommands", "must be an array of non-empty strings");
  }
  assertRecord(config.reliability.costBrake, configPath, "reliability.costBrake");
  assertBoolean(config.reliability.costBrake.enabled, configPath, "reliability.costBrake.enabled");
  if (!Number.isFinite(config.reliability.costBrake.maxSessionCostUsd) || config.reliability.costBrake.maxSessionCostUsd < 0.01) {
    throw configError(configPath, "reliability.costBrake.maxSessionCostUsd", "must be a positive number");
  }
  if (!Number.isFinite(config.reliability.costBrake.warnAtFraction) || config.reliability.costBrake.warnAtFraction < 0.1 || config.reliability.costBrake.warnAtFraction > 1) {
    throw configError(configPath, "reliability.costBrake.warnAtFraction", "must be between 0.1 and 1");
  }

  assertRecord(config.advisor, configPath, "advisor");
  assertBoolean(config.advisor.enabled, configPath, "advisor.enabled");
  if (!["recommend", "block_on_negative"].includes(config.advisor.mode)) {
    throw configError(configPath, "advisor.mode", "must be recommend or block_on_negative");
  }
  for (const field of ["provider", "model"]) {
    if (typeof config.advisor[field] !== "string" || config.advisor[field].includes("\0")) {
      throw configError(configPath, `advisor.${field}`, "must be a string");
    }
  }
  if (!Array.isArray(config.advisor.triggers) || config.advisor.triggers.some((item) => typeof item !== "string" || !item.trim())) {
    throw configError(configPath, "advisor.triggers", "must be an array of non-empty strings");
  }
  assertInteger(config.advisor.complexPlanStepThreshold, configPath, "advisor.complexPlanStepThreshold", 1, 100);

  assertRecord(config.protocols, configPath, "protocols");
  for (const kind of ["lsp", "dap"]) {
    const protocol = config.protocols[kind];
    assertRecord(protocol, configPath, `protocols.${kind}`);
    for (const field of ["command", "cwd"]) {
      if (typeof protocol[field] !== "string" || protocol[field].includes("\0")) {
        throw configError(configPath, `protocols.${kind}.${field}`, "must be a string");
      }
    }
    if (protocol.cwd) assertLocalPath(protocol.cwd, configPath, `protocols.${kind}.cwd`);
    if (!Array.isArray(protocol.args) || protocol.args.some((item) => typeof item !== "string" || item.includes("\0"))) {
      throw configError(configPath, `protocols.${kind}.args`, "must be an array of strings");
    }
    assertInteger(protocol.requestTimeoutMs, configPath, `protocols.${kind}.requestTimeoutMs`, 100, 120_000);
    assertBoolean(protocol.allowCommandOverride, configPath, `protocols.${kind}.allowCommandOverride`);
  }

  assertRecord(config.memory, configPath, "memory");
  for (const field of ["enabled", "autoRecall"]) assertBoolean(config.memory[field], configPath, `memory.${field}`);
  for (const field of ["pythonCommand", "rootDir", "defaultWing", "defaultRoom"]) {
    if (typeof config.memory[field] !== "string" || !config.memory[field].trim() || config.memory[field].includes("\0")) {
      throw configError(configPath, `memory.${field}`, "must be a non-empty string");
    }
  }
  assertLocalPath(config.memory.rootDir, configPath, "memory.rootDir");
  assertInteger(config.memory.recallLimit, configPath, "memory.recallLimit", 1, 100);
  assertInteger(config.memory.maxContextChars, configPath, "memory.maxContextChars", 256, 1_000_000);
  assertInteger(config.memory.maxStoredMessageChars, configPath, "memory.maxStoredMessageChars", 256, 1_000_000);
  assertInteger(config.memory.requestTimeoutMs, configPath, "memory.requestTimeoutMs", 100, 600_000);
  assertRecord(config.memory.governance, configPath, "memory.governance");
  assertBoolean(config.memory.governance.enabled, configPath, "memory.governance.enabled");
  assertLocalPath(config.memory.governance.auditPath, configPath, "memory.governance.auditPath");
  assertRecord(config.memory.governance.retentionDays, configPath, "memory.governance.retentionDays");
  for (const tier of ["hot", "warm", "cold"]) {
    assertInteger(config.memory.governance.retentionDays[tier], configPath, `memory.governance.retentionDays.${tier}`, 1, 36500);
  }

  assertRecord(config.skills, configPath, "skills");
  assertBoolean(config.skills.enabled, configPath, "skills.enabled");
  assertBoolean(config.skills.autoInject, configPath, "skills.autoInject");
  assertLocalPath(config.skills.rootDir, configPath, "skills.rootDir");
  assertInteger(config.skills.maxContextTokens, configPath, "skills.maxContextTokens", 100, 1_000_000);
  if (!Array.isArray(config.skills.requiredNames) || config.skills.requiredNames.some((item) => typeof item !== "string" || !item.trim())) {
    throw configError(configPath, "skills.requiredNames", "must be an array of non-empty strings");
  }

  assertRecord(config.evaluation, configPath, "evaluation");
  assertBoolean(config.evaluation.enabled, configPath, "evaluation.enabled");
  assertLocalPath(config.evaluation.rootDir, configPath, "evaluation.rootDir");
  assertInteger(config.evaluation.minSamples, configPath, "evaluation.minSamples", 1, 100000);
  assertNumber(config.evaluation.minSuccessRateDelta, configPath, "evaluation.minSuccessRateDelta", 0, 1);
  assertNumber(config.evaluation.maxLatencyRegression, configPath, "evaluation.maxLatencyRegression", 0, 10);
  assertNumber(config.evaluation.maxCostRegression, configPath, "evaluation.maxCostRegression", 0, 10);
  assertNumber(config.evaluation.confidenceZ, configPath, "evaluation.confidenceZ", 0, 10);

  assertRecord(config.subagents, configPath, "subagents");
  assertBoolean(config.subagents.enabled, configPath, "subagents.enabled");
  assertInteger(config.subagents.maxConcurrent, configPath, "subagents.maxConcurrent", 1, 32);
  if (typeof config.subagents.piEntry !== "string" || config.subagents.piEntry.includes("\0")) {
    throw configError(configPath, "subagents.piEntry", "must be a string");
  }
  if (!Array.isArray(config.subagents.jsonArgs) || config.subagents.jsonArgs.some((item) => typeof item !== "string")) {
    throw configError(configPath, "subagents.jsonArgs", "must be an array of strings");
  }
  assertRecord(config.subagents.budgets, configPath, "subagents.budgets");
  if (config.subagents.budgets.timeoutMs !== null) {
    assertInteger(config.subagents.budgets.timeoutMs, configPath, "subagents.budgets.timeoutMs", 100, 600_000);
  }
  assertInteger(config.subagents.budgets.maxRetries, configPath, "subagents.budgets.maxRetries", 0, 5);
  assertRecord(config.subagents.persistence, configPath, "subagents.persistence");
  assertBoolean(config.subagents.persistence.enabled, configPath, "subagents.persistence.enabled");
  assertLocalPath(config.subagents.persistence.rootDir, configPath, "subagents.persistence.rootDir");
  assertRecord(config.subagents.isolation, configPath, "subagents.isolation");
  assertBoolean(config.subagents.isolation.enabled, configPath, "subagents.isolation.enabled");
  assertBoolean(config.subagents.isolation.scrubEnv, configPath, "subagents.isolation.scrubEnv");
  assertBoolean(config.subagents.isolation.worktree, configPath, "subagents.isolation.worktree");
  assertLocalPath(config.subagents.isolation.outputRoot, configPath, "subagents.isolation.outputRoot");
  if (!Array.isArray(config.subagents.isolation.extraEnvAllowlist) || config.subagents.isolation.extraEnvAllowlist.some((item) => typeof item !== "string" || !item.trim())) {
    throw configError(configPath, "subagents.isolation.extraEnvAllowlist", "must be an array of non-empty strings");
  }
  return config;
}

export function loadEquaxisConfig(cwd) {
  const unifiedPath = path.join(cwd, UNIFIED_CONFIG_FILE);
  const custom = fs.existsSync(unifiedPath)
    ? parseJson(unifiedPath)
    : {
        reliability: readOptionalJson(cwd, LEGACY_RELIABILITY_FILE),
        memory: readOptionalJson(cwd, LEGACY_MEMORY_FILE)
      };
  const configPath = fs.existsSync(unifiedPath) ? unifiedPath : path.join(cwd, UNIFIED_CONFIG_FILE);
  const migrated = migrateEquaxisConfig(custom ?? {}, configPath);
  const merged = mergeConfig(DEFAULT_EQUAXIS_CONFIG, migrated ?? {});
  return validateEquaxisConfig(merged, configPath);
}

export function unifiedConfigPath(cwd) {
  return path.join(cwd, UNIFIED_CONFIG_FILE);
}
