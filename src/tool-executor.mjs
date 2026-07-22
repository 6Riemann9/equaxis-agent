import crypto from "node:crypto";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const body = Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",");
    return "{" + body + "}";
  }
  return JSON.stringify(value);
}

export function idempotencyKey(task) {
  if (task.idempotencyKey) return String(task.idempotencyKey);
  const payload = { toolName: task.toolName, args: task.args ?? {}, id: task.id };
  return `eqx-${crypto.createHash("sha256").update(stableJson(payload)).digest("hex").slice(0, 24)}`;
}

export class IdempotencyStore {
  constructor() {
    this.values = new Map();
  }

  get(key) { return this.values.get(key); }
  set(key, value) { this.values.set(key, value); }
  clear() { this.values.clear(); }
}

function abortError(reason = "cancelled") {
  const error = new Error(String(reason));
  error.code = "CANCELLED";
  return error;
}

function linkAbort(parentSignal, controller) {
  if (!parentSignal) return () => {};
  const onAbort = () => controller.abort(parentSignal.reason ?? "parent cancelled");
  if (parentSignal.aborted) onAbort();
  else parentSignal.addEventListener("abort", onAbort, { once: true });
  return () => parentSignal.removeEventListener("abort", onAbort);
}

async function runOne(task, executor, options) {
  const key = idempotencyKey(task);
  const cached = options.idempotency.get(key);
  if (cached?.status === "completed") return { task, status: "deduplicated", key, result: cached.result };

  const controller = new AbortController();
  const unlink = linkAbort(options.signal, controller);
  const timeout = options.timeoutMs > 0
    ? setTimeout(() => controller.abort(`task timeout after ${options.timeoutMs}ms`), options.timeoutMs)
    : undefined;
  options.controllers.add(controller);
  try {
    if (controller.signal.aborted) throw abortError(controller.signal.reason);
    const rawResult = await executor({ ...task, idempotencyKey: key }, {
      signal: controller.signal,
      idempotencyKey: key
    });
    const result = options.resultMiddleware
      ? await options.resultMiddleware(task, rawResult)
      : rawResult;
    options.idempotency.set(key, { status: "completed", result });
    return { task, status: "completed", key, result };
  } catch (error) {
    const cancelled = controller.signal.aborted || error?.code === "ABORT_ERR";
    return { task, status: cancelled ? "cancelled" : "failed", key, error: String(error) };
  } finally {
    if (timeout) clearTimeout(timeout);
    unlink();
    options.controllers.delete(controller);
  }
}

async function runWave(tasks, executor, options) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length && !options.signal?.aborted) {
      const task = tasks[cursor++];
      results.push(await runOne(task, executor, options));
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.maxConcurrency, tasks.length) }, worker));
  if (options.signal?.aborted) {
    for (const task of tasks.filter((item) => !results.some((result) => result.task.id === item.id))) {
      results.push({ task, status: "cancelled", key: idempotencyKey(task), error: "parent cancelled" });
    }
  }
  return results.sort((left, right) => left.task.id.localeCompare(right.task.id));
}

function readyTasks(tasks, completed) {
  return tasks.filter((task) => (task.dependsOn ?? []).every((dependency) => completed.has(dependency)));
}

/** Execute a plan with bounded workers, cancellation, idempotency, compensation and replanning. */
export async function executeToolPlan(initialTasks, executor, options = {}) {
  const settings = {
    maxConcurrency: Math.max(1, Math.floor(options.maxConcurrency ?? 4)),
    timeoutMs: Math.max(0, Number(options.timeoutMs ?? 30000)),
    signal: options.signal,
    idempotency: options.idempotency ?? new IdempotencyStore(),
    controllers: new Set(),
    resultMiddleware: options.resultMiddleware,
    compensateOnFailure: options.compensateOnFailure !== false,
    compensators: options.compensators ?? {}
  };
  const tasks = new Map(initialTasks.map((task) => [task.id, { ...task, dependsOn: [...(task.dependsOn ?? [])] }]));
  const completed = new Map();
  const failed = new Map();
  const skipped = new Map();
  const executed = [];
  let waves = 0;

  const onAbort = () => settings.controllers.forEach((controller) => controller.abort(settings.signal.reason ?? "parent cancelled"));
  settings.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const remaining = [...tasks.values()].filter((task) => !completed.has(task.id) && !failed.has(task.id) && !skipped.has(task.id));
      if (!remaining.length || settings.signal?.aborted) break;
      const ready = readyTasks(remaining, new Set(completed.keys()));
      const blocked = remaining.filter((task) => (task.dependsOn ?? []).some((dependency) => failed.has(dependency) || skipped.has(dependency)));
      for (const task of blocked) skipped.set(task.id, "dependency_failed");
      if (!ready.length) {
        if (blocked.length) continue;
        throw new Error("dynamic plan cannot make progress; check dependencies");
      }
      const safe = ready.filter((task) => task.readOnly !== false && task.risk !== "high" && task.risk !== "blocked");
      const wave = safe.length ? safe.slice(0, settings.maxConcurrency) : [ready.find((task) => task.readOnly === false || ["high", "blocked"].includes(task.risk)) ?? ready[0]];
      waves += 1;
      const results = await runWave(wave, executor, settings);
      for (const result of results) {
        if (result.status === "completed" || result.status === "deduplicated") {
          completed.set(result.task.id, result);
          if (result.status === "completed") executed.push(result);
        } else failed.set(result.task.id, result);
      }
      if (options.replan) {
        const additions = await options.replan({ completed, failed, skipped, wave: results });
        for (const task of additions ?? []) {
          if (tasks.has(task.id)) throw new Error(`dynamic plan duplicate task: ${task.id}`);
          tasks.set(task.id, { ...task, dependsOn: [...(task.dependsOn ?? [])] });
        }
      }
      if (results.some((result) => result.status === "failed") && settings.compensateOnFailure) break;
    }

    const cancelled = Boolean(settings.signal?.aborted);
    const needsCompensation = failed.size > 0 && settings.compensateOnFailure;
    const compensation = [];
    if (needsCompensation) {
      for (const result of [...executed].reverse()) {
        const key = result.task.compensationKey;
        if (!key || typeof settings.compensators[key] !== "function") continue;
        try {
          await settings.compensators[key]({ ...result.task, idempotencyKey: idempotencyKey(result.task) }, { signal: settings.signal });
          compensation.push({ taskId: result.task.id, status: "completed" });
        } catch (error) {
          compensation.push({ taskId: result.task.id, status: "failed", error: String(error) });
        }
      }
    }
    return {
      status: cancelled ? "cancelled" : failed.size ? "failed" : "completed",
      waves,
      completed: [...completed.values()],
      failed: [...failed.values()],
      skipped: [...skipped.entries()].map(([taskId, reason]) => ({ taskId, reason })),
      compensation
    };
  } finally {
    settings.signal?.removeEventListener("abort", onAbort);
  }
}
