/**
 * Native Equaxis memory core — pure Node.js, no Python/chromadb dependency.
 *
 * Replaces the Python bridge for the default backend while keeping the same
 * action surface and data layouts:
 *   - history/      JSONL short-term history + .cursor / .dream_cursor (same
 *                    files the Python core writes, so existing history carries over)
 *   - long_term/    drawers.json (drawers with 384-d embeddings)
 *   - knowledge_graph.sqlite3  triples/entities tables matching the Python
 *                    schema, so an existing graph database opens as-is
 *
 * Embeddings run through @huggingface/transformers (all-MiniLM-L6-v2, ONNX
 * WASM/native) and are cached; when the model cannot load, searches fall back
 * to token-overlap scoring and status/repair report embedding readiness.
 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MEMORY_CORE_VERSION = "0.2.0-native";
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const HALL_TYPES = ["hall_general", "hall_facts", "hall_events", "hall_discoveries", "hall_preferences", "hall_advice"];

// Charset validation matching the Python bridge's validate_wing_room (validation.py:29-51).
// Enforced at the native entry point so illegal values are rejected early rather than
// silently persisted and causing cross-backend incompatibilities.
export const MEMORY_SECTION_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const HALL_RE = /^hall_[a-zA-Z0-9_-]{1,32}$/;

function validateSection(name, label) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed || !MEMORY_SECTION_RE.test(trimmed)) {
    throw new Error(`Invalid ${label}: "${name}" must match ${MEMORY_SECTION_RE}`);
  }
  return trimmed;
}

function validateHall(hall) {
  const trimmed = String(hall ?? "").trim();
  if (!HALL_RE.test(trimmed) || !HALL_TYPES.includes(trimmed)) {
    throw new Error(`Invalid hall: "${hall}" must be one of ${HALL_TYPES.join(", ")}`);
  }
  return trimmed;
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function drawerId(wing, room, content) {
  return `drawer_${wing}_${room}_${sha256(`${wing}:${room}:${content}`).slice(0, 24)}`;
}

function normalizeEntity(name) {
  return String(name ?? "").trim().toLowerCase();
}

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let index = 0; index < len; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Token-overlap fallback when embeddings are unavailable. */
function overlapScore(queryTokens, content) {
  const contentTokens = new Set(tokenize(content));
  if (!contentTokens.size) return 0;
  let hits = 0;
  for (const token of queryTokens) if (contentTokens.has(token)) hits += 1;
  return hits / Math.max(queryTokens.length, 1);
}

export class NativeMemoryCore {
  #cachedMaxCursor;

  constructor({ rootDir, model = EMBEDDING_MODEL }) {
    this.rootDir = path.resolve(rootDir);
    this.model = model;
    this.historyDir = path.join(this.rootDir, "history");
    this.historyPath = path.join(this.historyDir, "history.jsonl");
    this.cursorPath = path.join(this.historyDir, ".cursor");
    this.dreamCursorPath = path.join(this.historyDir, ".dream_cursor");
    this.drawersPath = path.join(this.rootDir, "long_term", "drawers.json");
    this.knowledgeGraphPath = path.join(this.rootDir, "knowledge_graph.sqlite3");
    this.drawers = [];
    this.embedderPromise = null;
    this.embeddingReady = false;
    this.embeddingError = null;
    this.#cachedMaxCursor = undefined;
    this.#ensureLayout();
    this.#loadDrawers();
  }

  #ensureLayout() {
    fs.mkdirSync(path.join(this.rootDir, "long_term"), { recursive: true });
    fs.mkdirSync(this.historyDir, { recursive: true });
    if (!fs.existsSync(this.historyPath)) fs.writeFileSync(this.historyPath, "", "utf8");
    if (!fs.existsSync(this.drawersPath)) fs.writeFileSync(this.drawersPath, "[]", "utf8");
    if (!fs.existsSync(this.cursorPath)) fs.writeFileSync(this.cursorPath, "0\n", "utf8");
    if (!fs.existsSync(this.dreamCursorPath)) fs.writeFileSync(this.dreamCursorPath, "0\n", "utf8");
  }

  #loadDrawers() {
    try {
      this.drawers = JSON.parse(fs.readFileSync(this.drawersPath, "utf8"));
      if (!Array.isArray(this.drawers)) this.drawers = [];
    } catch {
      this.drawers = [];
    }
  }

  #persistDrawers() {
    const tmp = `${this.drawersPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.drawers), "utf8");
    fs.renameSync(tmp, this.drawersPath);
  }

  #readInt(filePath) {
    try {
      const raw = fs.readFileSync(filePath, "utf8").trim();
      const parsed = Number(raw);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
    } catch {
      return 0;
    }
  }

  #writeInt(filePath, value) {
    fs.writeFileSync(filePath, `${value}\n`, "utf8");
  }

  readHistory() {
    const entries = [];
    for (const line of fs.readFileSync(this.historyPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  }

  appendHistory(sessionId, content) {
    // Cache maxCursor in memory: full readHistory() only on first call to
    // calibrate, then increment locally.  Prevents O(n²) re-reads when
    // many entries accumulate and avoids concurrent cursor collisions
    // (each process tracks its own monotonic counter after the initial scan).
    if (this.#cachedMaxCursor === undefined) {
      const entries = this.readHistory();
      const maxFromHistory = entries.reduce((max, entry) => Math.max(max, Number(entry.cursor) || 0), 0);
      const stored = this.#readInt(this.cursorPath);
      this.#cachedMaxCursor = Math.max(stored, maxFromHistory);
    }
    this.#cachedMaxCursor += 1;
    const cursor = this.#cachedMaxCursor;
    const entry = { cursor, timestamp: nowIso(), content, session_id: sessionId, metadata: {} };
    fs.appendFileSync(this.historyPath, `${JSON.stringify(entry)}\n`, "utf8");
    this.#writeInt(this.cursorPath, cursor);
    return entry;
  }

  #kg() {
    return new DatabaseSync(this.knowledgeGraphPath);
  }

  #kgInitialize(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        properties TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS triples (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        confidence REAL NOT NULL,
        metadata TEXT NOT NULL,
        extracted_at TEXT NOT NULL,
        FOREIGN KEY(subject) REFERENCES entities(id),
        FOREIGN KEY(object) REFERENCES entities(id)
      );
      CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject);
      CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object);
      CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate);
    `);
  }

  #getEmbedder() {
    if (!this.embedderPromise) {
      this.embedderPromise = import("@huggingface/transformers")
        .then(async (transformers) => {
          const pipeline = await transformers.pipeline("feature-extraction", this.model);
          this.embeddingReady = true;
          return pipeline;
        })
        .catch((error) => {
          this.embeddingError = error instanceof Error ? error.message : String(error);
          return null;
        });
    }
    return this.embedderPromise;
  }

  async #embed(text) {
    const embedder = await this.#getEmbedder();
    if (!embedder) return null;
    const output = await embedder(String(text).slice(0, 8000), { pooling: "mean", normalize: true });
    return Array.from(output.data);
  }

  async #embedMany(texts) {
    const embedder = await this.#getEmbedder();
    if (!embedder) return texts.map(() => null);
    const results = await embedder(texts.map((text) => String(text).slice(0, 8000)), { pooling: "mean", normalize: true });
    return Array.from(results.data ? [results.data] : results).map((row) => Array.from(row));
  }

  async #scoreDrawers(query, queryTokens) {
    const queryEmbedding = await this.#embed(query);
    if (queryEmbedding) {
      return this.drawers.map((drawer) => ({
        drawer,
        score: drawer.embedding ? cosine(queryEmbedding, drawer.embedding) : overlapScore(queryTokens, drawer.content),
      }));
    }
    return this.drawers.map((drawer) => ({ drawer, score: overlapScore(queryTokens, drawer.content) }));
  }

  // ---- action surface (mirrors the Python bridge protocol) ----

  ping() {
    return { version: MEMORY_CORE_VERSION, rootDir: this.rootDir };
  }

  status() {
    const wings = {};
    for (const drawer of this.drawers) wings[drawer.wing] = (wings[drawer.wing] ?? 0) + 1;
    const db = this.#kg();
    try {
      this.#kgInitialize(db);
      const entities = db.prepare("SELECT COUNT(*) AS n FROM entities").get().n;
      const triples = db.prepare("SELECT COUNT(*) AS n FROM triples").get().n;
      const current = db.prepare("SELECT COUNT(*) AS n FROM triples WHERE valid_to IS NULL").get().n;
      return {
        config: { root_dir: this.rootDir, history_entries: this.readHistory().length },
        wings,
        knowledge_graph: { entities, triples, current_facts: current },
        dream: { last_cursor: this.#readInt(this.dreamCursorPath) },
        embedding: { ready: this.embeddingReady, model: this.model, error: this.embeddingError }
      };
    } finally {
      db.close();
    }
  }

  recordUser(sessionId, content) {
    this.appendHistory(sessionId, `[user] ${content}`);
    return { recorded: true };
  }

  recordAssistant(sessionId, content) {
    this.appendHistory(sessionId, `[assistant] ${content}`);
    return { recorded: true };
  }

  buildContext({ sessionId, query, wing, room, limit = 5 }) {
    const lines = [];
    const recent = this.readHistory().slice(-20);
    for (const entry of recent) {
      if (sessionId && entry.session_id && entry.session_id !== sessionId) continue;
      lines.push(entry.content);
    }
    const matches = this.search({ query: query || "recall", wing, room, limit }).matches;
    for (const match of matches) lines.push(`[memory:${match.id}] ${match.content}`);
    return { context: lines.join("\n") };
  }

  search({ query, wing, room, limit = 5 }) {
    const queryTokens = tokenize(query);
    const scored = this.#scoreDrawersSyncFallback(query, queryTokens)
      .filter(({ drawer }) => (!wing || drawer.wing === wing) && (!room || drawer.room === room))
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.min(limit, 20));
    return {
      matches: scored.map(({ drawer, score }) => ({
        id: drawer.id,
        content: drawer.content,
        metadata: { wing: drawer.wing, room: drawer.room, hall: drawer.hall, source_file: drawer.source_file, filed_at: drawer.filed_at },
        score: Math.max(0, score)
      }))
    };
  }

  // The synchronous store cannot await embeddings; the async path is handled by
  // the backend adapter which calls #searchAsync below.
  #scoreDrawersSyncFallback(query, queryTokens) {
    return this.drawers.map((drawer) => ({ drawer, score: overlapScore(queryTokens, drawer.content) }));
  }

  async searchAsync({ query, wing, room, limit = 5 }) {
    const queryTokens = tokenize(query);
    const scored = (await this.#scoreDrawers(query, queryTokens))
      .filter(({ drawer }) => (!wing || drawer.wing === wing) && (!room || drawer.room === room))
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.min(limit, 20));
    return {
      matches: scored.map(({ drawer, score }) => ({
        id: drawer.id,
        content: drawer.content,
        metadata: { wing: drawer.wing, room: drawer.room, hall: drawer.hall, source_file: drawer.source_file, filed_at: drawer.filed_at },
        score: Math.max(0, score)
      }))
    };
  }

  /**
   * Associative recall (RippleMem structural channel): anchors from the
   * plain search rank first, then same-source neighbors (source_file edge)
   * are appended by raw score, up to `limit` extra matches. Absolute-score
   * re-ranking with a fixed penalty can never surface a non-anchor item
   * (it would already rank above the anchor tail), so provenance expansion
   * is additive: anchors stay first by construction, scattered same-source
   * evidence gets recollected. Reading-side soft enhancement: expansion
   * errors only affect ranking.
   */
  async associativeSearchAsync({ query, wing, room, limit = 5, anchorMultiplier = 3 } = {}) {
    const queryTokens = tokenize(query);
    const inScope = (drawer) => (!wing || drawer.wing === wing) && (!room || drawer.room === room);
    const scoped = (await this.#scoreDrawers(query, queryTokens)).filter(({ drawer }) => inScope(drawer));
    if (scoped.length === 0) return { matches: [] };
    const ranked = [...scoped].sort((left, right) => right.score - left.score);
    const anchors = ranked.slice(0, Math.min(limit * anchorMultiplier, 30));
    const matches = anchors.map(({ drawer, score }) => ({
      id: drawer.id, content: drawer.content, metadata: this.#matchMetadata(drawer), score: Math.max(0, score)
    }));
    const seen = new Set(matches.map((match) => match.id));
    const sourceOf = new Set(anchors.map(({ drawer }) => drawer.source_file).filter(Boolean));
    const expansions = ranked
      .filter(({ drawer }) => !seen.has(drawer.id) && sourceOf.has(drawer.source_file))
      .slice(0, Math.min(limit, 20))
      .map(({ drawer, score }) => ({
        id: drawer.id, content: drawer.content, metadata: this.#matchMetadata(drawer), score: Math.max(0, score)
      }));
    return { matches: [...matches, ...expansions] };
  }

  #matchMetadata(drawer) {
    return { wing: drawer.wing, room: drawer.room, hall: drawer.hall, source_file: drawer.source_file, filed_at: drawer.filed_at };
  }

  /**
   * Multi-hop graph retrieval: BFS from seed entities over current facts,
   * undirected, per-hop score decay, visited-node cap and min-score cutoff.
   * Mirrors the Python knowledge-graph graph_search (TencentDB wiki analog).
   */
  graphSearch({ seeds = [], max_hops: maxHops = 2, hop_decay: hopDecay = 0.5, min_score: minScore = 0.05, max_nodes: maxNodes = 100 } = {}) {
    const seedNames = [...new Set((seeds ?? []).map((seed) => normalizeEntity(seed)).filter(Boolean))];
    if (seedNames.length === 0) return { nodes: [], edges: [], visited: 0 };
    const db = this.#kg();
    try {
      this.#kgInitialize(db);
      const rows = db.prepare("SELECT subject, predicate, object FROM triples WHERE valid_to IS NULL").all();
      const byName = new Map();
      for (const row of rows) {
        for (const name of [row.subject, row.object]) {
          if (!byName.has(name)) byName.set(name, []);
          byName.get(name).push(row);
        }
      }
      const visited = new Map();
      const edges = [];
      const queue = seedNames.map((name) => [name, 0]);
      while (queue.length > 0 && visited.size < maxNodes) {
        const [name, depth] = queue.shift();
        if (visited.has(name) || depth > maxHops) continue;
        const score = hopDecay ** depth;
        if (score < minScore) continue;
        visited.set(name, { name, score: Math.round(score * 10000) / 10000, depth });
        for (const triple of byName.get(name) ?? []) {
          edges.push({ from: triple.subject, predicate: triple.predicate, to: triple.object, depth: depth + 1 });
          const neighbor = triple.subject === name ? triple.object : triple.subject;
          if (!visited.has(neighbor)) queue.push([neighbor, depth + 1]);
        }
      }
      const cappedEdges = edges.slice(0, maxNodes * 8);
      return {
        nodes: [...visited.values()].sort((left, right) => right.score - left.score || String(left.name).localeCompare(String(right.name))),
        edges: cappedEdges.sort((left, right) => left.depth - right.depth || String(left.from).localeCompare(String(left.predicate))),
        visited: visited.size
      };
    } finally {
      db.close();
    }
  }

  async remember({ wing, room, content, source_file = "equaxis", hall = "hall_general", metadata = {} }) {
    if (!wing || !room) throw new Error("wing and room are required");
    const cleanWing = validateSection(wing, "wing");
    const cleanRoom = validateSection(room, "room");
    const cleanHall = validateHall(hall);
    const id = drawerId(cleanWing, cleanRoom, content);
    const existing = this.drawers.find((drawer) => drawer.id === id);
    const embedding = await this.#embed(content);
    const record = {
      id,
      wing: cleanWing,
      room: cleanRoom,
      hall: cleanHall,
      content,
      source_file,
      chunk_index: 0,
      added_by: "equaxis-native",
      filed_at: existing?.filed_at ?? nowIso(),
      metadata: { ...(existing?.metadata ?? {}), ...metadata },
      embedding
    };
    const index = this.drawers.findIndex((drawer) => drawer.id === id);
    if (index >= 0) this.drawers[index] = record;
    else this.drawers.push(record);
    this.#persistDrawers();
    return { record: this.#publicDrawer(record) };
  }

  #publicDrawer(drawer) {
    return {
      drawer_id: drawer.id,
      wing: drawer.wing,
      room: drawer.room,
      hall: drawer.hall,
      content: drawer.content,
      source_file: drawer.source_file,
      chunk_index: drawer.chunk_index,
      added_by: drawer.added_by,
      filed_at: drawer.filed_at,
      metadata: drawer.metadata
    };
  }

  recall({ wing, room, limit = 5 }) {
    const rooms = this.drawers.filter((drawer) => (!wing || drawer.wing === wing) && (!room || drawer.room === room));
    const content = rooms.slice(-Math.min(limit, 10)).map((drawer) => `[${drawer.wing}/${drawer.room}] ${drawer.content}`).join("\n");
    return { content };
  }

  addFact({ subject, predicate, object, metadata = {} }) {
    const subjectName = normalizeEntity(subject);
    const objectName = normalizeEntity(object);
    const predicateName = String(predicate ?? "").trim();
    if (!subjectName || !predicateName || !objectName) throw new Error("subject, predicate and object are required");
    // Deterministic id from (s, p, o): re-adding the same fact is a no-op,
    // so at-least-once dream retries can never mint duplicate triples
    // (mirrors the Python core's (s,p,o) idempotency).
    const tripleId = `t_${sha256(`${subjectName}\u0000${predicateName}\u0000${objectName}`).slice(0, 24)}`;
    const db = this.#kg();
    try {
      this.#kgInitialize(db);
      const now = nowIso();
      // Entity id = lowercase name, matching the Python core exactly (the FK
      // references entities(id), so triples store the same value).
      const upsertEntity = db.prepare(
        "INSERT INTO entities (id, name, type, properties, created_at) VALUES (?, ?, 'unknown', '{}', ?) " +
        "ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, properties=excluded.properties"
      );
      upsertEntity.run(subjectName, subjectName, now);
      upsertEntity.run(objectName, objectName, now);
      const insert = db.prepare(
        "INSERT INTO triples (id, subject, predicate, object, valid_from, valid_to, confidence, metadata, extracted_at) VALUES (?, ?, ?, ?, NULL, NULL, 1.0, ?, ?) " +
        "ON CONFLICT(id) DO NOTHING"
      );
      insert.run(tripleId, subjectName, predicateName, objectName, JSON.stringify(metadata), now);
    } finally {
      db.close();
    }
    return { triple: { triple_id: tripleId, subject: subjectName, predicate: predicateName, object: objectName, valid_from: null, valid_to: null, confidence: 1.0, metadata } };
  }

  queryEntity(name) {
    const entity = normalizeEntity(name);
    const db = this.#kg();
    try {
      this.#kgInitialize(db);
      const rows = db.prepare("SELECT * FROM triples WHERE (subject = ? OR object = ?) AND valid_to IS NULL ORDER BY extracted_at DESC").all(entity, entity);
      return {
        facts: rows.map((row) => ({
          id: row.id,
          subject: row.subject,
          predicate: row.predicate,
          object: row.object,
          valid_from: row.valid_from,
          valid_to: row.valid_to,
          confidence: row.confidence,
          metadata: safeJson(row.metadata),
          extracted_at: row.extracted_at
        }))
      };
    } finally {
      db.close();
    }
  }

  deleteMemory(drawerId) {
    const index = this.drawers.findIndex((drawer) => drawer.id === drawerId);
    if (index < 0) throw new Error(`Unknown drawer: ${drawerId}`);
    this.drawers.splice(index, 1);
    this.#persistDrawers();
    return { deleted: true, drawer_id: drawerId };
  }

  updateMemory({ drawer_id, content, wing, room, hall, source_file }) {
    const drawer = this.drawers.find((entry) => entry.id === drawer_id);
    if (!drawer) throw new Error(`Unknown drawer: ${drawer_id}`);
    if (wing !== undefined) drawer.wing = validateSection(wing, "wing");
    if (room !== undefined) drawer.room = validateSection(room, "room");
    if (hall !== undefined) drawer.hall = validateHall(hall);
    drawer.content = content ?? drawer.content;
    drawer.source_file = source_file ?? drawer.source_file;
    this.#persistDrawers();
    return { updated: true, record: this.#publicDrawer(drawer) };
  }

  visualize({ limit = 500 }) {
    const drawers = this.drawers.slice(0, Math.min(limit, 500)).map((drawer) => ({
      id: drawer.id,
      content: drawer.content,
      wing: drawer.wing,
      room: drawer.room,
      hall: drawer.hall,
      source_file: drawer.source_file,
      filed_at: drawer.filed_at,
      metadata: drawer.metadata
    }));
    const db = this.#kg();
    let facts = [];
    try {
      this.#kgInitialize(db);
      facts = db.prepare("SELECT * FROM triples ORDER BY extracted_at DESC LIMIT ?").all(Math.min(limit, 500)).map((row) => ({
        id: row.id,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        valid_from: row.valid_from,
        valid_to: row.valid_to,
        confidence: row.confidence,
        metadata: safeJson(row.metadata),
        extracted_at: row.extracted_at
      }));
    } finally {
      db.close();
    }
    const rooms = {};
    for (const drawer of drawers) {
      rooms[drawer.wing] ??= {};
      rooms[drawer.wing][drawer.room] = (rooms[drawer.wing][drawer.room] ?? 0) + 1;
    }
    return {
      generated_at: nowIso(),
      status: this.status(),
      rooms,
      drawers,
      facts,
      truncated: { drawers: this.drawers.length > drawers.length, facts: false }
    };
  }

  exportMemory({ limit = 2000 }) {
    return {
      generated_at: nowIso(),
      status: this.status(),
      drawers: this.visualize({ limit }).drawers,
      facts: this.visualize({ limit }).facts,
      history: this.readHistory().slice(-Math.min(limit, 5000))
    };
  }

  importExport(data) {
    let imported = 0;
    for (const drawer of data.drawers ?? []) {
      if (!drawer?.id || !drawer.content) continue;
      if (this.drawers.some((entry) => entry.id === drawer.id)) continue;
      this.drawers.push({
        id: drawer.id,
        wing: drawer.wing ?? "equaxis",
        room: drawer.room ?? "general",
        hall: drawer.hall ?? "hall_general",
        content: drawer.content,
        source_file: drawer.source_file ?? "migration",
        chunk_index: 0,
        added_by: "migration",
        filed_at: drawer.filed_at ?? nowIso(),
        metadata: drawer.metadata ?? {},
        embedding: null
      });
      imported += 1;
    }
    if (imported > 0) this.#persistDrawers();

    // Facts and history are imported idempotently: the knowledge graph and
    // history files may already hold the same rows (in-place compat), so
    // duplicates are skipped instead of re-inserted.
    for (const fact of data.facts ?? []) {
      try {
        const existing = this.queryEntity(fact.subject).facts
          .filter((entry) => entry.predicate === fact.predicate && entry.object === fact.object);
        if (existing.length > 0) continue;
        this.addFact({ subject: fact.subject, predicate: fact.predicate, object: fact.object, metadata: fact.metadata ?? {} });
      } catch {
        // skip malformed facts
      }
    }
    const existingCursors = new Set(this.readHistory().map((entry) => entry.cursor));
    let historyImported = 0;
    for (const entry of data.history ?? []) {
      if (existingCursors.has(entry.cursor)) continue;
      fs.appendFileSync(this.historyPath, `${JSON.stringify({ cursor: entry.cursor, timestamp: entry.timestamp, content: entry.content, session_id: entry.session_id, metadata: {} })}\n`, "utf8");
      existingCursors.add(entry.cursor);
      historyImported += 1;
    }
    return { imported, historyImported };
  }

  repair({ clean = false } = {}) {
    const entries = this.readHistory();
    const storedCursor = this.#readInt(this.cursorPath);
    const maxCursor = entries.reduce((max, entry) => Math.max(max, Number(entry.cursor) || 0), 0);
    const repaired = storedCursor <= 0 && maxCursor > 0;
    if (repaired) this.#writeInt(this.cursorPath, maxCursor);
    const damaged = entries.filter((entry) => JSON.stringify(entry).includes("\ufffd")).length;
    let cleaned = 0;
    if (clean && damaged > 0) {
      const kept = entries.filter((entry) => !JSON.stringify(entry).includes("\ufffd"));
      cleaned = entries.length - kept.length;
      fs.writeFileSync(this.historyPath, kept.map((entry) => JSON.stringify(entry)).join("\n") + (kept.length ? "\n" : ""), "utf8");
    }
    return {
      generated_at: nowIso(),
      cursor: { stored: storedCursor, rebuilt: maxCursor, repaired },
      history: { lines: entries.length, damaged, unparseable: 0 },
      drawers: this.drawers.length,
      embedding: { ok: this.embeddingReady, model: this.model, error: this.embeddingError },
      cleaned
    };
  }

  pendingHistory({ limit = 200 }) {
    const dreamCursor = this.#readInt(this.dreamCursorPath);
    const entries = this.readHistory()
      .filter((entry) => Number(entry.cursor) > dreamCursor)
      .slice(0, Math.min(limit, 500))
      .map((entry) => ({ cursor: entry.cursor, content: entry.content, session_id: entry.session_id, timestamp: entry.timestamp }));
    return { dream_cursor: dreamCursor, entries };
  }

  setDreamCursor(cursor) {
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error("cursor must be a non-negative integer");
    // Monotonic: a stale writer must never roll the cursor back, or pending
    // history would grow and re-process already-dreamed entries.
    const next = Math.max(this.#readInt(this.dreamCursorPath), cursor);
    this.#writeInt(this.dreamCursorPath, next);
    return { ok: true, dream_cursor: next };
  }
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/** Shared action dispatch used by the in-process backend and the JSONL bridge. */
export async function dispatchMemoryAction(core, action, payload = {}) {
  switch (action) {
    case "ping": return core.ping();
    case "status": return core.status();
    case "record_user": return core.recordUser(payload.session_id, payload.content);
    case "record_assistant": return core.recordAssistant(payload.session_id, payload.content);
    case "context": return core.buildContext(payload);
    case "search": return core.searchAsync(payload);
    case "associative_search": return core.associativeSearchAsync(payload);
    case "graph_search": return core.graphSearch(payload);
    case "remember": return core.remember(payload);
    case "recall": return core.recall(payload);
    case "add_fact": return core.addFact(payload);
    case "query_entity": return core.queryEntity(payload.name);
    case "delete_memory": return core.deleteMemory(payload.drawer_id);
    case "update_memory": return core.updateMemory(payload);
    case "visualize": return core.visualize(payload);
    case "export": return core.exportMemory(payload);
    case "import": return core.importExport(payload);
    case "repair": return core.repair(payload);
    case "pending_history": return core.pendingHistory(payload);
    case "set_dream_cursor": return core.setDreamCursor(payload.cursor);
    case "close": return { closed: true };
    default: throw new Error(`Unknown memory action: ${action}`);
  }
}

/**
 * In-process backend adapter exposing the same request(action, payload,
 * options) surface as the Python spawn bridge, so the extension can switch
 * backends without changing call sites.
 */
export class NativeMemoryBackend {
  constructor({ rootDir, model = EMBEDDING_MODEL }) {
    this.core = new NativeMemoryCore({ rootDir, model });
    this.started = false;
  }

  async start() {
    this.started = true;
    return this;
  }

  async stop() {
    this.started = false;
  }

  async request(action, payload = {}, _options = {}) {
    return dispatchMemoryAction(this.core, action, payload);
  }
}
