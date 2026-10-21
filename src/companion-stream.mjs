import fs from "node:fs";

/**
 * Live task stream: turn a Pi JSON-mode log into something a chat UI can show
 * while the teammate is still working.
 *
 * The log is a JSONL of events. What matters for a "typing…" experience:
 *   message_start  (role: assistant)  → a new turn began
 *   message_update { assistantMessageEvent: { type: text_delta, delta } }
 *   message_update { assistantMessageEvent: { type: thinking_delta, delta } }
 *   tool_execution_start / end        → what it is doing right now
 *   turn_end / agent_end              → the turn settled
 *
 * Everything is bounded: only the tail of the file is read and the returned
 * text is capped, because this is polled while a task runs.
 */

const DEFAULT_TAIL_BYTES = 256 * 1024;
const MAX_TEXT_CHARS = 8000;
const MAX_STEPS = 12;

/**
 * Parse a JSONL stream into { text, thinking, tools, settled, lastTurnEndAt }.
 * Unknown or malformed lines are ignored: a partially written log must still
 * render the part that is complete.
 */
export function extractStreamState(jsonl, { maxChars = MAX_TEXT_CHARS } = {}) {
  let text = "";
  let thinking = "";
  const tools = [];
  let settled = false;
  let sawAssistant = false;
  let lastTurnEndAt = null;

  for (const line of String(jsonl ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === "message_start" && event.message?.role === "assistant") {
      sawAssistant = true;
      // A new assistant turn: this is the current message, so earlier text is
      // history the caller already has.
      text = "";
      thinking = "";
      settled = false;
      continue;
    }
    if (event.type === "message_update" && event.assistantMessageEvent) {
      const inner = event.assistantMessageEvent;
      if (inner.type === "text_delta" && typeof inner.delta === "string") text += inner.delta;
      else if (inner.type === "thinking_delta" && typeof inner.delta === "string") thinking += inner.delta;
      else if (inner.type === "text_start" && text && !text.endsWith("\n")) text += "\n";
      continue;
    }
    if (event.type === "tool_execution_start" && event.toolName) {
      tools.push({ name: event.toolName, args: summarizeArgs(event.args), at: null, running: true });
      continue;
    }
    if (event.type === "tool_execution_end" && event.toolName) {
      const entry = [...tools].reverse().find((tool) => tool.name === event.toolName && tool.running);
      if (entry) {
        entry.running = false;
        entry.ok = event.isError ? false : true;
      }
      continue;
    }
    if (event.type === "turn_end") {
      lastTurnEndAt = event.timestamp ?? Date.now();
      settled = true;
      continue;
    }
    if (event.type === "agent_end" || event.type === "agent_settled") {
      settled = true;
    }
  }

  return {
    hasOutput: sawAssistant || tools.length > 0,
    text: text.slice(-maxChars),
    thinking: thinking.slice(-maxChars),
    tools: tools.slice(-MAX_STEPS),
    settled,
    lastTurnEndAt
  };
}

/** Keep tool arguments small and readable: the UI shows one line per call. */
function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  const preferred = ["command", "path", "file_path", "pattern", "url", "query"];
  for (const key of preferred) {
    if (typeof args[key] === "string") return `${key}: ${args[key].slice(0, 160)}`;
  }
  const first = Object.entries(args).find(([, value]) => typeof value === "string");
  return first ? `${first[0]}: ${String(first[1]).slice(0, 160)}` : "";
}

/**
 * Read only the tail of a log file and extract the state. Returns null when
 * the file does not exist (a task that never started writing).
 */
export function readStreamState(filePath, { tailBytes = DEFAULT_TAIL_BYTES } = {}) {
  let text;
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - tailBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  // A tail cut mid-line yields one broken first line, which extractStreamState
  // skips on its own.
  return extractStreamState(text);
}
