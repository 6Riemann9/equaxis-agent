import path from "node:path";
import fs from "node:fs";

export const RISK = Object.freeze({ LOW: "low", MEDIUM: "medium", HIGH: "high", BLOCKED: "blocked" });

const HIGH_RISK_BASH = [
  { pattern: /\b(?:rm|del)\b[^\r\n]*(?:-r(?:f)?\b|\/s\b|\/q\b)/i, reason: "recursive deletion" },
  { pattern: /\bRemove-Item\b[^\r\n]*-Recurse\b/i, reason: "recursive deletion" },
  { pattern: /\b(git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f)/i, reason: "destructive git operation" },
  { pattern: /\b(format|mkfs|diskpart)\b/i, reason: "disk modification" },
  { pattern: /\b(shutdown|reboot|Stop-Computer|Restart-Computer)\b/i, reason: "system shutdown" },
  { pattern: /\b(sudo|runas)\b/i, reason: "privilege escalation" },
  { pattern: /\b(chmod|chown)\b.*\b777\b/i, reason: "unsafe permissions" },
  { pattern: /\b(curl|wget|Invoke-WebRequest)\b.*\|\s*(sh|bash|pwsh|powershell)/i, reason: "remote script execution" }
];

const MEDIUM_RISK_BASH = [
  { pattern: /\b(npm|pnpm|yarn|pip|cargo)\s+(install|add)\b/i, reason: "dependency mutation" },
  { pattern: /\b(git\s+(commit|push|merge|rebase)|gh\s+pr)\b/i, reason: "repository mutation" },
  { pattern: /\b(docker|kubectl|terraform)\b/i, reason: "infrastructure command" }
];

export function classifyBash(command) {
  const high = HIGH_RISK_BASH.find(({ pattern }) => pattern.test(command));
  if (high) return { risk: RISK.HIGH, reason: high.reason };
  const medium = MEDIUM_RISK_BASH.find(({ pattern }) => pattern.test(command));
  if (medium) return { risk: RISK.MEDIUM, reason: medium.reason };
  return { risk: RISK.LOW, reason: "read-only or low-risk command" };
}

export function normalizeForPolicy(value) {
  return String(value ?? "").replaceAll("\\", "/").toLowerCase();
}

export function matchesProtectedPath(targetPath, patterns) {
  const normalized = normalizeForPolicy(targetPath);
  return patterns.find((rawPattern) => {
    const pattern = normalizeForPolicy(rawPattern);
    if (pattern.startsWith("*.")) return normalized.endsWith(pattern.slice(1));
    return normalized.includes(pattern);
  }) ?? null;
}

export function isOutsideWorkspace(targetPath, cwd) {
  const workspace = realPathWithExistingParent(path.resolve(cwd));
  const resolved = realPathWithExistingParent(path.resolve(cwd, targetPath));
  const relative = path.relative(workspace, resolved);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

// Resolve symlinks when possible; for a new file, resolve its nearest existing parent.
function realPathWithExistingParent(target) {
  let candidate = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return path.resolve(target);
    suffix.unshift(path.basename(candidate));
    candidate = parent;
  }
  try {
    return path.join(fs.realpathSync.native(candidate), ...suffix);
  } catch {
    return path.resolve(target);
  }
}

const REQUIRED_STRING_FIELDS = Object.freeze({
  write: ["path"],
  edit: ["path"],
  bash: ["command"],
  web_crawl: ["url"],
  memory_search: ["query"],
  memory_remember: ["content"],
  memory_add_fact: ["subject", "predicate", "object"],
  memory_query_entity: ["name"]
});

/** Validate semantic invariants after the model/SDK schema layer and before policy classification. */
export function validateToolInput(toolName, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { code: "INVALID_ARGUMENTS", message: "tool input must be an object", retryable: true };
  }
  for (const field of REQUIRED_STRING_FIELDS[toolName] ?? []) {
    if (typeof input[field] !== "string" || input[field].trim().length === 0) {
      return { code: "MISSING_ARGUMENT", field, message: `${field} must be a non-empty string`, retryable: true };
    }
  }
  if (toolName === "web_crawl") {
    let url;
    try { url = new URL(input.url); } catch { return { code: "INVALID_URL", field: "url", message: "url must be an absolute HTTP(S) URL", retryable: true }; }
    if (!/^https?:$/.test(url.protocol)) {
      return { code: "INVALID_URL_SCHEME", field: "url", message: "only http and https are allowed", retryable: true };
    }
  }
  if (toolName === "memory_remember" && input.content.length > 20000) {
    return { code: "ARGUMENT_TOO_LARGE", field: "content", message: "content exceeds 20000 characters", retryable: false };
  }
  return null;
}

export function containsSecretLikeInput(input) {
  const sensitiveName = /^(?:api[_-]?key|password|secret|token|access[_-]?token|auth[_-]?token|private[_-]?key)$/i;
  const assignment = /\b(?:api[_-]?key|password|secret|token|access[_-]?token|auth[_-]?token|private[_-]?key)\b\s*["']?\s*[:=]\s*["']?([^\s"',;}]{8,})/i;
  const bearer = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i;

  const visit = (value, key = "") => {
    if (typeof value === "string") {
      if (sensitiveName.test(key) && value.trim().length >= 8) return true;
      return assignment.test(value) || bearer.test(value);
    }
    if (Array.isArray(value)) return value.some((item) => visit(item));
    if (value && typeof value === "object") {
      return Object.entries(value).some(([childKey, childValue]) => visit(childValue, childKey));
    }
    return false;
  };

  return visit(input ?? {});
}

export function classifyToolCall(toolName, input, config, cwd) {
  if (containsSecretLikeInput(input)) {
    return { risk: RISK.BLOCKED, reason: "possible raw secret in tool arguments", approval: false };
  }

  if (
    toolName === "memory_add_fact" &&
    /^(?:api[_-]?key|password|secret|token|access[_-]?token|auth[_-]?token)$/i.test(String(input?.predicate ?? "")) &&
    String(input?.object ?? "").trim().length >= 8
  ) {
    return { risk: RISK.BLOCKED, reason: "possible raw secret in knowledge-graph fact", approval: false };
  }

  if (toolName === "bash") {
    const result = classifyBash(String(input?.command ?? ""));
    return { ...result, approval: result.risk === RISK.HIGH && config.approval.highRiskBash };
  }

  if (toolName === "write" || toolName === "edit") {
    const targetPath = String(input?.path ?? "");
    const protectedPattern = matchesProtectedPath(targetPath, config.protectPaths);
    if (protectedPattern) {
      return { risk: RISK.BLOCKED, reason: `protected path matched: ${protectedPattern}`, approval: false };
    }
    if (config.approval.writesOutsideWorkspace && isOutsideWorkspace(targetPath, cwd)) {
      return { risk: RISK.HIGH, reason: "write outside workspace", approval: true };
    }
    return { risk: RISK.MEDIUM, reason: "workspace file mutation", approval: false };
  }

  if (toolName === "web_crawl") {
    return { risk: RISK.MEDIUM, reason: "external network request", approval: false };
  }

  if (toolName === "memory_remember" || toolName === "memory_add_fact") {
    return { risk: RISK.MEDIUM, reason: "durable memory mutation", approval: false };
  }

  if (toolName.startsWith("memory_")) {
    return { risk: RISK.LOW, reason: "read-only memory operation", approval: false };
  }

  // An extension tool without an explicit policy is not trusted by default.
  return { risk: RISK.MEDIUM, reason: "unregistered tool requires explicit policy", approval: false };
}

export function shouldBlockForLimits(state, config, classification) {
  if (state.toolCallsThisTurn >= config.limits.maxToolCallsPerTurn) {
    return `tool-call limit exceeded (${config.limits.maxToolCallsPerTurn})`;
  }
  if (classification.risk === RISK.HIGH && state.highRiskCallsThisTurn >= config.limits.maxHighRiskCallsPerTurn) {
    return `high-risk tool-call limit exceeded (${config.limits.maxHighRiskCallsPerTurn})`;
  }
  return null;
}
