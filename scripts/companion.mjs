#!/usr/bin/env node
/**
 * Companion CLI — persistent AI teammates for Equaxis (M0).
 *
 *   companion create <name> [--persona "..."] [--workspace dir] [--model id]
 *   companion list
 *   companion show <name>
 *   companion task <name> "<instruction>"
 *   companion status [--teammate <name>] [--all]
 *   companion feed [n]
 *   companion worker [--once] [--poll 2000]
 *
 * The worker is the runtime: it claims pending tasks FIFO and runs each as
 * a Pi JSON-mode subprocess inside the teammate's workspace, then notifies
 * (local feed always; Telegram / desktop when configured).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { CompanionStore } from "../src/companion-store.mjs";
import { createNotifier } from "../src/companion-notify.mjs";
import { runCompanionWorker, parsePiJsonReply, parsePiUsage } from "../src/companion-runtime.mjs";
import { createPiJsonExecutor } from "../src/subagent-executor.mjs";
import { resolveRuntimeRoot, ownPackageRoot } from "../src/runtime-root.mjs";
import { BACKEND_ORDER, createBackendSpawnWrapper, formatBackendChoice, listBackends, resolveBackend } from "../src/companion-backends.mjs";
import { parseDurationMs } from "../src/duration.mjs";
import { loadModelCatalog, teammateModelArgs } from "../src/model-slots.mjs";
import { loadEquaxisConfigLayers } from "../src/equaxis-config.mjs";
import { applyTemplate, buildTemplate, formatTemplateReport, parseTemplate } from "../src/companion-templates.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findProjectRoot(start) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, ".pi", "equaxis.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

const projectRoot = findProjectRoot(process.cwd());
const runtimeRoot = resolveRuntimeRoot(projectRoot, packageRoot);
const storeRoot = path.join(projectRoot, ".pi", "companion");

function defaultPiEntry() {
  const local = path.join(runtimeRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  if (fs.existsSync(local)) return local;
  const bundled = path.join(runtimeRoot, "pi-versions", "v130", "package", "dist", "cli.js");
  if (fs.existsSync(bundled)) return bundled;
  throw new Error("companion: cannot locate a Pi entry (expected node_modules/@earendil-works/pi-coding-agent/dist/cli.js)");
}

/** The reliability trace dir the approval queue lives under. */
function readTraceDir(root) {
  try {
    const layers = loadEquaxisConfigLayers(root);
    return layers.effective?.reliability?.traceDir ?? ".pi/runtime";
  } catch {
    return ".pi/runtime";
  }
}

function readWebhookCredential(store) {
  const file = store.webhookCredentialFile();
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // first use — issue below
  }
  store.issueWebhookCredential();
  return fs.readFileSync(file, "utf8").trim();
}

function fail(message) {
  console.error(`companion: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function printTeammate(teammate) {
  console.log(`@${teammate.name}${teammate.model ? ` (${teammate.model})` : ""}`);
  if (teammate.persona) console.log(`  persona: ${teammate.persona}`);
  console.log(`  workspace: ${teammate.workspace}`);
  console.log(`  tasks: ${teammate.stats.completed} done, ${teammate.stats.failed} failed`);
  console.log(`  context: ${teammate.sessionId ? `continuous (session ${teammate.sessionId.slice(0, 8)})` : "cold start per task"}`);
  if (teammate.stats.totalCostUsd) console.log(`  spend: $${teammate.stats.totalCostUsd.toFixed(4)} / ${teammate.stats.totalTokens} tokens`);
}

function printTask(task, store) {
  const teammate = store.teammates.find((t) => t.id === task.teammateId);
  const name = teammate ? `@${teammate.name}` : task.teammateId.slice(0, 8);
  const badge = `[${task.status}]`;
  console.log(`${badge} ${name} ${task.id.slice(0, 8)} (attempt ${task.attempts}) — ${task.instruction.slice(0, 80)}${task.instruction.length > 80 ? "…" : ""}`);
  if (task.status === "done" && task.result) {
    console.log(`    result: ${task.result.split("\n").slice(0, 4).join("\n    ").slice(0, 400)}`);
  }
  if (task.error) console.log(`    error: ${task.error.slice(0, 200)}`);
  if (task.usage) console.log(`    usage: ${task.usage.totalTokens} tokens, $${Number(task.usage.costUsd).toFixed(5)}${task.usage.model ? ` (${task.usage.model})` : ""}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  if (!command || command === "help" || command === "--help") {
    console.log(`Companion CLI — persistent AI teammates (Equaxis M0)

  create <name> [--persona "..."] [--workspace dir] [--model id]   create/update a teammate
  list                                                             list teammates
  show <name>                                                      show one teammate
  task <name> "<instruction>"                                      submit a task (queued FIFO)
  message <name> "<text>"                                          send a message to a teammate's inbox
  routine add <name> --every 30m "<instruction>"                   schedule a recurring task
  routine list | routine remove <id>                               manage routines
  export <name>... [--all] [--out file.json]                       write a template (no secrets)
  import <file.json> [--rename new-name] [--overwrite] [--dry-run]  create teammates from a template
  credentials issue <name> [--label "phone"] [--ttl 30d]           mint a scoped credential (shown once)
  credentials rotate <id-prefix> [--ttl 30d]                       revoke + reissue (new value shown once)
  credentials list | credentials revoke <id-prefix>                manage scoped credentials
  status [--teammate <name>] [--all]                               task queue status
  feed [n]                                                         last n feed entries (default 20)
  logs <task-id> [--lines 100]                                     stream log of a task (works while running)
  reset <name>                                                     forget the teammate's conversation (next task starts cold)
  worker [--once] [--poll <ms>] [--concurrency 2] [--context per-teammate|per-task]
         [--sandbox auto|directory|bwrap|container|microvm|off] [--home isolated|shared]
  backends                                                         show execution backends and their availability
                                                                   drain the queue (Ctrl-C to stop)
  serve [--port 7890] [--listen <host>] [--allow-host h:p[,...]] [--no-pwa]
                                                                   webhook ingress + worker + mobile dashboard

State lives in ${path.relative(process.cwd(), storeRoot) || storeRoot}`);
    return;
  }

  const store = CompanionStore.open(storeRoot);
  if (store.recoveredOnOpen.length) {
    console.error(`companion: recovered ${store.recoveredOnOpen.length} task(s) left running by a crashed worker`);
  }

  switch (command) {
    case "create": {
      const name = positional[0];
      if (!name) return fail("create requires <name> (kebab-case)");
      if (flags.model) {
        try {
          teammateModelArgs(String(flags.model));
        } catch (error) {
          return fail(`--model ${flags.model}: ${error.message}`);
        }
      }
      const input = { name, persona: flags.persona, workspace: flags.workspace, model: flags.model };
      const existing = store.getTeammate(name);
      const teammate = existing ? store.updateTeammate(name, input) : store.createTeammate(input);
      console.log(existing ? `updated` : `created`);
      printTeammate(teammate);
      return;
    }
    case "list": {
      const teammates = store.listTeammates();
      if (!teammates.length) return console.log("no teammates yet — companion create <name>");
      for (const teammate of teammates) printTeammate(teammate);
      return;
    }
    case "show": {
      const teammate = store.getTeammate(positional[0] ?? "");
      if (!teammate) return fail(`teammate "${positional[0]}" not found`);
      printTeammate(teammate);
      const tasks = store.listTasks({ teammateId: teammate.id }).slice(-5);
      for (const task of tasks) printTask(task, store);
      return;
    }
    case "task": {
      const [name, ...instructionParts] = positional;
      const instruction = instructionParts.join(" ").trim();
      if (!name || !instruction) return fail('task requires <name> "<instruction>"');
      const task = store.enqueue(name, instruction);
      console.log(`queued ${task.id.slice(0, 8)} for @${name} — run "companion worker" to process (or companion worker --once)`);
      return;
    }
    case "export": {
      const names = flags.all ? null : positional.filter(Boolean);
      if (!flags.all && !names.length) return fail("export requires <name>... or --all");
      try {
        const template = buildTemplate(store.listTeammates(), { names });
        const text = `${JSON.stringify(template, null, 2)}\n`;
        if (flags.out) {
          const target = path.resolve(process.cwd(), String(flags.out));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, text, "utf8");
          console.log(`exported ${template.teammates.length} teammate(s) → ${target}`);
        } else {
          process.stdout.write(text);
        }
      } catch (error) {
        return fail(error.message);
      }
      return;
    }
    case "import": {
      const file = positional[0];
      if (!file) return fail("import requires <file.json>");
      let text;
      try {
        text = fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
      } catch (error) {
        return fail(`cannot read ${file}: ${error.message}`);
      }
      try {
        const parsed = parseTemplate(text);
        const report = applyTemplate(store, parsed, {
          rename: typeof flags.rename === "string" ? flags.rename : null,
          overwrite: flags.overwrite === true,
          dryRun: flags["dry-run"] === true
        });
        console.log(formatTemplateReport(report));
      } catch (error) {
        return fail(error.message);
      }
      return;
    }
    case "credentials": {
      const sub = positional[0];
      if (sub === "issue") {
        const name = positional[1];
        if (!name) return fail('credentials issue requires <name> [--label "..."]');
        try {
          const ttlMs = flags.ttl ? parseDurationMs(String(flags.ttl)) : null;
          if (flags.ttl && !Number.isFinite(ttlMs)) return fail(`cannot parse --ttl "${flags.ttl}" (use 30d, 12h, 90m)`);
          const { credential, mint } = store.issueTeammateCredential(name, { label: flags.label ?? "", ttlMs });
          console.log(`credential ${credential.id.slice(0, 8)} for @${name}${credential.label ? ` (${credential.label})` : ""}${credential.expiresAt ? ` — expires ${credential.expiresAt.slice(0, 10)}` : ""}`);
          console.log(`  bearer: ${mint}`);
          console.log("  shown once — store it now; it may only queue tasks for this teammate");
        } catch (error) {
          return fail(error.message);
        }
        return;
      }
      if (sub === "list" || !sub) {
        const credentials = store.listCredentials();
        if (!credentials.length) return console.log("no scoped credentials — companion credentials issue <name>");
        const day = 24 * 3600 * 1000;
        for (const entry of credentials) {
          const expiry = entry.expiresAt
            ? (() => {
                const left = Date.parse(entry.expiresAt) - Date.now();
                if (left <= 0) return `EXPIRED ${entry.expiresAt.slice(0, 10)}`;
                const days = Math.ceil(left / day);
                return days <= 7 ? `expires in ${days}d` : `expires ${entry.expiresAt.slice(0, 10)}`;
              })()
            : "no expiry";
          const state = entry.revokedAt
            ? `revoked ${entry.revokedAt.slice(0, 10)}`
            : entry.lastUsedAt
              ? `last used ${entry.lastUsedAt.slice(0, 10)}`
              : "never used";
          const rotated = entry.rotatedFromId ? ` rotated from ${entry.rotatedFromId.slice(0, 8)}` : "";
          console.log(`${entry.id.slice(0, 8)} @${entry.teammate.padEnd(12)} [${state}] ${expiry}${rotated}${entry.label ? ` ${entry.label}` : ""}`);
        }
        const expiring = store.expiringCredentials();
        if (expiring.length) {
          console.log(`\n${expiring.length} credential(s) expired or expiring within 7 days — rotate with: companion credentials rotate <id-prefix>`);
        }
        return;
      }
      if (sub === "rotate") {
        const id = positional[1];
        if (!id) return fail("credentials rotate requires <id-prefix>");
        const ttlMs = flags.ttl ? parseDurationMs(String(flags.ttl)) : null;
        if (flags.ttl && !Number.isFinite(ttlMs)) return fail(`cannot parse --ttl "${flags.ttl}"`);
        try {
          const { credential, mint, previous } = store.rotateCredential(id, { ttlMs });
          console.log(`rotated ${previous.id.slice(0, 8)} → ${credential.id.slice(0, 8)} (@${credential.teammate})`);
          console.log(`  bearer: ${mint}`);
          console.log("  shown once — the previous value is already revoked");
        } catch (error) {
          return fail(error.message);
        }
        return;
      }
      if (sub === "revoke") {
        const id = positional[1];
        if (!id) return fail("credentials revoke requires <id-prefix>");
        try {
          const record = store.revokeCredential(id);
          console.log(`revoked ${record.id.slice(0, 8)} (@${record.teammate})`);
        } catch (error) {
          return fail(error.message);
        }
        return;
      }
      return fail("credentials requires issue | list | revoke");
    }
    case "status": {
      const teammate = flags.teammate ? store.getTeammate(flags.teammate) : null;
      if (flags.teammate && !teammate) return fail(`teammate "${flags.teammate}" not found`);
      const tasks = store.listTasks(teammate ? { teammateId: teammate.id } : {});
      const visible = flags.all ? tasks : tasks.filter((t) => t.status !== "done" || Date.parse(t.finishedAt ?? "") > Date.now() - 24 * 3600 * 1000);
      const counts = {};
      for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
      console.log(`queue: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "empty"}`);
      const spend = store.listTeammates().reduce((sum, t) => sum + (t.stats.totalCostUsd ?? 0), 0);
      if (spend > 0) console.log(`spend: $${spend.toFixed(4)} total — ${store.listTeammates().filter((t) => t.stats.totalCostUsd).map((t) => `@${t.name} $${t.stats.totalCostUsd.toFixed(4)}`).join(", ")}`);
      for (const task of visible.slice(-20)) printTask(task, store);
      return;
    }
    case "reset": {
      const name = positional[0];
      if (!name) return fail("reset requires <name>");
      try {
        const previous = store.resetTeammateSession(name);
        console.log(previous
          ? `@${name}: conversation cleared (was ${previous.slice(0, 8)}) — the next task starts cold`
          : `@${name}: no conversation to clear`);
      } catch (error) {
        return fail(error.message);
      }
      return;
    }
    case "logs": {
      const taskId = positional[0];
      if (!taskId) return fail("logs requires <task-id>");
      const task = store.getTask(taskId) ?? store.listTasks({}).find((t) => t.id.startsWith(taskId));
      if (!task) return fail(`no task matches "${taskId}"`);
      const tail = store.readTaskLog(task.id, { lines: Number(flags.lines ?? 100) });
      if (!tail.exists) return console.log(`no log for ${task.id.slice(0, 8)} (${task.status})`);
      if (tail.truncated) console.log(`… (showing the last ${tail.lines.length} lines)`);
      console.log(tail.lines.join("\n"));
      return;
    }
    case "feed": {
      const limit = Number(positional[0] ?? 20);
      const entries = store.readFeed(Number.isFinite(limit) && limit > 0 ? limit : 20);
      if (!entries.length) return console.log("feed is empty");
      for (const entry of entries.reverse()) {
        console.log(`${entry.at} ${entry.kind} ${entry.teammate ? `@${entry.teammate}` : ""}`);
        console.log(`  ${String(entry.text ?? "").split("\n").slice(0, 3).join("\n  ").slice(0, 400)}`);
      }
      return;
    }
    case "message": {
      const [name, ...textParts] = positional;
      const text = textParts.join(" ").trim();
      if (!name || !text) return fail('message requires <name> "<text>"');
      try {
        store.sendMessage({ from: "human", to: name, text });
        console.log(`message delivered to @${name} (read on their next task)`);
      } catch (error) {
        return fail(error.message);
      }
      return;
    }
    case "routine": {
      const sub = positional[0];
      const name = positional[1];
      const instruction = positional.slice(2).join(" ").trim();
      if (sub === "add") {
        if (!name || !instruction || !flags.every) return fail('routine add requires <name> --every <30m|2h|1d> "<instruction>"');
        const everyMs = parseDurationMs(String(flags.every));
        if (!Number.isFinite(everyMs)) return fail(`cannot parse interval "${flags.every}" (use 30m, 2h, 1d, or milliseconds)`);
        try {
          const routine = store.addRoutine({ teammate: name, instruction, everyMs });
          console.log(`routine ${routine.id.slice(0, 8)} scheduled for @${name} every ${flags.every}`);
        } catch (error) {
          return fail(error.message);
        }
        return;
      }
      if (sub === "list" || !sub) {
        const routines = store.listRoutines();
        if (!routines.length) return console.log("no routines");
        for (const routine of routines) {
          const next = routine.lastRunAt
            ? new Date(Date.parse(routine.lastRunAt) + routine.everyMs).toISOString()
            : "due now";
          console.log(`${routine.id.slice(0, 8)} @${routine.teammate} every ${Math.round(routine.everyMs / 60000)}m [${routine.enabled ? "on" : "off"}] next: ${next} — ${routine.instruction.slice(0, 60)}`);
        }
        return;
      }
      if (sub === "remove") {
        try {
          const removed = store.removeRoutine(positional[1] ?? "");
          console.log(`removed routine ${removed.id.slice(0, 8)}`);
        } catch (error) {
          return fail(error.message);
        }
        return;
      }
      return fail("routine requires add | list | remove");
    }
    case "backends": {
      const microvmConfig = {
        kernel: typeof flags["microvm-kernel"] === "string" ? path.resolve(String(flags["microvm-kernel"])) : null,
        rootfs: typeof flags["microvm-rootfs"] === "string" ? path.resolve(String(flags["microvm-rootfs"])) : null
      };
      const entries = await listBackends({ microvm: microvmConfig });
      let chosen = null;
      try {
        chosen = await resolveBackend("auto", {
          ceiling: String(flags["sandbox-ceiling"] ?? "bwrap"),
          microvm: microvmConfig
        });
      } catch {
        chosen = null;
      }
      for (const entry of entries) {
        const mark = entry.available ? "\u2713" : "\u2717";
        const current = chosen && chosen.backend.id === entry.id ? "  ← auto picks this" : "";
        console.log(`${mark} ${entry.id.padEnd(10)} ${entry.label.padEnd(22)} isolation: ${entry.isolation}`);
        console.log(`  ${entry.detail}${current}`);
      }
      return;
    }
    case "worker":
    case "serve": {
      const isServe = command === "serve";
      const piEntry = defaultPiEntry();
      // Sandbox: auto = bwrap when available. With the sandbox on, the
      // default HOME model is "isolated": each teammate gets a private HOME
      // (sessions/settings) with only credential files re-bound read-only.
      const sandboxMode = String(flags.sandbox ?? "auto");
      if (!["auto", "off", ...BACKEND_ORDER].includes(sandboxMode)) {
        return fail(`--sandbox must be auto, off, or one of ${BACKEND_ORDER.join(", ")} (got "${sandboxMode}")`);
      }
      let sandboxed = false;
      let backendId = "directory";
      // microVM prerequisites come from flags; detection stays honest about
      // which one is missing instead of "available then failing at task time".
      const microvmConfig = {
        kernel: typeof flags["microvm-kernel"] === "string" ? path.resolve(String(flags["microvm-kernel"])) : null,
        rootfs: typeof flags["microvm-rootfs"] === "string" ? path.resolve(String(flags["microvm-rootfs"])) : null,
        runtime: typeof flags["microvm-runtime"] === "string" ? String(flags["microvm-runtime"]) : undefined,
        memoryMb: flags["microvm-memory"] ? Number(flags["microvm-memory"]) : undefined,
        cpus: flags["microvm-cpus"] ? Number(flags["microvm-cpus"]) : undefined,
        virtiofsSocket: typeof flags["microvm-virtiofs-socket"] === "string" ? String(flags["microvm-virtiofs-socket"]) : null
      };
      if (sandboxMode !== "off") {
        // auto = strongest tier at or below bwrap; an explicit request that is
        // unavailable is an error, never a silent downgrade.
        let choice;
        try {
          choice = await resolveBackend(sandboxMode === "auto" ? "auto" : sandboxMode, {
            ceiling: String(flags["sandbox-ceiling"] ?? "bwrap"),
            microvm: microvmConfig
          });
        } catch (error) {
          return fail(`--sandbox ${sandboxMode}: ${error.message}`);
        }
        sandboxed = choice.backend.id !== "directory";
        backendId = choice.backend.id;
        console.error(`companion: sandbox ${formatBackendChoice(choice)}`);
      } else {
        console.error("companion: sandbox off (plain subprocesses)");
      }
      const contextMode = String(flags.context ?? "per-teammate");
      if (!["per-teammate", "per-task"].includes(contextMode)) {
        return fail(`--context must be per-teammate or per-task (got "${contextMode}")`);
      }
      if (contextMode === "per-teammate" && !sandboxed) {
        console.error("companion: warning — per-teammate context with --sandbox off reuses the real HOME, so sessions are shared with your own");
      }
      const homeModel = String(flags.home ?? (sandboxed ? "isolated" : "shared"));
      if (!sandboxed && homeModel === "isolated") {
        return fail("--home isolated requires a sandbox backend (bwrap or container)");
      }
      if (sandboxed) console.error(`companion: HOME model: ${homeModel}`);
      // One executor per teammate: createPiJsonExecutor pins its cwd at
      // construction, and each teammate works in its own workspace.
      const executors = new Map();
      // A teammate runs one task at a time (its workspace and HOME are shared
      // state), so the current task id is keyed by teammate, not by slot.
      const currentTaskByTeammate = new Map();
      function executorFor(teammate, workspacePath) {
        let executor = executors.get(teammate.id);
        if (!executor) {
          const homePath = homeModel === "isolated" ? store.teammateHome(teammate, projectRoot) : null;
          // Pi creates <HOME>/.pi/agent/sessions/<slug> with a non-recursive
          // mkdir, so the parent chain must exist before the first run.
          if (homePath) fs.mkdirSync(path.join(homePath, ".pi", "agent", "sessions"), { recursive: true });
          // The teammate's model is a real setting, not a prompt hint: it has
          // to reach the subprocess or "model: sonnet" silently means nothing.
          const modelArgs = teammateModelArgs(teammate.model).args;
          // Continuity: a stable --session-id means the teammate resumes its
          // own conversation instead of starting cold on every task. The id
          // lives in its private HOME, so teammates never share a thread.
          const sessionArgs = contextMode === "per-teammate"
            ? ["--session-id", store.ensureTeammateSession(teammate.name)]
            : [];
          // Live per-task log: the JSON-mode stream is appended as it arrives,
          // so `companion logs <id>` and the dashboard can show a running task.
          const onOutput = (chunk) => {
            const logTaskId = currentTaskByTeammate.get(teammate.id);
            if (!logTaskId) return;
            try {
              const file = store.taskLogFile(logTaskId);
              fs.mkdirSync(path.dirname(file), { recursive: true });
              fs.appendFileSync(file, chunk);
            } catch {
              // logging must never break a run
            }
          };
          executor = createPiJsonExecutor({
            piEntry,
            projectRoot,
            cwd: workspacePath,
            args: [...modelArgs, ...sessionArgs],
            onOutput,
            isolation: { enabled: true },
            ...(homePath ? { env: { HOME: homePath } } : {}),
            ...(sandboxed
              ? {
                  spawnImpl: createBackendSpawnWrapper({
                    backend: backendId,
                    workspace: workspacePath,
                    projectRoot,
                    homeDir: homePath,
                    image: String(flags.image ?? "docker.io/library/node:22-slim"),
                    microvm: microvmConfig,
                    spawnImpl: spawn
                  })
                }
              : {})
          });
          executors.set(teammate.id, executor);
        }
        return executor;
      }
      const notify = createNotifier({ store, fetchImpl: fetch, env: process.env, logger: (...args) => console.error(...args) });

      let webhook = null;
      if (isServe) {
        const { startCompanionWebhook } = await import("../src/companion-webhook.mjs");
        const listenHost = String(flags.listen ?? "127.0.0.1");
        const listenPort = Number(flags.port ?? 7890);
        const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(listenHost);
        // Host allowlist: loopback always; when binding a LAN interface,
        // also accept the machine's own addresses (Host headers the phone
        // will send) plus caller-declared names (mDNS etc). An attacker
        // rebinding their domain to this machine still sends their own
        // hostname in Host/Origin — outside the allowlist — so DNS
        // rebinding stays blocked.
        const extraHosts = new Set();
        if (!isLoopback) {
          extraHosts.add(`${listenHost}:${listenPort}`);
          for (const addrs of Object.values(os.networkInterfaces())) {
            for (const addr of addrs ?? []) {
              if (!addr.internal && addr.family === "IPv4") extraHosts.add(`${addr.address}:${listenPort}`);
            }
          }
        }
        for (const declared of String(flags["allow-host"] ?? "").split(",")) {
          const value = declared.trim().toLowerCase();
          if (value) {
            if (!value.includes(":")) return fail(`--allow-host expects host:port (got "${declared}")`);
            extraHosts.add(value);
          }
        }
        if (!isLoopback) {
          console.error(`companion: WARNING listening on ${listenHost} — every route still requires the bearer credential; expose only on trusted networks`);
        }
        webhook = await startCompanionWebhook({
          store,
          projectRoot,
          traceDir: readTraceDir(projectRoot),
          credential: readWebhookCredential(store),
          port: listenPort,
          host: listenHost,
          extraHosts: [...extraHosts],
          servePwa: flags["no-pwa"] !== true,
          logger: (...args) => console.error(...args)
        });
        console.error(`companion: webhook listening on http://${webhook.host}:${webhook.port}${isLoopback ? "" : ` (dashboard: http://<lan-ip>:${webhook.port}/)`} (credential: ${path.relative(projectRoot, store.webhookCredentialFile())})`);
      }

      process.on("SIGINT", () => {
        console.error("\ncompanion: worker stopping…");
        process.exit(0);
      });
      const summary = await runCompanionWorker({
        store,
        concurrency: Number(flags.concurrency ?? 2),
        onTaskStart: ({ task }) => currentTaskByTeammate.set(task.teammateId, task.id),
        onTaskEnd: ({ task }) => {
          if (currentTaskByTeammate.get(task.teammateId) === task.id) currentTaskByTeammate.delete(task.teammateId);
        },
        executor: async (task, ctx) => {
          // The executor resolves the transport wrapper { ok, id, output };
          // output is a Pi JSON-mode JSONL stream. Unwrap and extract the
          // final assistant reply before the runtime stores it as the result.
          const wrapper = await executorFor(ctx.teammate, ctx.workspacePath)({ id: task.id, prompt: ctx.prompt, attempt: task.attempts });
          const stream = wrapper?.output ?? "";
          // Provider-reported tokens/cost, recorded even when the reply is
          // empty (the spend happened regardless of the outcome).
          store.recordUsage(task.id, parsePiUsage(stream));
          return parsePiJsonReply(stream);
        },
        notify,
        once: !isServe && flags.once === true,
        pollMs: Number(flags.poll ?? 2000),
        logger: (...args) => console.error(...args),
        projectRoot
      });
      if (webhook) await webhook.close();
      console.log(`companion: worker stopped (${summary.stoppedBy}): ${summary.completed} done, ${summary.failed} failed, ${summary.delegated} delegated`);
      return;
    }
    default:
      return fail(`unknown command "${command}" — try "companion help"`);
  }
}

main().catch((error) => {
  fail(error?.stack ?? String(error));
});
