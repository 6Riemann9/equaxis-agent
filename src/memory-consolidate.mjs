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

/** Cosine similarity between two equal-length numeric vectors. */
export function cosineSimilarity(a, b) {
  const len = Math.min(a?.length ?? 0, b?.length ?? 0);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Segment conversation entries by semantic boundary (LycheeMemory V2,
 * arXiv 2608.12990: segment-level consolidation packs multi-turn dialogue
 * into segments, each encoded once).
 *
 * Two split triggers: (1) adjacent-entry embedding cosine below `threshold`
 * (topic switch), (2) hard size cap `maxSegmentChars` so a single segment can
 * never exceed the extraction prompt budget (fixes the old 8000-char truncation
 * that silently dropped early history).
 *
 * SimGates (2608.10216) lesson: embedding thresholds are unreliable, so this
 * split is a SOFT decision — a wrong split only changes extraction granularity,
 * every entry still lands in exactly one segment, nothing is dropped.
 */
export function segmentEntriesBySimilarity(entries, options = {}) {
  const threshold = Number(options.threshold ?? 0.75);
  const maxSegmentChars = Number(options.maxSegmentChars ?? 3000);
  const vectors = options.vectors ?? [];
  const segments = [];
  let current = [];
  let currentChars = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const entryChars = String(entry?.content ?? "").length;
    let shouldSplit = current.length > 0 && currentChars + entryChars > maxSegmentChars;
    if (!shouldSplit && current.length > 0 && vectors.length === entries.length && i > 0) {
      shouldSplit = cosineSimilarity(vectors[i - 1], vectors[i]) < threshold;
    }
    if (shouldSplit) {
      segments.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(entry);
    currentChars += entryChars;
  }
  if (current.length) segments.push(current);
  return segments;
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
 * @param {{enabled?: boolean, threshold?: number, maxSegmentChars?: number}} [options.segmentation]
 */
export async function consolidateMemoryHistory({ bridge, complete, entries, defaults = {}, segmentation = {} }) {
  if (!entries.length) return { processed: 0, memories: [], facts: [] };

  // 段级整合:语义边界切段(embedding 余弦 < threshold = 主题切换),
  // 每段独立提取,信息不因整批截断而丢失。
  // embed 失败时降级为仅大小上限切段——分段是软决策,不阻塞整合。
  let segments = [entries];
  if (segmentation.enabled !== false && entries.length > 1) {
    try {
      const vectors = await embedTexts(bridge, entries.map((entry) => String(entry?.content ?? "").slice(0, 500)));
      segments = segmentEntriesBySimilarity(entries, {
        vectors,
        threshold: segmentation.threshold,
        maxSegmentChars: segmentation.maxSegmentChars
      });
    } catch {
      segments = segmentEntriesBySimilarity(entries, {
        threshold: 0,
        maxSegmentChars: segmentation.maxSegmentChars
      });
    }
  }

  // 每段一次 LLM 编码;小批量并发(3)控制 API 压力。
  const extracted = [];
  for (let start = 0; start < segments.length; start += 3) {
    const batch = segments.slice(start, start + 3);
    const batchResults = await Promise.all(
      batch.map(async (segment) => {
        const prompt = buildMemoryExtractionPrompt(segment);
        const text = await complete(prompt);
        return parseMemoryExtractionResponse(text);
      })
    );
    extracted.push(...batchResults);
  }
  const memories = extracted.flatMap((result) => result.memories);
  const facts = extracted.flatMap((result) => result.facts);

  const stored = [];
  for (const memory of memories) {
    const result = await bridge.request("remember", {
      content: memory.content,
      wing: memory.wing ?? defaults.wing ?? "equaxis",
      room: memory.room ?? defaults.room ?? "general",
      hall: memory.hall ?? "hall_discoveries",
      source_file: "equaxis-dream",
      metadata: { source: "dream", segments: segments.length }
    });
    stored.push(result.record.drawer_id);
  }
  const storedFacts = [];
  for (const fact of facts) {
    const result = await bridge.request("add_fact", {
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      metadata: { source: "dream", segments: segments.length }
    });
    storedFacts.push(result.triple.triple_id);
  }

  const lastCursor = entries[entries.length - 1].cursor;
  await bridge.request("set_dream_cursor", { cursor: lastCursor });
  return { processed: entries.length, memories: stored, facts: storedFacts };
}

async function embedTexts(bridge, texts) {
  const result = await bridge.request("embed", { texts });
  if (!Array.isArray(result?.vectors)) throw new Error("embed returned no vectors");
  return result.vectors;
}
