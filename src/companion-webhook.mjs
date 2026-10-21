import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { COMPANION_PWA_ASSETS } from "./companion-pwa.mjs";
import { parseDurationMs } from "./duration.mjs";
import { listApprovalHistory, listPendingApprovals, writeApprovalDecision } from "./approval-queue.mjs";
import { artifactDiff, readManifest, resolveArtifactFile } from "./companion-artifacts.mjs";
import { readStreamState } from "./companion-stream.mjs";

/**
 * Companion webhook ingress: a loopback HTTP listener that turns external
 * events into teammate tasks.
 *
 *   GET  /                    → the read-only PWA dashboard shell (no auth;
 *                              static asset carrying no secrets — the data
 *                              routes behind it all require the credential)
 *   GET  /app.js|/sw.js|/manifest.webmanifest|/icon.svg → PWA assets
 *   POST /task/<teammate>   { "instruction": "..." }   → 202 { taskId }
 *                              (same-origin dashboard requests are labeled
 *                              runSource "dashboard", others "webhook")
 *   POST /cancel/<taskId>                                 → 200 (pending finalized, running requested)
 *   GET  /log/<taskId>?lines=<n>                          → task stream log tail
 *   GET  /progress/<taskId>                               → live text/thinking/tools of a run
 *   GET  /thread/<teammate>?n=<1..100>                    → recent turns (conversation view)
 *   GET  /artifacts/<taskId>                              → workspace change manifest
 *   GET  /artifact/<taskId>/diff?path=<rel>               → unified diff for one file
 *   GET  /artifact/<taskId>/raw?path=<rel>                → the file itself (download)
 *   GET  /approvals                                       → pending high-risk requests + history
 *   POST /approval/<requestId> { decision }               → approve | deny (admin only)
 *   POST /routine  { teammate, every, instruction }        → 202 { routine }
 *   POST /routine/<id>/remove                              → 200 { removed }
 *   GET  /status                                     → queue + teammate summary
 *   GET  /feed?n=<1..200>                            → recent feed entries
 *   GET  /healthz                                    → liveness (no auth)
 *
 * Security model (mirrors the automation-server discipline):
 *   - binds 127.0.0.1 only unless the caller explicitly passes another
 *     host (CLI --listen) — and then only hosts in the allowlist are
 *     accepted, see below
 *   - every state-changing or data route requires the bearer credential
 *     issued by the store; the value is injected by the caller and never
 *     appears in this module or its logs
 *   - a request carrying an Origin header is accepted only when the origin
 *     is one of the allowed hosts (the dashboard served by this listener);
 *     any foreign web page is still refused before auth (CSRF)
 *   - a Host header outside the allowlist (loopback + caller-declared LAN
 *     hosts) is refused the same way (DNS rebinding)
 *   - bodies are capped (32 KB) and must be JSON
 *   - static assets are served by exact match against an in-module map —
 *     no filesystem access, so no path traversal surface
 */

const MAX_BODY_BYTES = 32 * 1024;
const BEARER_PREFIX = "Bearer ";

function localHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

/** The allowlist: loopback plus caller-declared hosts. Entries may be
 * "host:port" or a bare "host" (any port — needed when the listener binds
 * an ephemeral port, and for mDNS names reached on shifting ports). */
function allowedHosts(port, extraHosts) {
  const hosts = localHosts(port);
  for (const entry of extraHosts ?? []) {
    const value = String(entry).trim().toLowerCase();
    if (value) {
      hosts.add(value);
      if (!value.includes(":")) hosts.add(`${value}:*`);
    }
  }
  return hosts;
}

/** Host-header match against the allowlist, honoring bare-host wildcards. */
function hostAllowed(allowed, rawHost) {
  if (!rawHost) return false;
  const host = String(rawHost).toLowerCase();
  if (allowed.has(host)) return true;
  // IPv6 forms look like [::1]:port; keep the bracketed part as the hostname.
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return allowed.has(`${hostname}:*`);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
  // Returning the response lets callers use `return sendJson(...)` as a
  // guard: a truthy return means "already answered, stop here".
  return res;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Resolve the request principal from the bearer value: the global webhook
 * credential (admin — every route) or a per-teammate credential (scoped —
 * may only queue tasks for its own teammate, labeled runSource
 * "credential:<name>" in the audit trail).
 */
function authenticate(req, globalCredential, store) {
  const header = req.headers.authorization ?? "";
  if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) return { ok: false };
  const value = header.slice(BEARER_PREFIX.length);
  if (value === globalCredential) return { ok: true, principal: { type: "admin" } };
  const record = store.resolveCredential(value);
  if (record) {
    return { ok: true, principal: { type: "teammate", name: record.teammate, credentialId: record.id } };
  }
  return { ok: false };
}

/**
 * Start the webhook listener. Resolves with { server, port, host, close }.
 * `port` defaults to 0 (ephemeral); the caller decides what to advertise.
 * `credential` (required) is the bearer value the caller read from the
 * store's webhook-token file.
 * `extraHosts` extends the Host/Origin allowlist — used when the CLI binds
 * a LAN interface for the mobile dashboard. Entries are "host:port" or a
 * bare "host" (any port).
 * `servePwa` (default true) serves the read-only dashboard on GET /.
 */
export function startCompanionWebhook({
  store,
  credential,
  port = 0,
  host = "127.0.0.1",
  logger = null,
  extraHosts = [],
  servePwa = true,
  projectRoot = process.cwd(),
  traceDir = ".pi/runtime"
}) {
  if (!store) throw new Error("startCompanionWebhook: store is required");
  if (!credential) throw new Error("startCompanionWebhook: credential is required");
  const log = (...args) => logger?.(...args);
  const pwaAssets = servePwa ? COMPANION_PWA_ASSETS : null;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

      // Guards first: the allowlist is loopback + caller-declared hosts.
      const allowed = allowedHosts(server.address()?.port ?? port, extraHosts);
      // CSRF guard: a browser page always sends Origin. Same-origin (this
      // listener's own dashboard) passes; anything else is refused before
      // auth, even with a valid credential.
      if (req.headers.origin) {
        let originHost = null;
        try {
          originHost = new URL(req.headers.origin).host.toLowerCase();
        } catch {
          originHost = null;
        }
        if (!originHost || !hostAllowed(allowed, originHost)) {
          return sendJson(res, 403, { error: "cross-origin request is not accepted on this listener" });
        }
      }
      if (req.headers.host && !hostAllowed(allowed, req.headers.host)) {
        return sendJson(res, 403, { error: "unexpected Host header" });
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true });
      }

      // PWA shell: static, secret-free, exact-match only (no filesystem).
      if (pwaAssets && req.method === "GET") {
        const asset = pwaAssets[url.pathname];
        if (asset) {
          res.writeHead(200, {
            "content-type": asset.contentType,
            "content-length": Buffer.byteLength(asset.body),
            "x-content-type-options": "nosniff",
            ...(asset.noStore ? { "cache-control": "no-store" } : {})
          });
          return res.end(asset.body);
        }
      }

      const auth = authenticate(req, credential, store);
      if (!auth.ok) {
        return sendJson(res, 401, { error: "missing or invalid bearer credential" });
      }
      const isAdmin = auth.principal.type === "admin";
      const requireAdmin = () => {
        if (!isAdmin) {
          return sendJson(res, 403, { error: "this route requires the global webhook credential" });
        }
        return null;
      };

      if (req.method === "GET" && url.pathname === "/status") {
        const denied = requireAdmin();
        if (denied) return denied;
        const tasks = store.listTasks({});
        const counts = {};
        for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
        const teammateDetails = store.listTeammates().map((teammate) => {
          const mine = tasks.filter((task) => task.teammateId === teammate.id);
          const running = mine.find((task) => task.status === "running") ?? null;
          const finished = mine
            .filter((task) => task.finishedAt)
            .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))[0] ?? null;
          const pendingTasks = mine
            .filter((task) => task.status === "pending")
            .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
            .slice(-5)
            .map((task) => ({ id: task.id, instruction: task.instruction }));
          return {
            name: teammate.name,
            model: teammate.model,
            persona: teammate.persona,
            stats: teammate.stats,
            spend: {
              totalTokens: teammate.stats?.totalTokens ?? 0,
              totalCostUsd: teammate.stats?.totalCostUsd ?? 0
            },
            pending: mine.filter((task) => task.status === "pending").length,
            pendingTasks,
            running: running
              ? { id: running.id, instruction: running.instruction, attempt: running.attempts, startedAt: running.startedAt }
              : null,
            lastTask: finished
              ? { id: finished.id, status: finished.status, instruction: finished.instruction, finishedAt: finished.finishedAt, error: finished.error ?? null }
              : null
          };
        });
        const routineDetails = store.listRoutines().map((routine) => ({
          id: routine.id,
          teammate: routine.teammate,
          instruction: routine.instruction,
          everyMs: routine.everyMs,
          enabled: routine.enabled,
          lastRunAt: routine.lastRunAt,
          nextRunAt: routine.lastRunAt
            ? new Date(Date.parse(routine.lastRunAt) + routine.everyMs).toISOString()
            : null
        }));
        return sendJson(res, 200, {
          teammates: store.listTeammates().map((t) => t.name),
          teammateDetails,
          queue: counts,
          routines: routineDetails.length,
          routineDetails
        });
      }

      // Conversation view: the teammate's recent turns, oldest first, so the
      // dashboard can show a thread instead of a queue listing.
      const threadMatch = req.method === "GET" && url.pathname.match(/^\/thread\/([a-z0-9][a-z0-9_-]*)$/);
      if (threadMatch) {
        const denied = requireAdmin();
        if (denied) return denied;
        const teammate = store.getTeammate(threadMatch[1]);
        if (!teammate) return sendJson(res, 404, { error: "unknown teammate" });
        const requested = Number(url.searchParams.get("n") ?? 20);
        const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.floor(requested))) : 20;
        const turns = store.listTasks({ teammateId: teammate.id }).slice(-limit).map((task) => ({
          id: task.id,
          status: task.status,
          instruction: task.instruction,
          result: task.result,
          error: task.error,
          createdAt: task.createdAt,
          finishedAt: task.finishedAt,
          usage: task.usage ?? null,
          artifacts: task.artifacts ?? null
        }));
        return sendJson(res, 200, {
          teammate: teammate.name,
          sessionId: teammate.sessionId,
          continuous: Boolean(teammate.sessionId),
          turns
        });
      }

      const logMatch = req.method === "GET" && url.pathname.match(/^\/log\/([a-f0-9-]{1,64})$/);
      if (logMatch) {
        const denied = requireAdmin();
        if (denied) return denied;
        const requested = Number(url.searchParams.get("lines") ?? 200);
        const lines = Number.isFinite(requested) ? Math.min(2000, Math.max(1, Math.floor(requested))) : 200;
        return sendJson(res, 200, { taskId: logMatch[1], ...store.readTaskLog(logMatch[1], { lines }) });
      }

      // Approval bridge: a headless teammate cannot ask a human anything, so
      // the reliability harness parks high-risk calls here and polls for a
      // decision. These routes are the human side of that conversation.
      if (req.method === "GET" && url.pathname === "/approvals") {
        const denied = requireAdmin();
        if (denied) return denied;
        return sendJson(res, 200, {
          projectRoot,
          pending: listPendingApprovals(projectRoot, traceDir),
          history: listApprovalHistory(projectRoot, traceDir, 20)
        });
      }

      const approvalMatch = req.method === "POST" && url.pathname.match(/^\/approval\/([A-Za-z0-9_.-]{1,128})$/);
      if (approvalMatch) {
        const denied = requireAdmin();
        if (denied) return denied;
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          return sendJson(res, 400, { error: "request body must be JSON" });
        }
        const decision = String(payload?.decision ?? "");
        if (decision !== "approve" && decision !== "deny") {
          return sendJson(res, 400, { error: 'decision must be "approve" or "deny"' });
        }
        // Only requests the harness actually parked can be decided: writing a
        // decision for an unknown id would be an invisible no-op.
        const known = listPendingApprovals(projectRoot, traceDir).some((entry) => entry.requestId === approvalMatch[1])
          || listApprovalHistory(projectRoot, traceDir, 200).some((entry) => entry.requestId === approvalMatch[1]);
        if (!known) return sendJson(res, 404, { error: "unknown or expired approval request" });
        writeApprovalDecision(projectRoot, traceDir, approvalMatch[1], decision);
        log?.(`companion webhook: ${decision} decision for ${approvalMatch[1]}`);
        return sendJson(res, 200, { decided: true, requestId: approvalMatch[1], decision });
      }

      // Live progress: what the running teammate is thinking/writing right
      // now, derived from its own stream log. This is what makes the chat feel
      // alive instead of "wait 40 seconds, then a message appears".
      const progressMatch = req.method === "GET" && url.pathname.match(/^\/progress\/([a-f0-9-]{1,64})$/);
      if (progressMatch) {
        const denied = requireAdmin();
        if (denied) return denied;
        const task = store.getTask(progressMatch[1]);
        if (!task) return sendJson(res, 404, { error: "unknown task" });
        const state = readStreamState(store.taskLogFile(task.id));
        return sendJson(res, 200, {
          taskId: task.id,
          status: task.status,
          instruction: task.instruction,
          startedAt: task.startedAt,
          progress: state
        });
      }

      const artifactsMatch = req.method === "GET" && url.pathname.match(/^\/artifacts\/([a-f0-9-]{1,64})$/);
      if (artifactsMatch) {
        const denied = requireAdmin();
        if (denied) return denied;
        const manifest = readManifest(store.rootDir, artifactsMatch[1]);
        if (!manifest) return sendJson(res, 404, { error: "no artifacts for this task" });
        return sendJson(res, 200, manifest);
      }

      const artifactMatch = req.method === "GET" && url.pathname.match(/^\/artifact\/([a-f0-9-]{1,64})\/(diff|raw)$/);
      if (artifactMatch) {
        const denied = requireAdmin();
        if (denied) return denied;
        const [, taskId, mode] = artifactMatch;
        const relPath = url.searchParams.get("path") ?? "";
        const task = store.getTask(taskId);
        const teammate = task ? store.teammates.find((entry) => entry.id === task.teammateId) : null;
        const workspace = teammate ? store.teammateDirectory(teammate, projectRoot) : null;
        if (!task || !workspace) return sendJson(res, 404, { error: "unknown task" });

        if (mode === "diff") {
          const diff = artifactDiff({ rootDir: store.rootDir, taskId, workspace, relPath });
          return sendJson(res, diff.ok ? 200 : 400, diff);
        }

        const absolute = resolveArtifactFile({ rootDir: store.rootDir, taskId, workspace, relPath });
        if (!absolute) return sendJson(res, 404, { error: "artifact not listed for this task" });
        let stat;
        try {
          stat = fs.statSync(absolute);
        } catch {
          return sendJson(res, 404, { error: "artifact is gone" });
        }
        // Downloads are capped: this is a dashboard convenience, not a file
        // server, and an unbounded read would block the loop.
        if (stat.size > 4 * 1024 * 1024) {
          return sendJson(res, 413, { error: `artifact is too large to download here (${stat.size} bytes)` });
        }
        const body = fs.readFileSync(absolute);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": body.length,
          "content-disposition": `attachment; filename="${path.basename(relPath).replace(/["\\]/g, "_")}"`,
          "x-content-type-options": "nosniff"
        });
        return res.end(body);
      }

      if (req.method === "GET" && url.pathname === "/feed") {
        const denied = requireAdmin();
        if (denied) return denied;
        const requested = Number(url.searchParams.get("n") ?? 50);
        const limit = Number.isFinite(requested) ? Math.min(200, Math.max(1, Math.floor(requested))) : 50;
        return sendJson(res, 200, { entries: store.readFeed(limit) });
      }

      // Routines are schedule changes, not work items: admin only, the same
      // rule as /status and /cancel.
      if (req.method === "POST" && url.pathname === "/routine") {
        const denied = requireAdmin();
        if (denied) return denied;
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          return sendJson(res, 400, { error: "request body must be JSON" });
        }
        const teammate = String(payload?.teammate ?? "").trim();
        const instruction = String(payload?.instruction ?? "").trim();
        const everyRaw = payload?.everyMs ?? payload?.every;
        const everyMs = Number.isFinite(Number(everyRaw)) && typeof everyRaw !== "string"
          ? Number(everyRaw)
          : parseDurationMs(String(everyRaw ?? ""));
        if (!teammate || !instruction) return sendJson(res, 400, { error: "teammate and instruction are required" });
        if (!Number.isFinite(everyMs)) {
          return sendJson(res, 400, { error: "every must be a duration like 30m, 2h, 1d (or everyMs as a number)" });
        }
        try {
          const routine = store.addRoutine({ teammate, instruction, everyMs });
          log?.(`companion webhook: routine ${routine.id.slice(0, 8)} every ${everyMs}ms for @${teammate}`);
          return sendJson(res, 202, {
            routine: {
              id: routine.id,
              teammate: routine.teammate,
              instruction: routine.instruction,
              everyMs: routine.everyMs
            }
          });
        } catch (error) {
          return sendJson(res, 400, { error: String(error?.message ?? error) });
        }
      }

      const routineRemove = req.method === "POST" && url.pathname.match(/^\/routine\/([a-f0-9-]{1,64})\/remove$/);
      if (routineRemove) {
        const denied = requireAdmin();
        if (denied) return denied;
        try {
          const removed = store.removeRoutine(routineRemove[1]);
          log?.(`companion webhook: removed routine ${removed.id.slice(0, 8)}`);
          return sendJson(res, 200, { removed: true, routineId: removed.id });
        } catch (error) {
          return sendJson(res, 404, { error: String(error?.message ?? error) });
        }
      }

      const taskMatch = req.method === "POST" && url.pathname.match(/^\/task\/([a-z0-9][a-z0-9_-]*)$/);
      if (taskMatch) {
        // Scoped credentials may only queue tasks for their own teammate.
        if (!isAdmin && auth.principal.name !== taskMatch[1]) {
          return sendJson(res, 403, {
            error: `this credential may only queue tasks for @${auth.principal.name}`
          });
        }
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          return sendJson(res, 400, { error: "request body must be JSON" });
        }
        const instruction = String(payload?.instruction ?? "").trim();
        if (!instruction) return sendJson(res, 400, { error: "instruction is required" });
        // Audit trail: same-origin dashboard requests (admin credential),
        // scoped credentials name their teammate, plain callers stay webhook.
        const runSource = auth.principal.type === "teammate"
          ? `credential:${auth.principal.name}`
          : req.headers.origin
            ? "dashboard"
            : "webhook";
        try {
          const task = store.enqueue(taskMatch[1], instruction, { runSource });
          log?.(`companion webhook: queued task ${task.id.slice(0, 8)} for @${taskMatch[1]} (${runSource})`);
          return sendJson(res, 202, { queued: true, taskId: task.id, teammate: taskMatch[1] });
        } catch (error) {
          return sendJson(res, 404, { error: String(error?.message ?? error) });
        }
      }

      // Dashboard cancel: pending tasks only. A running task's subprocess is
      // already claimed by a worker — marking it cancelled would mislead (the
      // run continues and stores its real outcome), so refuse with 409.
      const cancelMatch = req.method === "POST" && url.pathname.match(/^\/cancel\/([a-f0-9-]{1,64})$/);
      if (cancelMatch) {
        const denied = requireAdmin();
        if (denied) return denied;
        const task = store.getTask(cancelMatch[1]);
        if (!task) return sendJson(res, 404, { error: "unknown task" });
        if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
          return sendJson(res, 409, { error: `task is already ${task.status}` });
        }
        // A running task cannot be killed from this process: the worker owns
        // the subprocess. Record the request; the worker aborts and finalizes.
        const updated = store.cancel(cancelMatch[1], "cancelled from the dashboard");
        const pending = updated.status === "cancelling";
        log?.(`companion webhook: ${pending ? "requested cancel of" : "cancelled"} task ${task.id.slice(0, 8)}`);
        return sendJson(res, 200, { cancelled: true, taskId: task.id, state: updated.status });
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      log?.(`companion webhook: ${error?.message ?? error}`);
      return sendJson(res, 500, { error: "internal error" });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        host: address?.address ?? host,
        port: address?.port ?? port,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}
