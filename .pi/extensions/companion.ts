import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CompanionStore } from "../../src/companion-store.mjs";
import { parsePiUsage } from "../../src/companion-runtime.mjs";
import { parseDurationMs } from "../../src/duration.mjs";
import { applyTemplate, buildTemplate, formatTemplateReport, parseTemplate } from "../../src/companion-templates.mjs";
import { listBackends } from "../../src/companion-backends.mjs";
import { listPendingApprovals, writeApprovalDecision } from "../../src/approval-queue.mjs";
import { artifactDiff, readManifest } from "../../src/companion-artifacts.mjs";
import { loadEquaxisConfigLayers } from "../../src/equaxis-config.mjs";

/**
 * Companion extension — persistent AI teammates inside an Equaxis session.
 *
 * M0 scope: the session is a *client* of the companion data plane. Tools
 * create teammates, submit tasks and inspect status; the actual teammate
 * turns run in the headless worker (`node scripts/companion.mjs worker`),
 * each as an isolated Pi subprocess in the teammate's own workspace.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function findProjectRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, ".pi", "equaxis.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function openStore(cwd: string): CompanionStore {
  return CompanionStore.open(path.join(findProjectRoot(cwd), ".pi", "companion"));
}

interface TeammateSummary {
  name: string;
  persona: string;
  workspace: string;
  model: string | null;
  stats: { completed: number; failed: number };
}

function summarize(teammate: {
  name: string;
  persona: string;
  workspace: string;
  model: string | null;
  stats: { completed: number; failed: number };
}): TeammateSummary {
  return {
    name: teammate.name,
    persona: teammate.persona,
    workspace: teammate.workspace,
    model: teammate.model,
    stats: teammate.stats
  };
}

/** Stable detail shapes: the tool contract requires one shape per tool. */
function credDetails(patch: Partial<{ ok: boolean; credentialId: string | null; expiresAt: string | null; credentials: number; expiring: number }>) {
  return { ok: false, credentialId: null, expiresAt: null, credentials: 0, expiring: 0, ...patch };
}

function approvalDetails(patch: Partial<{ ok: boolean; requestId: string | null; pending: number }>) {
  return { ok: false, requestId: null, pending: 0, ...patch };
}

export default function companionExtension(pi: ExtensionAPI): void {
  function notify(ctx: ExtensionContext, text: string): void {
    ctx.ui.notify(text, "info");
  }

  pi.registerTool({
    name: "companion_create_teammate",
    label: "Create Teammate",
    description: "Create or update a persistent AI teammate with its own persona, workspace and optional model. Teammates outlive this session.",
    promptSnippet: "Create an AI teammate",
    promptGuidelines: [
      "Use companion_create_teammate to define a named teammate with a clear persona; the name is kebab-case.",
      "Teammates execute tasks through the companion worker, not inside this session."
    ],
    parameters: Type.Object({
      name: Type.String({ minLength: 1, description: "Kebab-case teammate name" }),
      persona: Type.Optional(Type.String({ description: "Who this teammate is and how it should work" })),
      workspace: Type.Optional(Type.String({ description: "Workspace directory name (project-relative, default: the teammate name)" })),
      model: Type.Optional(Type.String({ description: "Optional model id the worker should use" }))
    }),
    async execute(_toolCallId, params) {
      const store = openStore(process.cwd());
      const existing = store.getTeammate(params.name);
      const teammate = existing
        ? store.updateTeammate(params.name, params)
        : store.createTeammate(params);
      return {
        content: [{ type: "text", text: existing ? `Updated teammate @${teammate.name}.` : `Created teammate @${teammate.name} with workspace "${teammate.workspace}".` }],
        details: { created: !existing, teammate: summarize(teammate) }
      };
    }
  });

  pi.registerTool({
    name: "companion_list_teammates",
    label: "List Teammates",
    description: "List the persistent AI teammates with their task stats.",
    promptSnippet: "List AI teammates",
    parameters: Type.Object({}),
    async execute() {
      const store = openStore(process.cwd());
      const teammates = store.listTeammates();
      if (!teammates.length) {
        return { content: [{ type: "text", text: "No teammates yet. Create one with companion_create_teammate." }], details: { teammates: [] } };
      }
      const lines = teammates.map((t) => `@${t.name}${t.model ? ` (${t.model})` : ""} — ${t.stats.completed} done, ${t.stats.failed} failed${t.persona ? ` — ${t.persona.slice(0, 100)}` : ""}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { teammates: teammates.map(summarize) }
      };
    }
  });

  pi.registerTool({
    name: "companion_submit_task",
    label: "Submit Teammate Task",
    description: "Queue a task for a teammate. The companion worker picks it up FIFO and runs it in the teammate's workspace; the result lands in the notification feed.",
    promptSnippet: "Queue a task for a teammate",
    parameters: Type.Object({
      teammate: Type.String({ minLength: 1, description: "Teammate name" }),
      instruction: Type.String({ minLength: 1, description: "What the teammate should do (one task)" })
    }),
    async execute(_toolCallId, params) {
      const store = openStore(process.cwd());
      let task;
      try {
        task = store.enqueue(params.teammate, params.instruction);
      } catch (error) {
        return { content: [{ type: "text", text: String((error as Error).message) }], details: { queued: false, taskId: null, teammate: params.teammate } };
      }
      return {
        content: [{ type: "text", text: `Queued task ${task.id.slice(0, 8)} for @${params.teammate}. It runs when the companion worker is active (node scripts/companion.mjs worker).` }],
        details: { queued: true, taskId: task.id, teammate: params.teammate }
      };
    }
  });

  pi.registerTool({
    name: "companion_send_message",
    label: "Send Teammate Message",
    description: "Leave a message in a teammate's inbox. The teammate reads unread messages at the start of their next task.",
    promptSnippet: "Message a teammate",
    parameters: Type.Object({
      teammate: Type.String({ minLength: 1, description: "Teammate name" }),
      text: Type.String({ minLength: 1, description: "Message body" })
    }),
    async execute(_toolCallId, params) {
      const store = openStore(process.cwd());
      try {
        store.sendMessage({ from: "human", to: params.teammate, text: params.text });
      } catch (error) {
        return { content: [{ type: "text", text: String((error as Error).message) }], details: { delivered: false, teammate: params.teammate } };
      }
      return {
        content: [{ type: "text", text: `Message delivered to @${params.teammate}; it will be read on their next task.` }],
        details: { delivered: true, teammate: params.teammate }
      };
    }
  });

  pi.registerTool({
    name: "companion_task_status",
    label: "Companion Task Status",
    description: "Show the companion task queue: pending, running, and recent finished tasks with results.",
    promptSnippet: "Check teammate task status",
    parameters: Type.Object({
      teammate: Type.Optional(Type.String({ description: "Filter by teammate name" }))
    }),
    async execute(_toolCallId, params) {
      const store = openStore(process.cwd());
      const teammate = params.teammate ? store.getTeammate(params.teammate) : null;
      if (params.teammate && !teammate) {
        return { content: [{ type: "text", text: `Teammate "${params.teammate}" not found.` }], details: { found: false, active: [], recent: [] } };
      }
      const tasks = store.listTasks(teammate ? { teammateId: teammate.id } : {});
      const active = tasks.filter((t) => t.status === "pending" || t.status === "running");
      const recent = tasks.filter((t) => t.status === "done" || t.status === "failed").slice(-5);
      const lines: string[] = [];
      if (active.length) {
        lines.push(`Active (${active.length}):`);
        for (const task of active) lines.push(`  [${task.status}] ${task.id.slice(0, 8)} — ${task.instruction.slice(0, 80)}`);
      } else {
        lines.push("Queue is empty.");
      }
      if (recent.length) {
        lines.push("Recent:");
        for (const task of recent) lines.push(`  [${task.status}] ${task.id.slice(0, 8)} — ${String(task.result ?? task.error ?? "").slice(0, 120)}`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          found: true,
          active: active.map((t) => ({ id: t.id, status: t.status })),
          recent: recent.map((t) => ({ id: t.id, status: t.status }))
        }
      };
    }
  });

  pi.registerTool({
    name: "companion_logs",
    label: "Teammate Task Log",
    description: "Tail the stream log of a companion task (works while it is running). Shows the JSON-mode events the teammate produced.",
    promptSnippet: "Read a companion task log",
    promptGuidelines: ["Use companion_logs when a queued task looks stuck or failed; the log holds the subprocess stream, not just the final reply."],
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1, description: "Task id or unambiguous prefix" }),
      lines: Type.Optional(Type.Number({ description: "How many trailing lines (default 80)" }))
    }),
    async execute(_toolCallId, params) {
      const store = openStore(process.cwd());
      const task = store.getTask(params.taskId) ?? store.listTasks({}).find((entry) => entry.id.startsWith(params.taskId));
      if (!task) return { content: [{ type: "text", text: `No task matches "${params.taskId}".` }], details: { found: false } };
      const tail = store.readTaskLog(task.id, { lines: params.lines ?? 80 });
      if (!tail.exists) return { content: [{ type: "text", text: `No log for ${task.id.slice(0, 8)} (status: ${task.status}).` }], details: { found: false, taskId: task.id } };
      return {
        content: [{ type: "text", text: `${task.id.slice(0, 8)} (${task.status})
${tail.lines.join("\n")}` }],
        details: { found: true, taskId: task.id, truncated: tail.truncated }
      };
    }
  });

  pi.registerTool({
    name: "companion_artifacts",
    label: "Task Artifacts",
    description: "List the files a companion task changed in its workspace, and optionally show the diff of one of them.",
    promptSnippet: "Inspect what a task changed",
    promptGuidelines: ["Use companion_artifacts to see the deliverable of a task instead of trusting its summary."],
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1, description: "Task id or prefix" }),
      path: Type.Optional(Type.String({ description: "Show the diff for this changed file" }))
    }),
    async execute(_toolCallId, params) {
      const store = openStore(process.cwd());
      const task = store.getTask(params.taskId) ?? store.listTasks({}).find((entry) => entry.id.startsWith(params.taskId));
      if (!task) return { content: [{ type: "text", text: `No task matches "${params.taskId}".` }], details: { found: false } };
      const manifest = readManifest(store.rootDir, task.id);
      if (!manifest) return { content: [{ type: "text", text: `Task ${task.id.slice(0, 8)} has no artifact manifest (it may predate artifact capture).` }], details: { found: false, taskId: task.id } };

      if (params.path) {
        const teammate = store.teammates.find((entry) => entry.id === task.teammateId);
        const workspace = teammate ? store.teammateDirectory(teammate, process.cwd()) : manifest.workspace;
        const diff = artifactDiff({ rootDir: store.rootDir, taskId: task.id, workspace, relPath: params.path });
        if (!diff.ok) return { content: [{ type: "text", text: `Cannot diff ${params.path}: ${diff.error}` }], details: { found: false, taskId: task.id } };
        const text = (diff.hunks ?? []).map((hunk) => `${hunk.type === "added" ? "+" : hunk.type === "removed" ? "-" : " "} ${hunk.text}`).join("\n");
        return { content: [{ type: "text", text: `${diff.mode}: ${params.path}\n${text}` }], details: { found: true, taskId: task.id, mode: diff.mode } };
      }

      const line = (kind: string, entry: { path: string; size: number }) => `  ${kind.padEnd(8)} ${entry.path} (${entry.size}B)`;
      const body = [
        `${manifest.counts.added} added, ${manifest.counts.modified} modified, ${manifest.counts.deleted} deleted`,
        ...manifest.added.map((entry: { path: string; size: number }) => line("added", entry)),
        ...manifest.modified.map((entry: { path: string; size: number }) => line("modified", entry)),
        ...manifest.deleted.map((entry: { path: string; size: number }) => line("deleted", entry))
      ].join("\n");
      return { content: [{ type: "text", text: body }], details: { found: true, taskId: task.id, counts: manifest.counts } };
    }
  });

  pi.registerTool({
    name: "companion_routines",
    label: "Teammate Routines",
    description: "Manage scheduled teammate tasks: action=list, add (teammate + every + instruction), remove (routine id).",
    promptSnippet: "Schedule a recurring teammate task",
    parameters: Type.Object({
      action: Type.String({ description: "list | add | remove" }),
      teammate: Type.Optional(Type.String({ description: "Teammate name (for add)" })),
      every: Type.Optional(Type.String({ description: "Interval such as 30m, 2h, 1d (for add)" })),
      instruction: Type.Optional(Type.String({ description: "What to run each time (for add)" })),
      routineId: Type.Optional(Type.String({ description: "Routine id or prefix (for remove)" }))
    }),
    async execute(_toolCallId, params) {
      const store = openStore(process.cwd());
      const action = String(params.action ?? "list").toLowerCase();
      try {
        if (action === "add") {
          if (!params.teammate || !params.instruction || !params.every) {
            return { content: [{ type: "text", text: "add requires teammate, every and instruction." }], details: { ok: false } };
          }
          const everyMs = parseDurationMs(String(params.every));
          if (!Number.isFinite(everyMs)) return { content: [{ type: "text", text: `Cannot parse interval "${params.every}" (use 30m, 2h, 1d).` }], details: { ok: false } };
          const routine = store.addRoutine({ teammate: params.teammate, instruction: params.instruction, everyMs });
          return { content: [{ type: "text", text: `Routine ${routine.id.slice(0, 8)} for @${routine.teammate} every ${params.every}.` }], details: { ok: true, routineId: routine.id } };
        }
        if (action === "remove") {
          const removed = store.removeRoutine(String(params.routineId ?? ""));
          return { content: [{ type: "text", text: `Removed routine ${removed.id.slice(0, 8)}.` }], details: { ok: true, routineId: removed.id } };
        }
        const routines = store.listRoutines();
        if (!routines.length) return { content: [{ type: "text", text: "No routines." }], details: { ok: true, routines: [] } };
        const text = routines
          .map((routine) => {
            const next = routine.lastRunAt ? new Date(Date.parse(routine.lastRunAt) + routine.everyMs).toISOString() : "due now";
            return `${routine.id.slice(0, 8)} @${routine.teammate} every ${Math.round(routine.everyMs / 60000)}m next: ${next} — ${routine.instruction.slice(0, 60)}`;
          })
          .join("\n");
        return { content: [{ type: "text", text }], details: { ok: true, routines: routines.length } };
      } catch (error) {
        return { content: [{ type: "text", text: `companion_routines: ${(error as Error).message}` }], details: { ok: false } };
      }
    }
  });

  pi.registerTool({
    name: "companion_credentials",
    label: "Teammate Credentials",
    description: "Manage scoped teammate credentials: action=list, issue (teammate, optional ttl/label), rotate (id, optional ttl), revoke (id).",
    promptSnippet: "Issue or rotate a scoped teammate credential",
    promptGuidelines: ["A scoped credential may only queue tasks for its own teammate; the value is shown once."],
    parameters: Type.Object({
      action: Type.String({ description: "list | issue | rotate | revoke" }),
      teammate: Type.Optional(Type.String({ description: "Teammate name (for issue)" })),
      credentialId: Type.Optional(Type.String({ description: "Credential id or prefix (rotate/revoke)" })),
      ttl: Type.Optional(Type.String({ description: "Optional lifetime such as 30d (issue/rotate)" })),
      label: Type.Optional(Type.String({ description: "Optional label (issue)" }))
    }),
    async execute(_toolCallId, params) {
      const store = openStore(process.cwd());
      const action = String(params.action ?? "list").toLowerCase();
      const ttlMs = params.ttl ? parseDurationMs(String(params.ttl)) : null;
      if (params.ttl && !Number.isFinite(ttlMs)) return { content: [{ type: "text", text: `Cannot parse ttl "${params.ttl}".` }], details: credDetails({ ok: false }) };
      try {
        if (action === "issue") {
          if (!params.teammate) return { content: [{ type: "text", text: "issue requires a teammate." }], details: credDetails({ ok: false }) };
          const { credential, mint } = store.issueTeammateCredential(params.teammate, { label: params.label ?? "", ttlMs });
          return {
            content: [{ type: "text", text: `Credential ${credential.id.slice(0, 8)} for @${credential.teammate}.\nThis value is shown once:\n${mint}` }],
            details: credDetails({ ok: true, credentialId: credential.id, expiresAt: credential.expiresAt ?? null })
          };
        }
        if (action === "rotate") {
          const result = store.rotateCredential(String(params.credentialId ?? ""), { ttlMs });
          return {
            content: [{ type: "text", text: `Rotated ${result.previous.id.slice(0, 8)} → ${result.credential.id.slice(0, 8)} (@${result.credential.teammate}).\nNew value (shown once):\n${result.mint}` }],
            details: credDetails({ ok: true, credentialId: result.credential.id })
          };
        }
        if (action === "revoke") {
          const record = store.revokeCredential(String(params.credentialId ?? ""));
          return { content: [{ type: "text", text: `Revoked ${record.id.slice(0, 8)} (@${record.teammate}).` }], details: credDetails({ ok: true, credentialId: record.id }) };
        }
        const credentials = store.listCredentials();
        if (!credentials.length) return { content: [{ type: "text", text: "No scoped credentials." }], details: credDetails({ ok: true }) };
        const text = credentials
          .map((entry) => `${entry.id.slice(0, 8)} @${entry.teammate}${entry.label ? ` (${entry.label})` : ""} ${entry.revokedAt ? `revoked ${entry.revokedAt.slice(0, 10)}` : entry.expiresAt ? `expires ${entry.expiresAt.slice(0, 10)}` : "no expiry"}`)
          .join("\n");
        const expiring = store.expiringCredentials();
        return {
          content: [{ type: "text", text: expiring.length ? `${text}\n\n${expiring.length} expired or expiring within 7 days.` : text }],
          details: credDetails({ ok: true, credentials: credentials.length, expiring: expiring.length })
        };
      } catch (error) {
        return { content: [{ type: "text", text: `companion_credentials: ${(error as Error).message}` }], details: credDetails({ ok: false }) };
      }
    }
  });

  pi.registerTool({
    name: "companion_approvals",
    label: "Teammate Approvals",
    description: "Inspect or decide the high-risk actions a headless teammate is waiting on: action=list | approve | deny.",
    promptSnippet: "Approve or deny a teammate's high-risk action",
    promptGuidelines: [
      "A headless teammate cannot confirm high-risk tool calls; they park here until a human decides or the window expires.",
      "Read the reason and summary before approving — this is the human gate, not a formality."
    ],
    parameters: Type.Object({
      action: Type.String({ description: "list | approve | deny" }),
      requestId: Type.Optional(Type.String({ description: "Approval request id (approve/deny)" }))
    }),
    async execute(_toolCallId, params) {
      const root = findProjectRoot(process.cwd());
      let traceDir = ".pi/runtime";
      try {
        traceDir = loadEquaxisConfigLayers(root).effective?.reliability?.traceDir ?? traceDir;
      } catch {
        // keep the default
      }
      const action = String(params.action ?? "list").toLowerCase();
      if (action === "approve" || action === "deny") {
        if (!params.requestId) return { content: [{ type: "text", text: `${action} requires requestId.` }], details: approvalDetails({ ok: false }) };
        writeApprovalDecision(root, traceDir, String(params.requestId), action === "approve" ? "approve" : "deny");
        return { content: [{ type: "text", text: `${action}d ${params.requestId}.` }], details: approvalDetails({ ok: true, requestId: String(params.requestId) }) };
      }
      const pending = listPendingApprovals(root, traceDir);
      if (!pending.length) return { content: [{ type: "text", text: "Nothing waiting for approval." }], details: approvalDetails({ ok: true }) };
      const text = pending
        .map((request) => `${request.requestId} ${request.toolName} — ${request.reason} (${Math.round((request.ageMs ?? 0) / 1000)}s ago)\n  ${String(request.summary ?? "").slice(0, 300)}`)
        .join("\n");
      return { content: [{ type: "text", text }], details: approvalDetails({ ok: true, pending: pending.length }) };
    }
  });

  pi.registerTool({
    name: "companion_backends",
    label: "Companion Backends",
    description: "Show which execution backends this host supports (directory/bwrap/container/microvm) and what auto would pick.",
    promptSnippet: "Check companion sandbox backends",
    parameters: Type.Object({}),
    async execute() {
      const backends = await listBackends();
      const text = backends
        .map((entry) => `${entry.available ? "\u2713" : "\u2717"} ${entry.id.padEnd(10)} ${entry.isolation.padEnd(28)} ${entry.detail}`)
        .join("\n");
      return { content: [{ type: "text", text }], details: { backends: backends.map((entry) => ({ id: entry.id, available: entry.available })) } };
    }
  });

  pi.registerTool({
    name: "companion_template",
    label: "Teammate Templates",
    description: "Export or import portable teammate templates: action=export (names) | import (json, optional rename).",
    promptSnippet: "Export or import a teammate template",
    parameters: Type.Object({
      action: Type.String({ description: "export | import" }),
      names: Type.Optional(Type.Array(Type.String(), { description: "Teammate names to export (default: all)" })),
      json: Type.Optional(Type.String({ description: "Template JSON to import" })),
      rename: Type.Optional(Type.String({ description: "Import under a new name" }))
    }),
    async execute(_toolCallId, params) {
      const store = openStore(process.cwd());
      try {
        if (String(params.action).toLowerCase() === "import") {
          if (!params.json) return { content: [{ type: "text", text: "import requires the template json." }], details: { ok: false } };
          const parsed = parseTemplate(String(params.json));
          const report = applyTemplate(store, parsed, { rename: params.rename ?? null });
          return { content: [{ type: "text", text: formatTemplateReport(report) }], details: { ok: true, ...report } };
        }
        const template = buildTemplate(store.listTeammates(), { names: params.names ?? null });
        return { content: [{ type: "text", text: JSON.stringify(template, null, 2) }], details: { ok: true, teammates: template.teammates.length } };
      } catch (error) {
        return { content: [{ type: "text", text: `companion_template: ${(error as Error).message}` }], details: { ok: false } };
      }
    }
  });

  pi.registerCommand("companion", {
    description: "Persistent AI teammates: list | show <name> | status | feed [n] | logs <task> | files <task> [path] | routines [add <name> <every> <instr> | remove <id>] | creds [issue <name> [ttl] | rotate <id> [ttl] | revoke <id>] | approvals [approve|deny <id>] | backends | export [names] | reset <name>.",
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = args.trim().split(/\s+/);
      const store = openStore(ctx.cwd ?? process.cwd());
      try {
        switch (subcommand ?? "list") {
          case "list": {
            const teammates = store.listTeammates();
            notify(ctx, teammates.length
              ? teammates.map((t) => `@${t.name} — ${t.stats.completed} done, ${t.stats.failed} failed`).join("\n")
              : "No teammates. companion_create_teammate creates one.");
            return;
          }
          case "show": {
            const teammate = store.getTeammate(rest[0] ?? "");
            notify(ctx, teammate
              ? `@${teammate.name}\npersona: ${teammate.persona || "(none)"}\nworkspace: ${teammate.workspace}\nmodel: ${teammate.model ?? "(default)"}\nstats: ${teammate.stats.completed} done, ${teammate.stats.failed} failed`
              : `Teammate "${rest[0] ?? ""}" not found.`);
            return;
          }
          case "status": {
            const tasks = store.listTasks({});
            const counts: Record<string, number> = {};            for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
            notify(ctx, `Queue: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "empty"}`);
            return;
          }
          case "logs": {
            const task = store.getTask(rest[0] ?? "") ?? store.listTasks({}).find((entry) => entry.id.startsWith(rest[0] ?? ""));
            if (!task) { notify(ctx, `No task matches "${rest[0] ?? ""}".`); return; }
            const tail = store.readTaskLog(task.id, { lines: Number(rest[1] ?? 40) });
            notify(ctx, tail.exists ? tail.lines.join("\n") : `No log for ${task.id.slice(0, 8)} (${task.status}).`);
            return;
          }
          case "files": {
            const task = store.getTask(rest[0] ?? "") ?? store.listTasks({}).find((entry) => entry.id.startsWith(rest[0] ?? ""));
            if (!task) { notify(ctx, `No task matches "${rest[0] ?? ""}".`); return; }
            const manifest = readManifest(store.rootDir, task.id);
            if (!manifest) { notify(ctx, `No artifact manifest for ${task.id.slice(0, 8)}.`); return; }
            if (rest[1]) {
              const teammate = store.teammates.find((entry) => entry.id === task.teammateId);
              const workspace = teammate ? store.teammateDirectory(teammate, ctx.cwd ?? process.cwd()) : manifest.workspace;
              const diff = artifactDiff({ rootDir: store.rootDir, taskId: task.id, workspace, relPath: rest[1] });
              notify(ctx, diff.ok
                ? `${diff.mode}: ${rest[1]}\n${(diff.hunks ?? []).map((h) => `${h.type === "added" ? "+" : h.type === "removed" ? "-" : " "} ${h.text}`).join("\n")}`
                : `Cannot diff ${rest[1]}: ${diff.error}`);
              return;
            }
            const line = (kind: string, entry: { path: string; size: number }) => `  ${kind} ${entry.path} (${entry.size}B)`;
            notify(ctx, [`${manifest.counts.added} added, ${manifest.counts.modified} modified, ${manifest.counts.deleted} deleted`,
              ...manifest.added.map((entry: { path: string; size: number }) => line("added", entry)),
              ...manifest.modified.map((entry: { path: string; size: number }) => line("modified", entry)),
              ...manifest.deleted.map((entry: { path: string; size: number }) => line("deleted", entry))].join("\n"));
            return;
          }
          case "routines": {
            const action = rest[0] ?? "list";
            if (action === "add") {
              const everyMs = parseDurationMs(String(rest[2] ?? ""));
              if (!Number.isFinite(everyMs)) { notify(ctx, "Usage: routines add <name> <every 30m|2h|1d> <instruction>"); return; }
              const routine = store.addRoutine({ teammate: rest[1], instruction: rest.slice(3).join(" "), everyMs });
              notify(ctx, `Routine ${routine.id.slice(0, 8)} for @${routine.teammate} every ${rest[2]}.`);
              return;
            }
            if (action === "remove") {
              const removed = store.removeRoutine(rest[1] ?? "");
              notify(ctx, `Removed routine ${removed.id.slice(0, 8)}.`);
              return;
            }
            const routines = store.listRoutines();
            notify(ctx, routines.length
              ? routines.map((r) => `${r.id.slice(0, 8)} @${r.teammate} every ${Math.round(r.everyMs / 60000)}m — ${r.instruction.slice(0, 50)}`).join("\n")
              : "No routines.");
            return;
          }
          case "creds": {
            const action = rest[0] ?? "list";
            if (action === "issue") {
              const ttlMs = rest[2] ? parseDurationMs(rest[2]) : null;
              const { credential, mint } = store.issueTeammateCredential(rest[1] ?? "", { ttlMs });
              notify(ctx, `Credential ${credential.id.slice(0, 8)} for @${credential.teammate} (shown once):\n${mint}`);
              return;
            }
            if (action === "rotate") {
              const ttlMs = rest[2] ? parseDurationMs(rest[2]) : null;
              const result = store.rotateCredential(rest[1] ?? "", { ttlMs });
              notify(ctx, `Rotated ${result.previous.id.slice(0, 8)} → ${result.credential.id.slice(0, 8)}. New value:\n${result.mint}`);
              return;
            }
            if (action === "revoke") {
              const record = store.revokeCredential(rest[1] ?? "");
              notify(ctx, `Revoked ${record.id.slice(0, 8)} (@${record.teammate}).`);
              return;
            }
            const credentials = store.listCredentials();
            notify(ctx, credentials.length
              ? credentials.map((entry) => `${entry.id.slice(0, 8)} @${entry.teammate}${entry.revokedAt ? " revoked" : entry.expiresAt ? ` expires ${entry.expiresAt.slice(0, 10)}` : " no expiry"}`).join("\n")
              : "No scoped credentials.");
            return;
          }
          case "approvals": {
            const root = findProjectRoot(ctx.cwd ?? process.cwd());
            let traceDir = ".pi/runtime";
            try {
              traceDir = loadEquaxisConfigLayers(root).effective?.reliability?.traceDir ?? traceDir;
            } catch {
              // default
            }
            const action = rest[0] ?? "list";
            if (action === "approve" || action === "deny") {
              writeApprovalDecision(root, traceDir, rest[1] ?? "", action === "approve" ? "approve" : "deny");
              notify(ctx, `${action}d ${rest[1] ?? ""}.`);
              return;
            }
            const pending = listPendingApprovals(root, traceDir);
            notify(ctx, pending.length
              ? pending.map((r) => `${r.requestId} ${r.toolName} — ${r.reason}`).join("\n")
              : "Nothing waiting for approval.");
            return;
          }
          case "backends": {
            const backends = await listBackends();
            notify(ctx, backends.map((entry) => `${entry.available ? "\u2713" : "\u2717"} ${entry.id.padEnd(10)} ${entry.detail}`).join("\n"));
            return;
          }
          case "export": {
            const template = buildTemplate(store.listTeammates(), { names: rest.length ? rest : null });
            notify(ctx, JSON.stringify(template, null, 2));
            return;
          }
          case "reset": {
            const previous = store.resetTeammateSession(rest[0] ?? "");
            notify(ctx, previous ? `@${rest[0]} conversation cleared.` : `@${rest[0]} had no conversation.`);
            return;
          }
          case "feed": {
            const entries = store.readFeed(Number(rest[0] ?? 10));
            notify(ctx, entries.length
              ? entries.slice().reverse().map((e) => `${e.at} ${e.kind} ${e.teammate ? `@${e.teammate}` : ""}`).join("\n")
              : "Feed is empty.");
            return;
          }
          default:
            notify(ctx, "Usage: /companion list | show <name> | status | feed [n]");
        }
      } catch (error) {
        notify(ctx, `companion: ${(error as Error).message}`);
      }
    }
  });
}
