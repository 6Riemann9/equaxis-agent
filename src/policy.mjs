import path from "node:path";
import fs from "node:fs";

export const RISK = Object.freeze({ LOW: "low", MEDIUM: "medium", HIGH: "high", BLOCKED: "blocked" });

const HIGH_RISK_BASH = [
  { pattern: /\b(?:rm|del)\b[^\r\n]*(?:-r(?:f)?\b|--recursive\b|\/s\b|\/q\b)/i, reason: "recursive deletion" },
  { pattern: /\bRemove-Item\b[^\r\n]*-Recurse\b/i, reason: "recursive deletion" },
  { pattern: /\b(git\s+reset\s+--hard|git\s+clean\s+(?:-[a-z]*f|--force)|git\s+(?:checkout|restore)\s+(?:--\s+)?[.*])/i, reason: "destructive git operation" },
  { pattern: /\b(format|mkfs|diskpart)\b/i, reason: "disk modification" },
  { pattern: /\b(shutdown|reboot|Stop-Computer|Restart-Computer)\b/i, reason: "system shutdown" },
  { pattern: /\b(sudo|runas)\b/i, reason: "privilege escalation" },
  { pattern: /\b(chmod|chown)\b.*\b777\b/i, reason: "unsafe permissions" },
  { pattern: /\b(curl|wget|Invoke-WebRequest)\b.*\|\s*(sh|bash|pwsh|powershell)/i, reason: "remote script execution" },
  { pattern: /\b(?:powershell|pwsh)\b[^\r\n]*(?:-e(?:nc(?:odedcommand)?)?)\b/i, reason: "encoded shell command" },
  { pattern: /\b(?:bash|sh|pwsh|powershell)\b[^\r\n]*(?:<\(|\$\()[^\r\n]*\b(?:curl|wget|Invoke-WebRequest)\b/i, reason: "remote script execution" }
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
  const normalized = normalizeForPolicy(targetPath).replace(/^\.\//, "");
  const parts = normalized.split("/").filter(Boolean);
  return patterns.find((rawPattern) => {
    const pattern = normalizeForPolicy(rawPattern).replace(/^\.\//, "");
    if (pattern.startsWith("*.")) return parts.some((part) => part.endsWith(pattern.slice(1)));
    const literal = pattern.replace(/^\/+|\/+$/g, "");
    if (literal === ".env") return parts.some((part) => part === ".env" || part.startsWith(".env."));
    if (literal.includes("/")) {
      return normalized === literal || normalized.startsWith(`${literal}/`) || normalized.includes(`/${literal}/`);
    }
    return parts.includes(literal);
  }) ?? null;
}

function shellMayWrite(command) {
  return /(?:^|[;&|]\s*|\b)(?:echo\b[^\r\n]*>|(?:Set|Add)-Content\b|Out-File\b|tee\b|(?:cp|mv|copy|move)\b|(?:New-Item|ni)\b)/i.test(command);
}

function protectedShellReference(command, patterns) {
  const pathLike = String(command).replace(/[\s"'`=<>|;&]+/g, "/");
  return matchesProtectedPath(pathLike, patterns);
}

export function isOutsideWorkspace(targetPath, cwd) {
  const workspace = realPathWithExistingParent(path.resolve(cwd));
  const resolved = realPathWithExistingParent(path.resolve(cwd, targetPath));
  const relative = path.relative(workspace, resolved);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

export function isWithinConfiguredRoot(targetPath, cwd, roots = []) {
  const resolvedTarget = realPathWithExistingParent(path.resolve(cwd, targetPath));
  return roots.some((root) => {
    // "<workspace>" is a portable token that resolves to the current project
    // root, so configs stay machine-independent.
    const resolvedRoot = realPathWithExistingParent(path.resolve(root === "<workspace>" ? cwd : root));
    const relative = path.relative(resolvedRoot, resolvedTarget);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
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
  recall: ["query"],
  memory_remember: ["content"],
  retain: ["content"],
  memory_add_fact: ["subject", "predicate", "object"],
  learn: ["subject", "predicate", "object"],
  memory_query_entity: ["name"],
  memory_edit: ["drawer_id"],
  reflect: [],
  advisor_consult: ["kind"],
  lsp_probe: [],
  dap_probe: [],
  ast_inspect: ["path"],
  ast_rename: ["path", "newName"]
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
  if (toolName === "ast_rename" && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(input.newName ?? ""))) {
    return { code: "INVALID_IDENTIFIER", field: "newName", message: "newName must be a valid JavaScript identifier", retryable: true };
  }
  if (toolName === "ast_rename" && input.apply === true && (typeof input.expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(input.expectedHash))) {
    return { code: "MISSING_ARGUMENT", field: "expectedHash", message: "expectedHash is required for an applied AST rename", retryable: true };
  }
  if (toolName === "advisor_consult" && !["tool_call", "plan", "result"].includes(input.kind)) {
    return { code: "INVALID_ADVISOR_KIND", field: "kind", message: "kind must be tool_call, plan, or result", retryable: true };
  }
  if ((toolName === "lsp_probe" || toolName === "dap_probe") && input.mode !== undefined && !["memory", "process"].includes(input.mode)) {
    return { code: "INVALID_PROTOCOL_MODE", field: "mode", message: "mode must be memory or process", retryable: true };
  }
  if (toolName === "dap_probe" && input.request !== undefined && !["launch", "attach"].includes(input.request)) {
    return { code: "INVALID_DAP_REQUEST", field: "request", message: "request must be launch or attach", retryable: true };
  }
  if (toolName === "dap_probe" && input.mode === "process" && (input.request ?? "launch") === "launch" && (typeof input.program !== "string" || !input.program.trim())) {
    return { code: "MISSING_ARGUMENT", field: "program", message: "program is required for DAP launch", retryable: true };
  }
  if (toolName === "dap_probe" && input.mode === "process" && input.request === "attach") {
    if (typeof input.host !== "string" || !input.host.trim()) return { code: "MISSING_ARGUMENT", field: "host", message: "host is required for DAP attach", retryable: true };
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return { code: "INVALID_ARGUMENT", field: "port", message: "port must be an integer between 1 and 65535", retryable: true };
  }
  if ((toolName === "memory_remember" || toolName === "retain") && input.content.length > 20000) {
    return { code: "ARGUMENT_TOO_LARGE", field: "content", message: "content exceeds 20000 characters", retryable: false };
  }
  if (toolName === "reflect" && input.steps !== undefined && !Array.isArray(input.steps)) {
    return { code: "INVALID_ARGUMENT", field: "steps", message: "steps must be an array", retryable: true };
  }
  return null;
}

export function containsSecretLikeInput(input) {
  const sensitiveName = /^(?:api[_-]?key|password|secret|token|access[_-]?token|auth[_-]?token|private[_-]?key)$/i;
  const assignment = /\b(?:api[_-]?key|password|secret|token|access[_-]?token|auth[_-]?token|private[_-]?key)\b\s*["']?\s*[:=]\s*["']?([^\s"',;}]{8,})/i;
  const bearer = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i;
  const knownToken = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/;

  const visit = (value, key = "") => {
    if (typeof value === "string") {
      if (sensitiveName.test(key) && value.trim().length >= 8) return true;
      return assignment.test(value) || bearer.test(value) || knownToken.test(value);
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
    (toolName === "memory_add_fact" || toolName === "learn") &&
    /^(?:api[_-]?key|password|secret|token|access[_-]?token|auth[_-]?token)$/i.test(String(input?.predicate ?? "")) &&
    String(input?.object ?? "").trim().length >= 8
  ) {
    return { risk: RISK.BLOCKED, reason: "possible raw secret in knowledge-graph fact", approval: false };
  }

  if (toolName === "bash") {
    const command = String(input?.command ?? "");
    const protectedPattern = shellMayWrite(command) ? protectedShellReference(command, config.protectPaths) : null;
    if (protectedPattern) {
      return { risk: RISK.BLOCKED, reason: `shell write targets protected path: ${protectedPattern}`, approval: false };
    }
    const result = classifyBash(command);
    return { ...result, approval: result.risk === RISK.HIGH && config.approval.highRiskBash };
  }

  if (toolName === "ast_inspect") {
    return { risk: RISK.LOW, reason: "read-only AST inspection", approval: false };
  }

  if (toolName === "ast_rename" && input?.apply !== true) {
    return { risk: RISK.LOW, reason: "AST rename preview", approval: false };
  }

  if (toolName === "write" || toolName === "edit" || toolName === "ast_rename") {
    const targetPath = String(input?.path ?? "");
    const protectedPattern = matchesProtectedPath(targetPath, config.protectPaths);
    if (protectedPattern) {
      return { risk: RISK.BLOCKED, reason: `protected path matched: ${protectedPattern}`, approval: false };
    }
    if (isOutsideWorkspace(targetPath, cwd)) {
      const externalPolicy = config.approval.externalEditPolicy ?? "prompt";
      if (externalPolicy === "deny") {
        return { risk: RISK.BLOCKED, reason: "external edit denied by policy", approval: false };
      }
      if (externalPolicy === "auto" && isWithinConfiguredRoot(targetPath, cwd, config.approval.externalEditRoots ?? [])) {
        return { risk: RISK.MEDIUM, reason: "external edit root auto-approved", approval: false };
      }
      if (config.approval.writesOutsideWorkspace) {
        return { risk: RISK.HIGH, reason: "write outside workspace", approval: true };
      }
    }
    return { risk: RISK.MEDIUM, reason: "workspace file mutation", approval: false };
  }

  if (toolName === "web_crawl") {
    return { risk: RISK.MEDIUM, reason: "external network request", approval: false };
  }

  if (toolName === "advisor_consult") {
    return { risk: RISK.LOW, reason: "recommendation-only advisor request", approval: false };
  }

  if (toolName === "lsp_probe" || toolName === "dap_probe") {
    if (input?.mode === "process") return { risk: RISK.HIGH, reason: "external protocol adapter process", approval: true };
    return { risk: RISK.LOW, reason: "in-memory protocol probe", approval: false };
  }

  if (toolName === "memory_remember" || toolName === "memory_add_fact" || toolName === "retain" || toolName === "learn" || toolName === "memory_edit" || (toolName === "reflect" && input?.store === true)) {
    return { risk: RISK.MEDIUM, reason: "durable memory mutation", approval: false };
  }

  if (toolName.startsWith("memory_") || toolName === "recall" || toolName === "reflect") {
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
