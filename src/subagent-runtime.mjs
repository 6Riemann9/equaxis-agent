import crypto from "node:crypto";
import { Value } from "typebox/value";
import { wisdomPreamble } from "./wisdom-store.mjs";

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
  // TypeBox's Value library compiles plain JSON Schema objects as well as
  // TypeBox schemas, covering nested objects, arrays (items), enums and
  // unions — beyond the flat type/required checks it replaces.
  try {
    if (Value.Check(schema, value)) return null;
    const first = [...Value.Errors(schema, value)][0];
    return first?.message ? `result does not match schema: ${first.message}` : "result does not match schema";
  } catch (error) {
    return `invalid result schema: ${String(error?.message ?? error)}`;
  }
}

/**
 * MARC v1 (arXiv 2608.13476) stage-level failure attribution: every failure
 * is attributed to the execution stage it occurred in plus a failure kind,
 * so pipelines can answer "which stage contributes the most failures"
 * instead of treating a multi-agent run as one opaque failure.
 *
 * Stages: scheduling (dependency/queueing), execution (run/retry/timeout),
 * finalization (result-schema validation).
 */
export function classifyFailure(task) {
  const error = String(task?.error ?? "");
  const code = task?.errorCode ?? null;
  const status = task?.status;
  if (status === "cancelled" || code === "ABORT_ERR") return { phase: "execution", kind: "cancelled" };
  if (code === "TIMEOUT") return { phase: "execution", kind: "timeout" };
  if (code === "SCHEMA") return { phase: "finalization", kind: "schema" };
  if (error.startsWith("dependency did not complete")) return { phase: "scheduling", kind: "dependency" };
  return { phase: "execution", kind: "executor" };
}

export class SubagentRuntime {
  constructor(options = {}) {
    this.executor = options.executor ?? (async () => ({ ok: true }));
    this.verifyEvidence = options.verifyEvidence ?? null;
    this.onTaskComplete = options.onTaskComplete ?? null;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.trace = options.trace ?? (() => {});
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60000;
    this.defaultMaxRetries = options.defaultMaxRetries ?? 1;
    this.stateStore = options.stateStore ?? null;
    this.tasks = new Map();
    this.inboxes = new Map();
    this.active = 0;
    this.queue = [];
    // Per-model concurrency buckets (oh-my-opencode inspiration): parallel
    // DAG branches often exceed a single provider's quota; bucket limits let
    // one model saturate its quota while another model's tasks keep running.
    this.defaultModelKey = options.defaultModelKey ?? "default";
    this.modelConcurrency = options.modelConcurrency ?? {};
    this.activeByModel = new Map();
    this.#restoreSnapshots();
  }

  #restoreSnapshots() {
    const snapshots = this.stateStore?.loadSnapshots?.() ?? [];
    for (const snapshot of snapshots) {
      if (!snapshot?.id || this.tasks.has(snapshot.id)) continue;
      // In-flight work cannot be resumed after a restart: keep it visible as
      // failed (with the reason) instead of dropping it silently. Blocked
      // dependents of a failed task are failed by #releaseBlocked, so nothing
      // becomes an orphan.
      const terminal = ["completed", "failed", "cancelled"].includes(snapshot.status);
      const status = terminal ? snapshot.status : "failed";
      const task = {
        id: snapshot.id,
        label: snapshot.label ?? snapshot.id,
        prompt: "",
        schema: null,
        dependencies: [...(snapshot.dependencies ?? [])],
        traceId: snapshot.traceId,
        timeoutMs: snapshot.timeoutMs ?? null,
        maxRetries: snapshot.maxRetries ?? 0,
        attempts: snapshot.attempts ?? 0,
        status,
        createdAt: snapshot.createdAt ?? now(),
        startedAt: snapshot.startedAt ?? null,
        completedAt: terminal ? snapshot.completedAt ?? null : now(),
        result: snapshot.result ?? null,
        error: terminal ? snapshot.error ?? null : `interrupted by restart (was ${snapshot.status})`,
        controller: new AbortController(),
        promise: null,
        restored: true
      };
      task.promise = Promise.resolve();
      task.resolve = () => {};
      this.tasks.set(task.id, task);
    }
  }

  #record(event, task) {
    try {
      if (event === "failed" || event === "cancelled") {
        if (!task.failurePhase || !task.failureKind) {
          const attribution = classifyFailure(task);
          task.failurePhase = attribution.phase;
          task.failureKind = attribution.kind;
        }
      }
      this.stateStore?.record?.(event, task);
    } catch (error) {
      this.trace("subagent_persistence_failed", { id: task.id, traceId: task.traceId, error: String(error?.message ?? error) });
    }
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
    // Wisdom accumulation (oh-my-opencode): when this task depends on
    // already-finished tasks and a wisdom root is given, prepend their
    // persisted summaries so serial batches reuse lessons. Best-effort.
    let prompt = request.prompt;
    if (request.wisdomRoot && dependencies.length) {
      try {
        const preamble = wisdomPreamble({ projectRoot: request.wisdomRoot, taskIds: dependencies });
        if (preamble) prompt = `${preamble}\n\n${prompt}`;
      } catch {
        // best effort
      }
    }
    const controller = new AbortController();
    const timeoutMs = boundedInteger(request.timeoutMs, this.defaultTimeoutMs, { min: 100, max: 600_000, field: "subagent timeoutMs" });
    const maxRetries = boundedInteger(request.maxRetries, this.defaultMaxRetries, { min: 0, max: 5, field: "subagent maxRetries" });
    const traceId = request.traceId ?? createId("trace");
    const task = {
      id,
      label: request.label ?? id,
      prompt,
      modelKey: request.model ?? this.defaultModelKey,
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
      this.#record("blocked", task);
    } else {
      this.queue.push(task);
      this.trace("subagent_queued", { id, traceId, label: task.label });
      this.#record("queued", task);
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
      modelKey: task.modelKey ?? null,
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
      error: task.error,
      errorCode: task.errorCode ?? null,
      failurePhase: task.failurePhase ?? null,
      failureKind: task.failureKind ?? null,
      evidence: task.evidence ?? null
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
      this.#record("cancelled", task);
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
  schedule(nodes, options = {}) {
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
      // Wisdom accumulation (oh-my-opencode): prepend the wisdom of finished
      // dependencies so serial batches reuse lessons instead of re-tripping
      // the same pitfalls. Best-effort; missing wisdom adds nothing.
      let prompt = node.prompt;
      if (options.wisdomRoot && dependencies.length) {
        try {
          const preamble = wisdomPreamble({ projectRoot: options.wisdomRoot, taskIds: dependencies });
          if (preamble) prompt = `${preamble}\n\n${prompt}`;
        } catch {
          // best effort
        }
      }
      spawned.push(this.spawn({
        id,
        label: node.name,
        prompt,
        schema: node.schema,
        model: node.model,
        timeoutMs: node.timeoutMs,
        maxRetries: node.maxRetries,
        traceId: node.traceId,
        dependencies
      }));
    }
    return spawned.map((status) => status);
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
        task.failurePhase = "scheduling";
        task.failureKind = "dependency";
        task.resolve();
        this.trace("subagent_failed", { id: task.id, traceId: task.traceId, error: task.error });
        this.#record("failed", task);
        continue;
      }
      if (this.#dependenciesSatisfied(task)) {
        task.status = "queued";
        this.queue.push(task);
        this.trace("subagent_unblocked", { id: task.id, traceId: task.traceId, dependencies: task.dependencies });
        this.#record("queued", task);
      }
    }
  }

  #drain() {
    this.#releaseBlocked();
    while (this.active < this.maxConcurrent && this.queue.length) {
      // Pick the first queued task whose model bucket has capacity; tasks
      // behind a saturated bucket wait but never block other buckets.
      let picked = -1;
      for (let index = 0; index < this.queue.length; index += 1) {
        const candidate = this.queue[index];
        const bucketLimit = this.modelConcurrency[candidate.modelKey] ?? Infinity;
        const bucketActive = this.activeByModel.get(candidate.modelKey) ?? 0;
        if (bucketActive < bucketLimit) {
          picked = index;
          break;
        }
      }
      if (picked === -1) break;
      const [task] = this.queue.splice(picked, 1);
      this.#run(task);
    }
  }

  async #run(task) {
    this.active += 1;
    const modelKey = task.modelKey ?? this.defaultModelKey;
    this.activeByModel.set(modelKey, (this.activeByModel.get(modelKey) ?? 0) + 1);
    task.status = "running";
    task.startedAt = now();
    this.trace("subagent_started", { id: task.id, traceId: task.traceId, label: task.label });
    this.#record("started", task);
    try {
      while (true) {
        task.attempts += 1;
        try {
          const result = await this.#executeAttempt(task);
          if (task.controller.signal.aborted) throw abortError(task.controller.signal.reason);
          const schemaError = validateResultSchema(result, task.schema);
          if (schemaError) {
            const error = new Error(schemaError);
            error.code = "SCHEMA";
            throw error;
          }
          // Vero (arXiv 2608.13522) audit principle: completion claims must be
          // machine-checkable. When a verifier is configured, the subagent's
          // claimed evidence (files, artifacts) is checked and the outcome is
          // recorded on the task — audit, not a gate: a failed verification
          // flags the claim without failing the run.
          if (this.verifyEvidence) {
            try {
              const verdict = await this.verifyEvidence(task, result);
              task.evidence = verdict?.ok === false
                ? { status: "unverified", issues: Array.isArray(verdict.issues) ? verdict.issues : [String(verdict.reason ?? "evidence check failed")] }
                : { status: "verified", issues: [] };
            } catch (error) {
              task.evidence = { status: "unverified", issues: [`evidence verifier error: ${String(error?.message ?? error)}`] };
            }
            this.trace(task.evidence.status === "verified" ? "subagent_evidence_verified" : "subagent_evidence_unverified", { id: task.id, traceId: task.traceId, issues: task.evidence.issues });
          }
          task.status = "completed";
          task.result = result;
          this.trace("subagent_completed", { id: task.id, traceId: task.traceId, attempts: task.attempts });
          break;
        } catch (error) {
          // Timeouts are terminal: the budget is exhausted, so retrying with
          // the same timeout would only double the wait. Retries are for
          // transient executor failures, not for budget exhaustion.
          const cancelled = task.controller.signal.aborted || error?.code === "ABORT_ERR" || error?.code === "TIMEOUT";
          if (cancelled || task.attempts > task.maxRetries) throw error;
          task.error = String(error?.message ?? error);
          this.trace("subagent_retry", { id: task.id, traceId: task.traceId, attempt: task.attempts, error: task.error });
          this.#record("retry", task);
        }
      }
    } catch (error) {
      const cancelled = task.controller.signal.aborted || error?.code === "ABORT_ERR";
      task.status = cancelled ? "cancelled" : "failed";
      task.error = String(error?.message ?? error);
      task.errorCode = error?.code ?? null;
      this.trace(cancelled ? "subagent_cancelled" : "subagent_failed", { id: task.id, traceId: task.traceId, attempts: task.attempts, error: task.error, code: task.errorCode });
    } finally {
      task.completedAt = now();
      this.#record(task.status, task);
      this.active -= 1;
      this.activeByModel.set(modelKey, Math.max(0, (this.activeByModel.get(modelKey) ?? 1) - 1));
      if (this.onTaskComplete) {
        try {
          this.onTaskComplete(task);
        } catch {
          // Wisdom/notifications must never break task finalization.
        }
      }
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
