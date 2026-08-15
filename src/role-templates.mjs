/**
 * Role templates (RSM, arXiv 2608.12311 — role specialization for agentic
 * software development). Each role bundles a system-prompt directive plus an
 * optional tool whitelist, so DAG nodes can declare a role instead of
 * hand-writing role boilerplate. Explicit prompts still win: buildRolePrompt
 * wraps, never replaces, the task prompt. Unknown roles pass through unchanged.
 */

export const ROLE_TEMPLATES = {
  architect: {
    description: "System design: decompose, choose patterns, weigh tradeoffs",
    systemPrompt: "You are the ARCHITECT. Focus on system design: decompose the problem, propose component boundaries, pick patterns, and weigh tradeoffs explicitly. Do not implement unless asked. Output decisions with rationale.",
    tools: ["read", "grep", "glob", "lsp", "bash", "write", "edit"]
  },
  analyst: {
    description: "Investigation: gather evidence, diagnose, report findings",
    systemPrompt: "You are the ANALYST. Investigate with evidence: read the relevant code and data, verify claims before reporting, and distinguish confirmed findings from inferences. Output a findings report; do not change code unless asked.",
    tools: ["read", "grep", "glob", "bash", "lsp", "recall", "reflect", "web_search"]
  },
  engineer: {
    description: "Implementation: make the smallest correct change with tests",
    systemPrompt: "You are the ENGINEER. Implement the smallest correct change that satisfies the requirement, follow existing conventions, and verify by running the relevant checks. Report what changed and how it was verified.",
    tools: ["read", "grep", "glob", "bash", "edit", "write", "lsp", "task"]
  },
  expert: {
    description: "Deep domain review: critique with specialist standards",
    systemPrompt: "You are the EXPERT. Apply specialist standards to review the work: identify correctness, robustness, and maintainability issues, rank them by severity, and propose concrete fixes. Be direct; do not hedge.",
    tools: ["read", "grep", "glob", "bash", "lsp"]
  }
};

/** Resolve a role template; null for unknown roles. */
export function resolveRole(role) {
  return ROLE_TEMPLATES[String(role ?? "").toLowerCase()] ?? null;
}

/**
 * Wrap a task prompt with the role's system directive.
 * Returns the original prompt unchanged when the role is unknown.
 */
export function buildRolePrompt(role, taskPrompt) {
  const template = resolveRole(role);
  if (!template) return String(taskPrompt ?? "");
  return [
    template.systemPrompt,
    "",
    `--- task ---`,
    String(taskPrompt ?? "").trim()
  ].join("\n");
}

/** Tool whitelist for a role (empty = unrestricted). */
export function roleTools(role) {
  return resolveRole(role)?.tools ?? [];
}
