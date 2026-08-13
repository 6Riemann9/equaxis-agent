/**
 * Durable-memory consolidation: summarizes unprocessed short-term history
 * into long-term drawers and knowledge-graph facts using the session model.
 *
 * The bridge tracks a "dream cursor" over history entries. This module reads
 * entries after the cursor, asks an injected `complete(prompt)` function (the
 * extension wires it to pi-ai `completeSimple` with the current model) to
 * extract durable memories + facts, stores them, then advances the cursor.
 * At-least-once semantics: the cursor only moves after storage succeeds, so an
 * interrupted run simply re-processes the same entries next time.
 */

export const MEMORY_EXTRACTION_SYSTEM_PROMPT =
  "You extract durable long-term memories from agent conversation history. " +
  "Respond with STRICT JSON only (no markdown fences, no commentary).";

export function buildMemoryExtractionPrompt(entries) {
  const lines = entries
    .map((entry) => `[${entry.timestamp ?? ""}] ${entry.content}`)
    .join("\n");
  const history = lines.length > 8000 ? lines.slice(-8000) : lines;
  return [
    "Below is conversation history recorded across recent sessions.",
    "",
    "Extract ONLY durable, useful information worth remembering long-term:",
    "- stable user preferences, decisions, and project facts",
    "- entity relationships suitable for a knowledge graph",
    "",
    "Skip transient chatter, task steps, code, credentials, and anything trivial.",
    "Respond with STRICT JSON, no markdown fences:",
    '{"memories":[{"content":"concise durable memory","wing":"optional","room":"optional","hall":"hall_preferences|hall_facts|hall_discoveries|hall_general|..."}],"facts":[{"subject":"entity","predicate":"relationship","object":"entity"}]}',
    "Empty arrays are fine. Keep each memory to one sentence.",
    "",
    "--- history ---",
    history
  ].join("\n");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanMemory(value) {
  if (!isRecord(value)) return null;
  const content = typeof value.content === "string" ? value.content.trim() : "";
  if (!content) return null;
  return {
    content: content.slice(0, 4000),
    wing: typeof value.wing === "string" && value.wing.trim() ? value.wing.trim() : undefined,
    room: typeof value.room === "string" && value.room.trim() ? value.room.trim() : undefined,
    hall: typeof value.hall === "string" && value.hall.trim() ? value.hall.trim() : undefined
  };
}

function cleanFact(value) {
  if (!isRecord(value)) return null;
  const subject = typeof value.subject === "string" ? value.subject.trim() : "";
  const predicate = typeof value.predicate === "string" ? value.predicate.trim() : "";
  const object = typeof value.object === "string" ? value.object.trim() : "";
  if (!subject || !predicate || !object) return null;
  return { subject: subject.slice(0, 256), predicate: predicate.slice(0, 128), object: object.slice(0, 256) };
}

/** Parse the model's JSON response, tolerating fences, prefixes and trailing text. */
export function parseMemoryExtractionResponse(text) {
  const trimmed = String(text ?? "").trim();
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (!isRecord(value)) continue;
      const memories = Array.isArray(value.memories)
        ? value.memories.map(cleanMemory).filter(Boolean)
        : [];
      const facts = Array.isArray(value.facts)
        ? value.facts.map(cleanFact).filter(Boolean)
        : [];
      if (memories.length || facts.length) return { memories, facts };
    } catch {
      // try the next candidate
    }
  }
  throw new Error("Model did not return valid memory-extraction JSON");
}

/**
 * @param {object} options
 * @param {import("./memory-bridge.mjs").MemoryBridge} options.bridge
 * @param {(prompt: string) => Promise<string>} options.complete  model completion
 * @param {Array<{cursor: number, content: string, timestamp?: string}>} options.entries
 * @param {{wing?: string, room?: string}} [options.defaults]
 */
export async function consolidateMemoryHistory({ bridge, complete, entries, defaults = {} }) {
  if (!entries.length) return { processed: 0, memories: [], facts: [] };
  const prompt = buildMemoryExtractionPrompt(entries);
  const text = await complete(prompt);
  const { memories, facts } = parseMemoryExtractionResponse(text);

  const stored = [];
  for (const memory of memories) {
    const result = await bridge.request("remember", {
      content: memory.content,
      wing: memory.wing ?? defaults.wing ?? "equaxis",
      room: memory.room ?? defaults.room ?? "general",
      hall: memory.hall ?? "hall_discoveries",
      source_file: "equaxis-dream",
      metadata: { source: "dream" }
    });
    stored.push(result.record.drawer_id);
  }
  const storedFacts = [];
  for (const fact of facts) {
    const result = await bridge.request("add_fact", {
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      metadata: { source: "dream" }
    });
    storedFacts.push(result.triple.triple_id);
  }

  const lastCursor = entries[entries.length - 1].cursor;
  await bridge.request("set_dream_cursor", { cursor: lastCursor });
  return { processed: entries.length, memories: stored, facts: storedFacts };
}
