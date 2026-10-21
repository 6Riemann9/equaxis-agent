/**
 * Helpers for consuming Pi extension events across the 0.83 → 1.x boundary.
 *
 * Pi 1.2.0 turned `BeforeAgentStartEvent` into a union: runs started by a
 * user prompt carry `prompt` (messageType "user"), while runs started by
 * `pi.sendMessage(..., { triggerTurn: true })` carry a `message` custom
 * message instead (messageType "custom").
 */

/**
 * Best-effort plain-text view of whatever started this run: the user prompt
 * for user runs, or the text content of the custom message for custom runs.
 * Pi 0.83 events have no messageType but always carry `prompt` — treat a
 * present string prompt as a user run so extensions stay dual-compatible.
 * Always returns a string (possibly empty).
 */
export function beforeAgentStartText(event) {
  if (!event || typeof event !== "object") return "";
  if (event.messageType === "user" || (event.messageType == null && typeof event.prompt === "string")) {
    return String(event.prompt ?? "");
  }
  const content = event.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("\n");
  }
  return "";
}

/** True when this run was started by a real user prompt (0.83: always;
 * 1.2+: only messageType "user"). Custom-message runs return false. */
export function isBeforeAgentStartUserRun(event) {
  if (!event || typeof event !== "object") return false;
  return event.messageType === "user" || (event.messageType == null && typeof event.prompt === "string");
}
