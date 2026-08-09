import fs from "node:fs";
import path from "node:path";

const UNIFIED_CONFIG_FILE = ".pi/equaxis.json";
const LEGACY_RELIABILITY_FILE = ".pi/reliability.json";
const LEGACY_MEMORY_FILE = ".pi/memory.json";

export const DEFAULT_EQUAXIS_CONFIG = Object.freeze({
  schemaVersion: 1,
  runtime: {
    profile: "standard",
    services: { config: true, diagnostics: true, trace: true, status: true }
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
    approval: {
      highRiskBash: true,
      writesOutsideWorkspace: true,
      externalEditPolicy: "prompt",
      externalEditRoots: [],
      sessionFork: false
    },
    limits: { maxToolCallsPerTurn: 30, maxHighRiskCallsPerTurn: 3, maxRepairAttemptsPerError: 2 },
    toolRouting: { enabled: true, maxCandidates: 5 }
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
    requestTimeoutMs: 60000
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
  subagents: {
    enabled: true,
    maxConcurrent: 2,
    piEntry: "",
    jsonArgs: [],
    budgets: {
      timeoutMs: null,
      maxRetries: 0
    },
    persistence: {
      enabled: true,
      rootDir: ".pi/runtime/subagents"
    },
    isolation: {
      enabled: true,
      scrubEnv: true,
      outputRoot: ".pi/runtime/isolated",
      extraEnvAllowlist: []
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
    if (!isPortableAbsolute(root)) {
      throw configError(configPath, "reliability.approval.externalEditRoots", "must contain absolute paths");
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

function mergeConfig(base, custom) {
  return {
    ...structuredClone(base),
    ...custom,
    runtime: { ...base.runtime, ...(custom.runtime ?? {}), services: { ...base.runtime.services, ...(custom.runtime?.services ?? {}) } },
    extensions: { ...base.extensions, ...(custom.extensions ?? {}) },
    reliability: {
      ...base.reliability,
      ...(custom.reliability ?? {}),
      trace: { ...base.reliability.trace, ...(custom.reliability?.trace ?? {}) },
      approval: { ...base.reliability.approval, ...(custom.reliability?.approval ?? {}) },
      limits: { ...base.reliability.limits, ...(custom.reliability?.limits ?? {}) },
      toolRouting: { ...base.reliability.toolRouting, ...(custom.reliability?.toolRouting ?? {}) }
    },
    advisor: { ...base.advisor, ...(custom.advisor ?? {}) },
    protocols: {
      lsp: { ...base.protocols.lsp, ...(custom.protocols?.lsp ?? {}) },
      dap: { ...base.protocols.dap, ...(custom.protocols?.dap ?? {}) }
    },
    memory: { ...base.memory, ...(custom.memory ?? {}) },
    skills: { ...base.skills, ...(custom.skills ?? {}) },
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
  if (config.schemaVersion !== 1) throw configError(configPath, "schemaVersion", "must be 1");

  assertRecord(config.runtime, configPath, "runtime");
  if (!["raw", "minimal", "standard", "full"].includes(config.runtime.profile)) {
    throw configError(configPath, "runtime.profile", "must be raw, minimal, standard, or full");
  }
  assertRecord(config.runtime.services, configPath, "runtime.services");
  for (const field of ["config", "diagnostics", "trace", "status"]) {
    assertBoolean(config.runtime.services[field], configPath, `runtime.services.${field}`);
  }

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
  for (const field of ["highRiskBash", "writesOutsideWorkspace", "sessionFork"]) {
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
  assertRecord(config.reliability.toolRouting, configPath, "reliability.toolRouting");
  assertBoolean(config.reliability.toolRouting.enabled, configPath, "reliability.toolRouting.enabled");
  assertInteger(config.reliability.toolRouting.maxCandidates, configPath, "reliability.toolRouting.maxCandidates", 1, 50);

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

  assertRecord(config.skills, configPath, "skills");
  assertBoolean(config.skills.enabled, configPath, "skills.enabled");
  assertBoolean(config.skills.autoInject, configPath, "skills.autoInject");
  assertLocalPath(config.skills.rootDir, configPath, "skills.rootDir");
  assertInteger(config.skills.maxContextTokens, configPath, "skills.maxContextTokens", 100, 1_000_000);
  if (!Array.isArray(config.skills.requiredNames) || config.skills.requiredNames.some((item) => typeof item !== "string" || !item.trim())) {
    throw configError(configPath, "skills.requiredNames", "must be an array of non-empty strings");
  }

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
  const merged = mergeConfig(DEFAULT_EQUAXIS_CONFIG, custom ?? {});
  const configPath = fs.existsSync(unifiedPath) ? unifiedPath : path.join(cwd, UNIFIED_CONFIG_FILE);
  return validateEquaxisConfig(merged, configPath);
}

export function unifiedConfigPath(cwd) {
  return path.join(cwd, UNIFIED_CONFIG_FILE);
}
