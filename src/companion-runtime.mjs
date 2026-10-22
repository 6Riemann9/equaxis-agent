import { MAX_DELEGATION_DEPTH, buildHandoff, buildIntegrationRequest, delegationDepth, formatHandoff, formatRoster, routeTeammate } from "./companion-team.mjs";
import { captureBaseline, captureResult, formatArtifactSummary } from "./companion-artifacts.mjs";
/**
 * Companion runtime: the worker loop that drains the task queue.
 *
 * Each task = one teammate turn. The worker claims the oldest pending task,
 * builds the teammate's prompt (persona + instruction + workspace), runs it
 * through an executor (default: a Pi JSON-mode subprocess, the same executor
 * the subagent engine uses), records the result in the store, and notifies.
 *
 * The executor is injectable so tests drive the loop without spawning Pi.
 */

import fs from "node:fs";

/**
 * Build the prompt for one teammate turn.
 *
 * The persona is the durable "who this teammate is" text; the instruction is
 * this turn's task. We ask for a compact final answer because the worker
 * stores it verbatim as the task result and ships it through notifications.
 */
export function buildTeammatePrompt(teammate, task, context = {}) {
  const lines = [];
  lines.push(`You are ${teammate.name}, a persistent AI teammate.`);
  if (teammate.persona) lines.push(`Your persona: ${teammate.persona}`);

  for (const line of formatRoster(context.roster ?? [], { exclude: teammate.name })) lines.push(line);
  for (const line of formatHandoff(task.handoff)) lines.push(line);
  lines.push("");
  lines.push(`TASK (${task.id}):`);
  lines.push(task.instruction);
  lines.push("");
  if (context.workspacePath) {
    lines.push(`Your workspace directory: ${context.workspacePath}`);
    lines.push("Work inside your workspace unless the task explicitly says otherwise.");
    lines.push("");
  }
  if (context.inbox?.length) {
    lines.push("Unread messages for you (oldest first):");
    for (const message of context.inbox) {
      lines.push(`- from ${message.from}: ${message.text}`);
    }
    lines.push("");
  }
  lines.push("You collaborate with other teammates through your reply. On their own lines, you may emit:");
  lines.push("  DELEGATE @<teammate>: <one instruction for them to run as a task>");
  lines.push("  MESSAGE @<teammate>: <informational note for their next task>");
  lines.push("Collaboration directives (one per line, at the end of your reply):");
  lines.push("  DELEGATE @name: instruction   — hand a piece of work to a named teammate");
  lines.push("  DELEGATE: instruction         — hand it to whoever is best matched; the worker picks");
  lines.push("  MESSAGE @name: text           — leave a note in their inbox");
  lines.push("A delegated task carries your task, your findings and the files you produced, so the other teammate does not start blind. When they finish, their result is delivered back to you automatically and you get a turn to integrate it — do not wait for them in the same turn, and do not delegate this task away entirely.");
  lines.push("");
  lines.push("When you finish, end your reply with a section titled 'RESULT:' containing a concise summary (at most 20 lines) of what you did, decided, or found. That summary is delivered to your human as the task result.");
  return lines.join("\n");
}

/**
 * Coerce a reply into text without ever producing "[object Object]".
 * A transport wrapper that leaks an object through (an executor returning
 * { ok, output } instead of the stream) used to be stored verbatim as
 * "[object Object]" — useless in the feed and invisible as a bug.
 */
function replyText(reply) {
  if (typeof reply === "string") return reply;
  if (reply === null || reply === undefined) return "";
  try {
    return JSON.stringify(reply);
  } catch {
    return String(reply);
  }
}

/** Extract the RESULT: section; fall back to the whole (trimmed) reply. */
export function extractResult(reply) {
  const text = (typeof reply === "string" ? reply : replyText(reply)).trim();
  const marker = /(?:^|\n)#{0,3}\s*RESULT:?\s*\n?/i;
  const match = text.match(marker);
  if (!match) return text.slice(0, 4000);
  return text.slice(match.index + match[0].length).trim().slice(0, 4000);
}

/**
 * Parse collaboration directives from a teammate's full reply.
 * Recognizes single lines of the form:
 *   DELEGATE @<teammate>: <instruction>
 *   MESSAGE @<teammate>: <text>
 * Unknown or malformed directives are ignored (the reply text stays untouched).
 */
export function parseDirectives(reply) {
  const delegations = [];
  const messages = [];
  for (const line of replyText(reply).split("\n")) {
    const delegate = line.match(/^\s*DELEGATE\s+@([a-z0-9][a-z0-9_-]*)\s*:\s*(.+)$/i);
    if (delegate) {
      delegations.push({ to: delegate[1].toLowerCase(), instruction: delegate[2].trim(), routed: false });
      continue;
    }
    // "DELEGATE: instruction" with no name: the worker routes it to whoever is
    // best matched, so the human does not have to pre-assign work by hand.
    const routed = line.match(/^\s*DELEGATE\s*:\s*(.+)$/i);
    if (routed) {
      delegations.push({ to: null, instruction: routed[1].trim(), routed: true });
      continue;
    }
    const message = line.match(/^\s*MESSAGE\s+@([a-z0-9][a-z0-9_-]*)\s*:\s*(.+)$/i);
    if (message) messages.push({ to: message[1].toLowerCase(), text: message[2].trim() });
  }
  return { delegations, messages };
}

/** Enqueue every due routine as a task; returns the enqueued tasks. */
export function enqueueDueRoutines(store, now = Date.now()) {
  const enqueued = [];
  for (const routine of store.dueRoutines(now)) {
    if (!store.getTeammate(routine.teammate)) continue; // teammate deleted; skip
    const task = store.enqueue(routine.teammate, routine.instruction, { runSource: "routine" });
    store.markRoutineRun(routine.id, task.id, new Date(now).toISOString());
    enqueued.push(task);
  }
  return enqueued;
}

function textBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * Parse a Pi JSON-mode stdout stream (JSONL events) into the final assistant
 * reply text. The last assistant message wins: agent_end carries the settled
 * conversation; message_end events cover streams that end before agent_end.
 */
export function parsePiJsonReply(stdout) {
  let last = "";
  for (const line of replyText(stdout).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      const text = textBlocks(event.message.content);
      if (text.trim()) last = text;
    } else if (event?.type === "agent_end" && Array.isArray(event.messages)) {
      const assistants = event.messages.filter((m) => m?.role === "assistant");
      if (assistants.length) {
        const text = textBlocks(assistants[assistants.length - 1].content);
        if (text.trim()) last = text;
      }
    }
  }
  return last;
}

/**
 * Sum token/cost usage from a Pi JSON-mode stream.
 *
 * Usage rides on `turn_end.message.usage` (provider-reported, with a `cost`
 * block); `agent_end` is used only for the model/provider attribution when no
 * turn event carried it. Returns null when the stream reported nothing, so a
 * caller can distinguish "free" from "unknown".
 */
export function parsePiUsage(stdout) {
  let turns = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let provider = null;
  let model = null;
  let sawUsage = false;

  for (const line of replyText(stdout).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = event?.type === "turn_end" ? event.message : null;
    const usage = message?.usage;
    if (!usage) continue;
    sawUsage = true;
    turns += 1;
    input += Number(usage.input) || 0;
    output += Number(usage.output) || 0;
    cacheRead += Number(usage.cacheRead) || 0;
    cacheWrite += Number(usage.cacheWrite) || 0;
    totalTokens += Number(usage.totalTokens) || 0;
    costUsd += Number(usage.cost?.total) || 0;
    provider = message.provider ?? provider;
    model = message.model ?? model;
  }

  if (!sawUsage) return null;
  return {
    turns,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    costUsd: Number(costUsd.toFixed(6)),
    provider,
    model
  };
}

/**
 * Run the companion worker loop.
 *
 * Options:
 *   - store: CompanionStore (required)
 *   - executor: async (task, { prompt, workspacePath, signal }) => string reply
 *   - notify: async (event) => void (from createNotifier)
 *   - once: process at most one task, then stop (default false: poll forever)
 *   - pollMs: idle poll interval (default 2000)
 *   - signal: AbortSignal to stop the loop
 *   - logger: optional (...args) => void
 *   - maxTasks: stop after this many completed tasks (default Infinity)
 *
 * Returns a summary { processed, completed, failed, stoppedBy }.
 */
export async function runCompanionWorker(options) {
  const {
    store,
    executor,
    notify = null,
    once = false,
    pollMs = 2000,
    signal = null,
    logger = null,
    maxTasks = Infinity,
    routines = true,
    concurrency = 1,
    onTaskStart = null,
    onTaskEnd = null
  } = options ?? {};
  if (!store) throw new Error("runCompanionWorker: store is required");
  if (typeof executor !== "function") throw new Error("runCompanionWorker: executor is required");
  const log = (...args) => logger?.(...args);
  const slots = Math.max(1, Math.floor(Number(concurrency) || 1));

  const summary = { processed: 0, completed: 0, failed: 0, cancelled: 0, delegated: 0, reported: 0, routingMissed: 0, routingDeferred: 0, loopsStopped: 0, stoppedBy: "drained" };
  /** taskId -> AbortController for the in-flight run. */
  const running = new Map();

  const finish = (taskId) => running.delete(taskId);

  async function runOne(task, controller) {
    const teammate = store.teammates.find((t) => t.id === task.teammateId) ?? null;
    if (!teammate) {
      const error = new Error(`teammate ${task.teammateId} no longer exists`);
      store.fail(task.id, error);
      summary.processed += 1;
      summary.failed += 1;
      log(`companion: ${error.message}`);
      return;
    }

    const workspacePath = store.teammateDirectory(teammate, options.projectRoot ?? process.cwd());
    try {
      fs.mkdirSync(workspacePath, { recursive: true });
    } catch (error) {
      log(`companion: workspace mkdir failed for ${teammate.name}: ${error?.message ?? error}`);
    }

    const prompt = buildTeammatePrompt(teammate, task, {
      workspacePath,
      inbox: store.drainInbox(teammate.name),
      roster: store.listTeammates()
    });
    log(`companion: running task ${task.id} for @${teammate.name} (attempt ${task.attempts})`);
    // Artifacts: snapshot the workspace before the run, compare after. A
    // failure to snapshot must never stop the task itself.
    let artifactRoot = null;
    try {
      artifactRoot = store.rootDir;
      captureBaseline(artifactRoot, task.id, workspacePath);
    } catch (error) {
      log(`companion: artifact baseline failed for ${task.id}: ${error?.message ?? error}`);
      artifactRoot = null;
    }
    onTaskStart?.({ task, teammate });
    try {
      const reply = await executor(task, { prompt, workspacePath, teammate, signal: controller.signal });
      if (controller.signal.aborted) {
        // The subprocess was killed by a cancel request: record it as such
        // instead of a mysterious failure.
        store.finishCancellation(task.id, "cancelled while running");
        summary.processed += 1;
        summary.cancelled += 1;
        log(`companion: task ${task.id} cancelled`);
        return;
      }
      const result = extractResult(reply);
      // Capture the change list BEFORE applying directives: a handoff tells the
      // next teammate which files exist, so it has to be measured first.
      let changedFiles = null;
      if (artifactRoot) {
        try {
          const manifest = captureResult(artifactRoot, task.id, workspacePath);
          changedFiles = manifest;
          store.recordArtifacts(task.id, { counts: manifest.counts, capturedAt: manifest.capturedAt });
          log(`companion: artifacts for ${task.id}: ${formatArtifactSummary(manifest)}`);
        } catch (error) {
          log(`companion: artifact capture failed for ${task.id}: ${error?.message ?? error}`);
        }
      }
      applyDirectives(store, reply, teammate, { log, summary, sourceTask: task, result, artifacts: changedFiles });
      store.complete(task.id, result);
      deliverDelegationReport(store, store.getTask(task.id), { log, summary });
      summary.processed += 1;
      summary.completed += 1;
      log(`companion: task ${task.id} done`);
      if (notify) {
        try {
          await notify({ kind: "task_completed", teammate, task: store.getTask(task.id) });
        } catch (error) {
          log(`companion: notify failed: ${error?.message ?? error}`);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        store.finishCancellation(task.id, "cancelled while running");
        summary.processed += 1;
        summary.cancelled += 1;
        log(`companion: task ${task.id} cancelled`);
        return;
      }
      if (artifactRoot) {
        try {
          const manifest = captureResult(artifactRoot, task.id, workspacePath);
          store.recordArtifacts(task.id, { counts: manifest.counts, capturedAt: manifest.capturedAt, partial: true });
        } catch {
          // best effort: the failure reason matters more than the manifest
        }
      }
      store.fail(task.id, error);
      // A failure is still news the delegator needs.
      deliverDelegationReport(store, store.getTask(task.id), { log, summary });
      summary.processed += 1;
      summary.failed += 1;
      log(`companion: task ${task.id} failed: ${error?.message ?? error}`);
      if (notify) {
        try {
          await notify({ kind: "task_failed", teammate, task: store.getTask(task.id) });
        } catch (notifyError) {
          log(`companion: notify failed: ${notifyError?.message ?? notifyError}`);
        }
      }
    } finally {
      onTaskEnd?.({ task: store.getTask(task.id) });
      finish(task.id);
    }
  }

  /** Honour cancel requests that arrived while a task was running. */
  function sweepCancellations() {
    for (const [taskId, controller] of running) {
      if (controller.signal.aborted) continue;
      const task = store.getTask(taskId);
      if (task && task.status === "cancelling") {
        log(`companion: cancelling task ${taskId} on request`);
        controller.abort();
      }
    }
  }

  while (!signal?.aborted) {
    if (routines) {
      const fired = enqueueDueRoutines(store);
      if (fired.length) log(`companion: ${fired.length} routine(s) due, enqueued`);
    }
    sweepCancellations();

    // Replenish the pool. store.next() is synchronous and single-process, so
    // two slots can never claim the same task.
    //
    // Quotas are counted over claimed work, not finished work: `once` means
    // exactly one task total, and maxTasks caps the batch.
    const budget = once ? Math.min(1, maxTasks) : maxTasks;
    while (running.size < slots && summary.processed + running.size < budget) {
      const task = store.next();
      if (!task) break;
      const controller = new AbortController();
      running.set(task.id, controller);
      // Deliberately not awaited: slots run concurrently.
      void runOne(task, controller);
      if (once) break;
    }

    if (running.size === 0) {
      if (once || summary.processed >= maxTasks) {
        summary.stoppedBy = signal?.aborted ? "aborted" : once ? "once" : "maxTasks";
        return summary;
      }
      log(`companion: queue empty, sleeping ${pollMs}ms`);
      await sleep(pollMs, signal);
      if (signal?.aborted) {
        summary.stoppedBy = "aborted";
        return summary;
      }
      continue;
    }

    if (once || summary.processed + running.size >= maxTasks) {
      // Nothing more will be claimed: wait for the in-flight work to settle.
      while (running.size > 0 && !signal?.aborted) {
        sweepCancellations();
        await sleep(50, null);
      }
      summary.stoppedBy = signal?.aborted ? "aborted" : once ? "once" : "maxTasks";
      return summary;
    }

    // Keep the loop responsive: re-check cancellations often, not only after
    // a task finishes.
    await sleep(Math.min(pollMs, 1000), signal);
  }

  // Shutting down: abort in-flight work so children do not outlive the worker.
  for (const controller of running.values()) controller.abort();
  await sleep(50, null);
  summary.stoppedBy = "aborted";
  return summary;
}

/**
 * Close the loop on a delegated task: the delegator is told what came back and
 * gets a turn to integrate it. Without this a delegation is fire-and-forget,
 * the delegator never learns the outcome, and the human ends up chasing it.
 */
function deliverDelegationReport(store, finishedTask, { log, summary } = {}) {
  const handoff = finishedTask?.handoff;
  if (!handoff?.from) return;
  const delegator = store.getTeammate(handoff.from);
  if (!delegator) return;
  const delegate = store.teammates.find((entry) => entry.id === finishedTask.teammateId) ?? null;
  const result = finishedTask.result ?? finishedTask.error ?? "(no result recorded)";

  // Always leave a note in the inbox: that is the record of what happened.
  try {
    store.sendMessage({
      from: delegate?.name ?? "teammate",
      to: delegator.name,
      text: `Finished your task ${String(finishedTask.id).slice(0, 8)} (${finishedTask.status}):\n${String(result).slice(0, 2000)}`
    });
  } catch (error) {
    log(`companion: could not report ${finishedTask.id} back to @${delegator.name}: ${error?.message ?? error}`);
  }

  const request = buildIntegrationRequest({
    delegateTask: finishedTask,
    delegateTeammate: delegate ?? { name: "teammate" },
    result,
    depth: handoff.depth ?? 0
  });
  if (request.refused) {
    log(`companion: ${request.reason}`);
    summary.loopsStopped = (summary.loopsStopped ?? 0) + 1;
    return;
  }
  try {
    const followUp = store.enqueue(delegator.name, request.instruction, { runSource: request.runSource });
    summary.reported = (summary.reported ?? 0) + 1;
    log(`companion: queued integration task ${followUp.id.slice(0, 8)} for @${delegator.name}`);
  } catch (error) {
    log(`companion: could not queue an integration task for @${delegator.name}: ${error?.message ?? error}`);
  }
}

/** Queue DELEGATE directives and deliver MESSAGE directives from a reply. */
function applyDirectives(store, reply, fromTeammate, { log, summary, sourceTask = null, result = "", artifacts = null } = {}) {
  const { delegations, messages } = parseDirectives(reply);
  const depth = delegationDepth(sourceTask);
  for (const delegation of delegations) {
    // Auto-routing: the delegating teammate decided *what* needs doing, the
    // worker decides who is best matched. A refusal is explained in the feed
    // rather than silently dropped.
    let target = delegation.to;
    if (!target) {
      const route = routeTeammate(delegation.instruction, store.listTeammates(), { exclude: fromTeammate.name });
      if (!route) {
        // Do not drop the work: give the delegator (which can read the roster
        // in its prompt) a turn to name someone. Language-agnostic, and the
        // decision stays with the model instead of a keyword table.
        log(`companion: no teammate matched "${delegation.instruction.slice(0, 60)}" — asking @${fromTeammate.name} to pick by name`);
        summary.routingMissed = (summary.routingMissed ?? 0) + 1;
        if (depth >= MAX_DELEGATION_DEPTH) {
          log(`companion: routing fallback skipped at depth ${depth} (cap ${MAX_DELEGATION_DEPTH})`);
          summary.loopsStopped = (summary.loopsStopped ?? 0) + 1;
          continue;
        }
        try {
          store.enqueue(fromTeammate.name, [
            `You asked to delegate: "${delegation.instruction}"`,
            "The worker could not match it to anyone automatically.",
            "Look at your team roster and name the teammate explicitly: re-issue it as",
            `  DELEGATE @name: ${delegation.instruction}`,
            "If nobody fits, say so and do it yourself."
          ].join("\n"), { runSource: "routing:retry" });
          summary.routingDeferred = (summary.routingDeferred ?? 0) + 1;
        } catch (error) {
          log(`companion: could not ask @${fromTeammate.name} to name a teammate: ${error?.message ?? error}`);
        }
        continue;
      }
      target = route.teammate.name;
      log(`companion: auto-routed to @${target} — ${route.reason}`);
    }
    try {
      const handoff = buildHandoff({ from: fromTeammate, task: sourceTask, result, artifacts, depth });
      const task = store.enqueue(target, delegation.instruction, {
        runSource: `delegated:${fromTeammate.name}`,
        handoff
      });
      summary.delegated = (summary.delegated ?? 0) + 1;
      log(`companion: @${fromTeammate.name} delegated task ${task.id.slice(0, 8)} to @${target} (depth ${handoff.depth})`);
    } catch (error) {
      log(`companion: delegation to @${target} rejected: ${error?.message ?? error}`);
    }
  }
  for (const message of messages) {
    try {
      store.sendMessage({ from: fromTeammate.name, to: message.to, text: message.text });
    } catch (error) {
      log(`companion: message to @${message.to} rejected: ${error?.message ?? error}`);
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
