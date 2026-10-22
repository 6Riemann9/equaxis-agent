import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/**
 * Companion store: persistent AI teammates + a crash-safe FIFO task queue.
 *
 * This is the M0 "Grok Bot" data plane for Equaxis:
 *   - teammates.json — durable teammate profiles (persona, workspace, model)
 *   - queue.json     — task queue with statuses pending/running/done/failed/cancelled
 *   - feed.jsonl     — append-only notification feed (written by companion-notify)
 *
 * All writes are atomic (tmp file + rename). On open, tasks left "running"
 * by a crashed worker are requeued (bounded attempts) or failed — the same
 * crash-recovery contract the subagent state store honors.
 */

// "cancelling" is a request in flight: the worker sees it, aborts the child
// and only then moves the task to "cancelled". Marking a running task
// cancelled directly would lie while its subprocess is still alive.
const TASK_STATUSES = ["pending", "running", "cancelling", "done", "failed", "cancelled"];
const MAX_ATTEMPTS = 3;
/** Floor for routine intervals: nothing may run more often than once a minute. */
export const MIN_ROUTINE_INTERVAL_MS = 60_000;

export const DEFAULT_COMPANION_DIR = ".pi/companion";

function nowIso() {
  return new Date().toISOString();
}

/** Bearer values minted for per-teammate credentials start with this. */
const CREDENTIAL_PREFIX = "eqc1_";

/** Mint a fresh credential value plus its SHA-256 digest (value is never stored). */
function mintCredentialValue() {
  const value = `${CREDENTIAL_PREFIX}${randomUUID().replace(/-/g, "")}${randomUUID().slice(0, 12).replace(/-/g, "")}`;
  return { value, digest: createHash("sha256").update(value).digest("hex") };
}

function digestOf(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Atomic write: write to <file>.tmp then rename over the target. */
function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** mtime+size stamp: the cheapest reliable "did this file change" probe. */
function fileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`companion store: cannot parse ${file}: ${error?.message ?? error}`);
  }
}

function sanitizeTeammate(input, existing = null) {
  const name = String(input?.name ?? existing?.name ?? "").trim();
  if (!name) throw new Error("teammate name is required");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error(`teammate name must be kebab-case (letters, digits, -, _): got "${name}"`);
  }
  return {
    // Preserve the id across reloads (input.id from disk); only a genuinely
    // new teammate gets a fresh UUID.
    id: existing?.id ?? (typeof input?.id === "string" && input.id ? input.id : randomUUID()),
    name,
    persona: String(input?.persona ?? existing?.persona ?? "").trim(),
    workspace: String(input?.workspace ?? existing?.workspace ?? name).trim(),
    model: input?.model ?? existing?.model ?? null,
    // Stable Pi session id: the same value on every run gives the teammate a
    // continuous conversation instead of a cold start per task. Generated
    // lazily (ensureTeammateSession) so importing a template never reuses
    // someone else's session.
    sessionId: input?.sessionId ?? existing?.sessionId ?? null,
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    stats: {
      // Both sources matter: `existing` on update, `input` on load (load()
      // sanitizes the disk record without a separate "existing" argument).
      // Reading only `existing` silently reset every counter on restart.
      completed: (existing?.stats ?? input?.stats)?.completed ?? 0,
      failed: (existing?.stats ?? input?.stats)?.failed ?? 0,
      totalTokens: (existing?.stats ?? input?.stats)?.totalTokens ?? 0,
      totalCostUsd: (existing?.stats ?? input?.stats)?.totalCostUsd ?? 0
    }
  };
}

function sanitizeMessage(input) {
  const text = String(input?.text ?? "").trim();
  const to = String(input?.to ?? "").trim();
  if (!text) throw new Error("message text is required");
  if (!to) throw new Error("message recipient is required");
  return {
    id: input?.id ?? randomUUID(),
    from: String(input?.from ?? "human").trim() || "human",
    to,
    text: text.slice(0, 8000),
    at: input?.at ?? nowIso(),
    readAt: input?.readAt ?? null
  };
}

function sanitizeRoutine(input, teammates) {
  const teammate = String(input?.teammate ?? "").trim();
  const instruction = String(input?.instruction ?? "").trim();
  const everyMs = Number(input?.everyMs);
  if (!instruction) throw new Error("routine instruction is required");
  if (!Number.isFinite(everyMs) || everyMs < MIN_ROUTINE_INTERVAL_MS) {
    throw new Error(`routine interval must be at least ${MIN_ROUTINE_INTERVAL_MS}ms`);
  }
  if (teammates && !teammates.some((t) => t.name === teammate)) {
    throw new Error(`routine teammate "${teammate}" not found`);
  }
  return {
    id: input?.id ?? randomUUID(),
    teammate,
    instruction,
    everyMs,
    enabled: input?.enabled !== false,
    lastRunAt: input?.lastRunAt ?? null,
    lastTaskId: input?.lastTaskId ?? null,
    createdAt: input?.createdAt ?? nowIso()
  };
}

function sanitizeTask(input) {
  const instruction = String(input?.instruction ?? "").trim();
  if (!instruction) throw new Error("task instruction is required");
  const status = input?.status && TASK_STATUSES.includes(input.status) ? input.status : "pending";
  return {
    id: input?.id ?? randomUUID(),
    teammateId: String(input?.teammateId ?? ""),
    instruction,
    status,
    priority: Number.isFinite(input?.priority) ? Number(input.priority) : 0,
    createdAt: input?.createdAt ?? nowIso(),
    startedAt: input?.startedAt ?? null,
    finishedAt: input?.finishedAt ?? null,
    result: input?.result ?? null,
    error: input?.error ?? null,
    attempts: Number.isFinite(input?.attempts) ? Number(input.attempts) : 0,
    runSource: input?.runSource ?? "user",
    // Optional fields that must survive a reload: sanitizeTask rebuilds the
    // record field by field, so anything unlisted is silently dropped.
    ...(input?.usage ? { usage: input.usage } : {}),
    // A delegated task carries the delegator's working set so the handoff is
    // lossless and the result can be routed back (see companion-team.mjs).
    ...(input?.handoff ? { handoff: input.handoff } : {}),
    ...(input?.artifacts ? { artifacts: input.artifacts } : {}),
    ...(input?.cancelRequestedAt ? { cancelRequestedAt: input.cancelRequestedAt } : {})
  };
}

export class CompanionStore {
  #stamps = {};

  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.teammatesFile = path.join(this.rootDir, "teammates.json");
    this.queueFile = path.join(this.rootDir, "queue.json");
    this.messagesFile = path.join(this.rootDir, "messages.json");
    this.routinesFile = path.join(this.rootDir, "routines.json");
    this.feedFile = path.join(this.rootDir, "feed.jsonl");
    this.teammates = null;
    this.queue = null;
    this.messages = null;
    this.routines = null;
    this.recoveredOnOpen = [];
  }

  static open(rootDir) {
    const store = new CompanionStore(rootDir);
    store.load();
    return store;
  }

  /**
   * Load both state files and apply crash recovery: a task stuck in
   * "running" means its worker died. Requeue under the attempt cap, fail
   * over it. Returns the ids of recovered tasks (also kept on this.recoveredOnOpen).
   */
  load() {
    const teammatesState = readJson(this.teammatesFile, { teammates: [] });
    const queueState = readJson(this.queueFile, { tasks: [] });
    const messagesState = readJson(this.messagesFile, { messages: [] });
    const routinesState = readJson(this.routinesFile, { routines: [] });
    this.teammates = (teammatesState.teammates ?? []).map((t) => sanitizeTeammate(t));
    this.queue = (queueState.tasks ?? []).map((t) => sanitizeTask(t));
    this.messages = (messagesState.messages ?? []).map((m) => sanitizeMessage(m));
    this.routines = (routinesState.routines ?? []).map((r) => sanitizeRoutine(r, this.teammates));

    this.recoveredOnOpen = [];
    for (const task of this.queue) {
      if (task.status !== "running") continue;
      task.attempts += 1;
      task.startedAt = null;
      if (task.attempts >= MAX_ATTEMPTS) {
        task.status = "failed";
        task.finishedAt = nowIso();
        task.error = `worker crashed after ${task.attempts} attempts (recovery on load)`;
      } else {
        task.status = "pending";
        task.error = `worker crash recovered; attempt ${task.attempts}/${MAX_ATTEMPTS}`;
      }
      this.recoveredOnOpen.push(task.id);
    }
    if (this.recoveredOnOpen.length) this.flush();
    this.#markStamps();
    return this.recoveredOnOpen;
  }

  flush() {
    atomicWriteJson(this.teammatesFile, { teammates: this.teammates });
    atomicWriteJson(this.queueFile, { tasks: this.queue });
    this.#markStamps();
  }

  flushMessages() {
    this.#stamps.messages = undefined;
    atomicWriteJson(this.messagesFile, { messages: this.messages });
  }

  flushRoutines() {
    this.#stamps.routines = undefined;
    atomicWriteJson(this.routinesFile, { routines: this.routines });
  }

  /**
   * Cross-process freshness.
   *
   * Two processes legitimately share one state directory: the CLI enqueues and
   * inspects, `companion serve` runs the worker and the HTTP API. Each keeps
   * an in-memory copy, so without this the running server never sees a task
   * the CLI queued (and would overwrite it on its next flush). Every public
   * read/mutate calls sync(), which reloads only the files whose mtime+size
   * changed — cheap enough per call, and correct across processes.
   */
  sync() {
    const files = [
      ["teammates", this.teammatesFile, () => {
        const state = readJson(this.teammatesFile, { teammates: [] });
        this.teammates = (state.teammates ?? []).map((entry) => sanitizeTeammate(entry));
      }],
      ["queue", this.queueFile, () => {
        const state = readJson(this.queueFile, { tasks: [] });
        this.queue = (state.tasks ?? []).map((entry) => sanitizeTask(entry));
      }],
      ["messages", this.messagesFile, () => {
        const state = readJson(this.messagesFile, { messages: [] });
        this.messages = (state.messages ?? []).map((entry) => sanitizeMessage(entry));
      }],
      ["routines", this.routinesFile, () => {
        const state = readJson(this.routinesFile, { routines: [] });
        this.routines = (state.routines ?? []).map((entry) => sanitizeRoutine(entry, this.teammates));
      }]
    ];
    for (const [key, file, reload] of files) {
      const stamp = fileStamp(file);
      if (this.#stamps[key] === stamp) continue;
      this.#stamps[key] = stamp;
      try {
        reload();
      } catch {
        // a half-written or missing file keeps the previous view; the next
        // call retries because the stamp was already updated only on success
        this.#stamps[key] = undefined;
      }
    }
    return this;
  }

  /** Record current file stamps so our own writes are not re-read. */
  #markStamps() {
    for (const [key, file] of [
      ["teammates", this.teammatesFile],
      ["queue", this.queueFile],
      ["messages", this.messagesFile],
      ["routines", this.routinesFile]
    ]) {
      this.#stamps[key] = fileStamp(file);
    }
  }

  appendFeed(entry) {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.appendFileSync(this.feedFile, `${JSON.stringify(entry)}\n`, "utf8");
  }

  readFeed(limit = 50) {
    try {
      const lines = fs.readFileSync(this.feedFile, "utf8").split("\n").filter(Boolean);
      return lines.slice(-limit).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { kind: "corrupt_line", raw: line.slice(0, 200) };
        }
      });
    } catch {
      return [];
    }
  }

  // ---- teammates ----

  createTeammate(input) {
  this.sync();
    const existing = this.teammates.find((t) => t.name === input.name);
    if (existing) throw new Error(`teammate "${input.name}" already exists`);
    const teammate = sanitizeTeammate(input);
    this.teammates.push(teammate);
    this.flush();
    return teammate;
  }

  updateTeammate(name, patch) {
  this.sync();
    const idx = this.teammates.findIndex((t) => t.name === name);
    if (idx === -1) throw new Error(`teammate "${name}" not found`);
    const merged = sanitizeTeammate({ ...this.teammates[idx], ...patch }, this.teammates[idx]);
    this.teammates[idx] = merged;
    this.flush();
    return merged;
  }

  deleteTeammate(name) {
  this.sync();
    const idx = this.teammates.findIndex((t) => t.name === name);
    if (idx === -1) throw new Error(`teammate "${name}" not found`);
    const [removed] = this.teammates.splice(idx, 1);
    this.queue = this.queue.filter((t) => t.teammateId !== removed.id || t.status === "running");
    this.flush();
    return removed;
  }

  getTeammate(name) {
  this.sync();
    return this.teammates.find((t) => t.name === name) ?? null;
  }

  /** Allocate (once) the teammate's Pi session id and return it. */
  ensureTeammateSession(name) {
  this.sync();
    const teammate = this.getTeammate(name);
    if (!teammate) throw new Error(`teammate "${name}" not found`);
    if (!teammate.sessionId) {
      teammate.sessionId = randomUUID();
      teammate.updatedAt = nowIso();
      this.flush();
    }
    return teammate.sessionId;
  }

  /** Forget the teammate's conversation so the next run starts cold. */
  resetTeammateSession(name) {
  this.sync();
    const teammate = this.getTeammate(name);
    if (!teammate) throw new Error(`teammate "${name}" not found`);
    const previous = teammate.sessionId;
    teammate.sessionId = null;
    teammate.updatedAt = nowIso();
    this.flush();
    return previous;
  }

  listTeammates() {
  this.sync();
    return [...this.teammates].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  teammateDirectory(teammate, projectRoot) {
    // Workspace is a project-relative directory (or name) under
    // .pi/companion/workspaces unless it is an absolute path.
    if (path.isAbsolute(teammate.workspace)) return teammate.workspace;
    return path.join(projectRoot, ".pi", "companion", "workspaces", teammate.workspace);
  }

  /**
   * The teammate's private HOME for sandboxed runs: Pi state (settings,
   * sessions) lives here per-teammate; only credentials are shared in,
   * read-only, by the sandbox layer.
   */
  teammateHome(teammate, projectRoot) {
    return path.join(projectRoot, ".pi", "companion", "home", teammate.name);
  }

  /**
   * The webhook bearer credential file path (0600, gitignored state dir).
   * `issueWebhookCredential` creates it on first use; callers read the file.
   */
  webhookCredentialFile() {
    return path.join(this.rootDir, "webhook-token");
  }

  issueWebhookCredential() {
    const file = this.webhookCredentialFile();
    fs.mkdirSync(this.rootDir, { recursive: true });
    // Create-if-absent with exclusive flag; two racing writers cannot both win.
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeSync(fd, `${randomUUID()}${randomUUID()}`.replace(/-/g, ""));
    } finally {
      fs.closeSync(fd);
    }
  }

  // ---- per-teammate credentials ----

  /** Per-task stream log (JSON-mode output), appended while the task runs. */
  taskLogFile(taskId) {
    return path.join(this.rootDir, "logs", `${String(taskId).replace(/[^a-zA-Z0-9-]/g, "")}.log`);
  }

  /** Tail of a task log, newest `lines` lines, plus a truncation flag. */
  readTaskLog(taskId, { lines = 100, maxBytes = 256 * 1024 } = {}) {
    const file = this.taskLogFile(taskId);
    let text;
    try {
      const stat = fs.statSync(file);
      const start = Math.max(0, stat.size - maxBytes);
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        text = buffer.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { exists: false, lines: [], truncated: false };
    }
    const all = text.split("\n");
    const tail = all.slice(-Math.max(1, lines));
    return { exists: true, lines: tail, truncated: all.length > tail.length };
  }

  credentialFile() {
    return path.join(this.rootDir, "credentials.json");
  }

  #credentials = null;
  #credentialsStamp = null;

  /**
   * Credentials are cached, but revalidated against the file's mtime+size on
   * every read: revocation/issuance happens in another process (the CLI) and
   * must take effect in a running `companion serve` immediately.
   */
  #loadCredentials() {
    const file = this.credentialFile();
    let stamp = "missing";
    try {
      const stat = fs.statSync(file);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      stamp = "missing";
    }
    if (this.#credentials !== null && this.#credentialsStamp === stamp) return this.#credentials;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      this.#credentials = Array.isArray(data) ? data : [];
    } catch {
      this.#credentials = [];
    }
    this.#credentialsStamp = stamp;
    return this.#credentials;
  }

  #flushCredentials() {
    const file = this.credentialFile();
    const tmp = `${file}.tmp`;
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.#credentials ?? [], null, 2), "utf8");
    fs.renameSync(tmp, file);
    try {
      const stat = fs.statSync(file);
      this.#credentialsStamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      this.#credentialsStamp = null;
    }
  }

  /**
   * Issue a credential scoped to one teammate: it may queue tasks for that
   * teammate only. The minted value is shown to the caller once and only
   * its SHA-256 digest is persisted.
   */
  issueTeammateCredential(teammateName, { label = "", ttlMs = null } = {}) {
    const teammate = this.getTeammate(teammateName);
    if (!teammate) throw new Error(`teammate "${teammateName}" not found`);
    if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error("credential ttl must be a positive duration");
    }
    const minted = mintCredentialValue();
    const createdAt = nowIso();
    const credential = {
      id: randomUUID(),
      teammate: teammate.name,
      label: String(label).slice(0, 80),
      digest: minted.digest,
      createdAt,
      // Expiry is optional: an integration that never rotates keeps working,
      // but a host that wants bounded lifetime gets it enforced on every use.
      expiresAt: ttlMs === null ? null : new Date(Date.parse(createdAt) + ttlMs).toISOString(),
      rotatedFromId: null,
      lastUsedAt: null,
      revokedAt: null
    };
    this.#loadCredentials().push(credential);
    this.#flushCredentials();
    return { credential, mint: minted.value };
  }

  /**
   * Rotate a credential: revoke the old one and issue a replacement with the
   * same teammate/label/remaining-lifetime shape. Returns the new value once.
   */
  rotateCredential(idOrPrefix, { ttlMs = null } = {}) {
    const old = this.#matchCredential(idOrPrefix);
    if (old.revokedAt) throw new Error(`credential ${old.id.slice(0, 8)} is already revoked — issue a new one instead`);
    // Preserve the original lifetime policy: if it expired, keep the same span.
    const inheritedTtl = ttlMs === null && old.expiresAt
      ? Math.max(1, Date.parse(old.expiresAt) - Date.parse(old.createdAt))
      : ttlMs;
    old.revokedAt = nowIso();
    const { credential, mint } = this.issueTeammateCredential(old.teammate, { label: old.label, ttlMs: inheritedTtl });
    credential.rotatedFromId = old.id;
    this.#flushCredentials();
    return { credential, mint, previous: old };
  }

  /** Credentials that are expired or expiring within `withinMs`. */
  expiringCredentials({ withinMs = 7 * 24 * 3600 * 1000, now = Date.now() } = {}) {
    return this.#loadCredentials()
      .filter((entry) => !entry.revokedAt && entry.expiresAt)
      .map((entry) => ({ ...entry, expired: Date.parse(entry.expiresAt) <= now }))
      .filter((entry) => entry.expired || Date.parse(entry.expiresAt) - now <= withinMs)
      .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
  }

  /** Shared prefix matcher for revoke/rotate: unique match or a clear error. */
  #matchCredential(idOrPrefix) {
    const credentials = this.#loadCredentials();
    const matches = credentials.filter((entry) => entry.id.startsWith(idOrPrefix));
    if (matches.length === 0) throw new Error(`no credential matches "${idOrPrefix}"`);
    if (matches.length > 1) throw new Error(`ambiguous credential prefix "${idOrPrefix}" (${matches.length} matches)`);
    return matches[0];
  }

  listCredentials() {
    return [...this.#loadCredentials()];
  }

  /** Revoke by full id or unambiguous prefix. */
  revokeCredential(idOrPrefix) {
    const record = this.#matchCredential(idOrPrefix);
    if (!record.revokedAt) {
      record.revokedAt = nowIso();
      this.#flushCredentials();
    }
    return record;
  }

  /** Resolve a presented bearer value to a live credential record (or null). */
  resolveCredential(presentedValue) {
    if (typeof presentedValue !== "string" || !presentedValue.startsWith(CREDENTIAL_PREFIX)) return null;
    const digest = digestOf(presentedValue);
    const record = this.#loadCredentials().find((entry) => entry.digest === digest && !entry.revokedAt);
    if (!record) return null;
    // Expiry is enforced on use, not only displayed: an expired integration
    // must fail closed even if nobody ran the rotation CLI.
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return null;
    if (!this.getTeammate(record.teammate)) return null; // teammate deleted → credential dead
    // Best-effort usage stamp, throttled to one write per minute.
    const stale = !record.lastUsedAt || Date.now() - Date.parse(record.lastUsedAt) > 60_000;
    if (stale) {
      record.lastUsedAt = nowIso();
      try {
        this.#flushCredentials();
      } catch {
        // a usage stamp must never fail the request
      }
    }
    return record;
  }

  // ---- queue ----

  enqueue(teammateName, instruction, options = {}) {
  this.sync();
    const teammate = this.getTeammate(teammateName);
    if (!teammate) throw new Error(`teammate "${teammateName}" not found`);
    const task = sanitizeTask({
      teammateId: teammate.id,
      instruction,
      runSource: options.runSource ?? "user",
      priority: options.priority,
      handoff: options.handoff
    });
    this.queue.push(task);
    this.flush();
    return task;
  }

  /** FIFO claim: oldest pending task (createdAt, then insertion order). */
  next() {
  this.sync();
    const pending = this.queue.filter((t) => t.status === "pending");
    if (!pending.length) return null;
    pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.priority - b.priority);
    const task = pending[0];
    task.status = "running";
    task.startedAt = nowIso();
    task.attempts += 1;
    task.error = null;
    this.flush();
    return task;
  }

  /**
   * Record provider-reported usage on a task and roll it into teammate totals.
   * Kept separate from complete() so a failed or cancelled task still carries
   * what it spent — the tokens were burned either way.
   */
  /** Attach the workspace change summary captured after a run. */
  recordArtifacts(taskId, artifacts) {
  this.sync();
    const task = this.getTask(taskId);
    if (!task || !artifacts) return null;
    task.artifacts = artifacts;
    this.flush();
    return task;
  }

  recordUsage(taskId, usage) {
  this.sync();
    const task = this.getTask(taskId);
    if (!task || !usage) return null;
    task.usage = usage;
    const teammate = this.teammates.find((t) => t.id === task.teammateId);
    if (teammate) {
      teammate.stats.totalTokens = (teammate.stats.totalTokens ?? 0) + (Number(usage.totalTokens) || 0);
      teammate.stats.totalCostUsd = Number(((teammate.stats.totalCostUsd ?? 0) + (Number(usage.costUsd) || 0)).toFixed(6));
    }
    this.flush();
    return task;
  }

  complete(taskId, result) {
  this.sync();
    const task = this.requireTask(taskId);
    task.status = "done";
    task.finishedAt = nowIso();
    task.result = typeof result === "string" ? result : JSON.stringify(result ?? null);
    this.bumpTeammateStats(task.teammateId, "completed");
    this.flush();
    return task;
  }

  fail(taskId, error) {
  this.sync();
    const task = this.requireTask(taskId);
    task.status = "failed";
    task.finishedAt = nowIso();
    task.error = String(error?.message ?? error ?? "unknown error").slice(0, 2000);
    this.bumpTeammateStats(task.teammateId, "failed");
    this.flush();
    return task;
  }

  cancel(taskId, reason = "cancelled by user") {
  this.sync();
    const task = this.requireTask(taskId);
    if (task.status === "done" || task.status === "failed") return task;
    if (task.status === "running") {
      // A running task is owned by a worker: only a request is recorded here.
      // The worker aborts the subprocess and finalizes the status itself.
      task.status = "cancelling";
      task.cancelRequestedAt = nowIso();
      this.flush();
      return task;
    }
    task.status = "cancelled";
    task.finishedAt = nowIso();
    task.error = reason;
    this.flush();
    return task;
  }

  /** Finalize a cancellation the worker performed (running → cancelled). */
  finishCancellation(taskId, reason = "cancelled while running") {
  this.sync();
    const task = this.requireTask(taskId);
    if (task.status === "done" || task.status === "failed") return task;
    task.status = "cancelled";
    task.finishedAt = nowIso();
    task.error = reason;
    this.flush();
    return task;
  }

  requireTask(taskId) {
  this.sync();
    const task = this.queue.find((t) => t.id === taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    return task;
  }

  getTask(taskId) {
  this.sync();
    return this.queue.find((t) => t.id === taskId) ?? null;
  }

  listTasks(filter = {}) {
  this.sync();
    return this.queue
      .filter((t) => (filter.teammateId ? t.teammateId === filter.teammateId : true))
      .filter((t) => (filter.status ? t.status === filter.status : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  bumpTeammateStats(teammateId, kind) {
  this.sync();
    const teammate = this.teammates.find((t) => t.id === teammateId);
    if (!teammate) return;
    if (kind === "completed") teammate.stats.completed += 1;
    else teammate.stats.failed += 1;
    teammate.updatedAt = nowIso();
  }

  // ---- messages ----

  /** Send a message to a teammate's inbox. `from` is "human" or a teammate name. */
  sendMessage({ from = "human", to, text }) {
  this.sync();
    if (!this.getTeammate(to)) throw new Error(`teammate "${to}" not found`);
    const message = sanitizeMessage({ from, to, text });
    this.messages.push(message);
    this.flushMessages();
    return message;
  }

  unreadMessages(teammateName) {
  this.sync();
    return this.messages.filter((m) => m.to === teammateName && m.readAt === null);
  }

  /** Return unread messages for a teammate and mark them read (drain semantics). */
  drainInbox(teammateName) {
  this.sync();
    const unread = this.unreadMessages(teammateName);
    if (!unread.length) return [];
    const at = nowIso();
    for (const message of unread) message.readAt = at;
    this.flushMessages();
    return unread;
  }

  // ---- routines ----

  addRoutine({ teammate, instruction, everyMs }) {
  this.sync();
    const routine = sanitizeRoutine({ teammate, instruction, everyMs }, this.teammates);
    this.routines.push(routine);
    this.flushRoutines();
    return routine;
  }

  listRoutines() {
  this.sync();
    return [...this.routines].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  removeRoutine(routineId) {
  this.sync();
    const idx = this.routines.findIndex((r) => r.id === routineId || r.id.startsWith(routineId));
    if (idx === -1) throw new Error(`routine "${routineId}" not found`);
    const [removed] = this.routines.splice(idx, 1);
    this.flushRoutines();
    return removed;
  }

  /** Enabled routines whose interval has elapsed (or never ran). */
  dueRoutines(now = Date.now()) {
  this.sync();
    return this.routines.filter((r) => {
      if (!r.enabled) return false;
      if (!r.lastRunAt) return true;
      return now - Date.parse(r.lastRunAt) >= r.everyMs;
    });
  }

  /** Record that a routine fired; prevents re-enqueue storms. */
  markRoutineRun(routineId, taskId, at = nowIso()) {
  this.sync();
    const routine = this.routines.find((r) => r.id === routineId);
    if (!routine) return null;
    routine.lastRunAt = at;
    routine.lastTaskId = taskId;
    this.flushRoutines();
    return routine;
  }
}

export { MAX_ATTEMPTS, TASK_STATUSES };
