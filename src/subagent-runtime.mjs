import crypto from "node:crypto";

function now() {
  return new Date().toISOString();
}

function createId(prefix = "agent") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function abortError(reason = "cancelled") {
  const error = new Error(String(reason));
  error.code = "ABORT_ERR";
  return error;
}

function timeoutError(timeoutMs) {
  const error = new Error(`subagent timed out after ${timeoutMs}ms`);
  error.code = "TIMEOUT";
  return error;
}

function boundedInteger(value, fallback, { min, max, field }) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${field} must be an integer between ${min} and ${max}`);
  return value;
}

function validateResultSchema(value, schema) {
  if (!schema) return null;
  if (schema.type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) {
    return "result must be an object";
  }
  for (const key of schema.required ?? []) {
    if (value?.[key] === undefined) return `missing required result field: ${key}`;
  }
  const properties = schema.properties ?? {};
  for (const [key, definition] of Object.entries(properties)) {
    if (value?.[key] === undefined || !definition?.type) continue;
    if (definition.type === "array" && !Array.isArray(value[key])) return `result field ${key} must be array`;
    if (definition.type !== "array" && typeof value[key] !== definition.type) return `result field ${key} must be ${definition.type}`;
  }
  return null;
}

export class SubagentRuntime {
  constructor(options = {}) {
    this.executor = options.executor ?? (async () => ({ ok: true }));
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.trace = options.trace ?? (() => {});
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? null;
    this.defaultMaxRetries = options.defaultMaxRetries ?? 0;
    this.tasks = new Map();
    this.inboxes = new Map();
    this.active = 0;
    this.queue = [];
  }

  /** Deliver a message to another subagent's inbox (peer messaging). */
  send(toId, message) {
    if (!this.tasks.has(toId)) throw new Error(`unknown subagent: ${toId}`);
    if (!this.inboxes.has(toId)) this.inboxes.set(toId, []);
    this.inboxes.get(toId).push({ from: "parent", ts: now(), message });
    this.trace("subagent_message_sent", { to: toId });
  }

  /** Read and drain a subagent's queued messages. */
  messages(id) {
    const inbox = this.inboxes.get(id) ?? [];
    this.inboxes.set(id, []);
    return inbox;
  }

  /** True when the task is finished and may be depended on by later tasks. */
  #isSettled(id) {
    const task = this.tasks.get(id);
    return task ? ["completed", "failed", "cancelled"].includes(task.status) : false;
  }

  #dependenciesSatisfied(task) {
    return (task.dependencies ?? []).every((dep) => {
      const depTask = this.tasks.get(dep);
      return depTask && depTask.status === "completed";
    });
  }

  spawn(request = {}) {
    if (!request.prompt || typeof request.prompt !== "string") throw new Error("subagent prompt is required");
    const id = request.id ?? createId("subagent");
    if (this.tasks.has(id)) throw new Error(`subagent already exists: ${id}`);
    const dependencies = [...(request.dependencies ?? [])];
    for (const dep of dependencies) {
      if (!this.tasks.has(dep)) throw new Error(`unknown dependency: ${dep}`);
    }
    const controller = new AbortController();
    const timeoutMs = boundedInteger(request.timeoutMs, this.defaultTimeoutMs, { min: 100, max: 600_000, field: "subagent timeoutMs" });
    const maxRetries = boundedInteger(request.maxRetries, this.defaultMaxRetries, { min: 0, max: 5, field: "subagent maxRetries" });
    const traceId = request.traceId ?? createId("trace");
    const task = {
      id,
      label: request.label ?? id,
      prompt: request.prompt,
      schema: request.schema ?? null,
      dependencies,
      traceId,
      timeoutMs,
      maxRetries,
      attempts: 0,
      status: dependencies.length ? "blocked" : "queued",
      createdAt: now(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      controller,
      promise: null
    };
    task.promise = new Promise((resolve) => {
      task.resolve = resolve;
    });
    this.tasks.set(id, task);
    if (task.status === "blocked") {
      this.trace("subagent_blocked", { id, traceId, dependencies: task.dependencies });
    } else {
      this.queue.push(task);
      this.trace("subagent_queued", { id, traceId, label: task.label });
    }
    this.#releaseBlocked();
    this.#drain();
    return this.status(id);
  }

  status(id) {
    const task = this.tasks.get(id);
    if (!task) return null;
    return {
      id: task.id,
      label: task.label,
      status: task.status,
      dependencies: [...(task.dependencies ?? [])],
      traceId: task.traceId,
      timeoutMs: task.timeoutMs,
      maxRetries: task.maxRetries,
      attempts: task.attempts,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      result: task.result,
      error: task.error
    };
  }

  async wait(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`unknown subagent: ${id}`);
    await task.promise;
    return this.status(id);
  }

  cancel(id, reason = "cancelled") {
    const task = this.tasks.get(id);
    if (!task) return null;
    if (["completed", "failed", "cancelled"].includes(task.status)) return this.status(id);
    if (task.status === "queued" || task.status === "blocked") {
      const wasQueued = task.status === "queued";
      this.queue = this.queue.filter((item) => item.id !== id);
      task.status = "cancelled";
      task.completedAt = now();
      task.error = String(reason);
      task.resolve();
      this.trace("subagent_cancelled", { id, traceId: task.traceId, reason: String(reason), queued: wasQueued });
      this.#drain();
      return this.status(id);
    }
    task.controller.abort(reason);
    return this.status(id);
  }

  list() {
    return [...this.tasks.values()].map((task) => this.status(task.id));
  }

  /**
   * Declaratively schedule a DAG of subagents. Each node is a spawn request
   * with an optional `dependsOn` array of sibling node names. Nodes whose
   * dependencies are not yet spawned are spawned as blocked and released when
   * their dependencies complete. Returns the spawned statuses in node order.
   */
  schedule(nodes) {
    if (!Array.isArray(nodes)) throw new Error("schedule requires a node array");
    const ids = new Map();
    for (const node of nodes) {
      if (!node.name || typeof node.name !== "string") throw new Error("each schedule node requires a name");
      ids.set(node.name, createId(node.name));
    }
    const spawned = [];
    for (const node of nodes) {
      const id = ids.get(node.name);
      const dependencies = (node.dependsOn ?? []).map((dep) => {
        if (!ids.has(dep)) throw new Error(`schedule node ${node.name} depends on unknown ${dep}`);
        return ids.get(dep);
      });
      spawned.push(this.spawn({
        id,
        label: node.name,
        prompt: node.prompt,
        schema: node.schema,
        timeoutMs: node.timeoutMs,
        maxRetries: node.maxRetries,
        traceId: node.traceId,
        dependencies
      }));
    }
    return spawned;
  }

  /** Wait for every listed subagent and return their statuses. */
  async waitAll(ids) {
    const statuses = [];
    for (const id of ids) statuses.push(await this.wait(id));
    return statuses;
  }

  /** Promote blocked tasks whose dependencies have all completed into the queue. */
  #releaseBlocked() {
    for (const task of this.tasks.values()) {
      if (task.status !== "blocked") continue;
      const failedDependency = (task.dependencies ?? []).find((dep) => {
        const depTask = this.tasks.get(dep);
        return depTask && ["failed", "cancelled"].includes(depTask.status);
      });
      if (failedDependency) {
        task.status = "failed";
        task.completedAt = now();
        task.error = `dependency did not complete: ${failedDependency}`;
        task.resolve();
        this.trace("subagent_failed", { id: task.id, traceId: task.traceId, error: task.error });
        continue;
      }
      if (this.#dependenciesSatisfied(task)) {
        task.status = "queued";
        this.queue.push(task);
        this.trace("subagent_unblocked", { id: task.id, traceId: task.traceId, dependencies: task.dependencies });
      }
    }
  }

  #drain() {
    this.#releaseBlocked();
    while (this.active < this.maxConcurrent && this.queue.length) {
      const task = this.queue.shift();
      this.#run(task);
    }
  }

  async #run(task) {
    this.active += 1;
    task.status = "running";
    task.startedAt = now();
    this.trace("subagent_started", { id: task.id, traceId: task.traceId, label: task.label });
    try {
      while (true) {
        task.attempts += 1;
        try {
          const result = await this.#executeAttempt(task);
          if (task.controller.signal.aborted) throw abortError(task.controller.signal.reason);
          const schemaError = validateResultSchema(result, task.schema);
          if (schemaError) throw new Error(schemaError);
          task.status = "completed";
          task.result = result;
          this.trace("subagent_completed", { id: task.id, traceId: task.traceId, attempts: task.attempts });
          break;
        } catch (error) {
          const cancelled = task.controller.signal.aborted || error?.code === "ABORT_ERR";
          if (cancelled || task.attempts > task.maxRetries) throw error;
          task.error = String(error?.message ?? error);
          this.trace("subagent_retry", { id: task.id, traceId: task.traceId, attempt: task.attempts, error: task.error });
        }
      }
    } catch (error) {
      const cancelled = task.controller.signal.aborted || error?.code === "ABORT_ERR";
      task.status = cancelled ? "cancelled" : "failed";
      task.error = String(error?.message ?? error);
      this.trace(cancelled ? "subagent_cancelled" : "subagent_failed", { id: task.id, traceId: task.traceId, attempts: task.attempts, error: task.error });
    } finally {
      task.completedAt = now();
      this.active -= 1;
      task.resolve();
      this.#drain();
    }
  }

  #executeAttempt(task) {
    const attemptController = new AbortController();
    const relayAbort = () => attemptController.abort(task.controller.signal.reason);
    task.controller.signal.addEventListener("abort", relayAbort, { once: true });
    let timedOut = false;
    const timer = task.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          attemptController.abort(`timeout after ${task.timeoutMs}ms`);
        }, task.timeoutMs)
      : null;
    return Promise.resolve()
      .then(() => {
        if (attemptController.signal.aborted) throw abortError(attemptController.signal.reason);
        return this.executor({
        id: task.id,
        label: task.label,
        prompt: task.prompt,
        schema: task.schema,
        traceId: task.traceId,
        attempt: task.attempts,
        timeoutMs: task.timeoutMs
      }, { signal: attemptController.signal });
      })
      .catch((error) => {
        if (timedOut) throw timeoutError(task.timeoutMs);
        throw error;
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        task.controller.signal.removeEventListener("abort", relayAbort);
      });
  }
}
