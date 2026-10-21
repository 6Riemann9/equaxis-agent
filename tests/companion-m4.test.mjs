import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { COMPANION_PWA_ASSETS } from "../src/companion-pwa.mjs";
import { CompanionStore } from "../src/companion-store.mjs";
import { startCompanionWebhook } from "../src/companion-webhook.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-m4-"));
}

// A synthetic non-secret fixture value, built at runtime so no literal in
// this file resembles a real credential.
const TEST_CREDENTIAL = ["fixture", "credential", "for", "tests"].join("-");

function authHeaders() {
  return { authorization: `Bearer ${TEST_CREDENTIAL}` };
}

function seededStore(root) {
  const store = CompanionStore.open(root);
  store.createTeammate({ name: "scout", persona: "researcher", model: "sonnet" });
  return store;
}

async function withWebhook(store, handler, options = {}) {
  const webhook = await startCompanionWebhook({
    store,
    credential: TEST_CREDENTIAL,
    port: 0,
    ...options
  });
  try {
    return await handler(`http://${webhook.host}:${webhook.port}`, webhook);
  } finally {
    await webhook.close();
  }
}

// ---- dashboard task queueing: runSource labeling ----

test("m4 webhook: same-origin POST /task is labeled runSource dashboard; plain webhook stays webhook", async () => {
  const store = seededStore(tmpRoot());
  await withWebhook(store, async (base) => {
    const dash = await fetch(`${base}/task/scout`, {
      method: "POST",
      headers: { ...authHeaders(), origin: base, "content-type": "application/json" },
      body: JSON.stringify({ instruction: "from the phone" })
    });
    assert.equal(dash.status, 202);
    const dashTask = store.getTask((await dash.json()).taskId);
    assert.equal(dashTask.runSource, "dashboard");

    const hook = await fetch(`${base}/task/scout`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ instruction: "from curl" })
    });
    assert.equal(hook.status, 202);
    const hookTask = store.getTask((await hook.json()).taskId);
    assert.equal(hookTask.runSource, "webhook");
  });
});

// ---- cancel route ----

test("m4 webhook: POST /cancel cancels a pending task and reports the queue", async () => {
  const store = seededStore(tmpRoot());
  const task = store.enqueue("scout", "a chore that will not run");
  await withWebhook(store, async (base) => {
    const denied = await fetch(`${base}/cancel/${task.id}`, { method: "POST" });
    assert.equal(denied.status, 401);

    const res = await fetch(`${base}/cancel/${task.id}`, {
      method: "POST",
      headers: { ...authHeaders(), origin: base }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.taskId, task.id);
    assert.equal(store.getTask(task.id).status, "cancelled");
    assert.equal(store.getTask(task.id).error, "cancelled from the dashboard");

    const status = await fetch(`${base}/status`, { headers: authHeaders() });
    const counts = (await status.json()).queue;
    assert.equal(counts.pending ?? 0, 0);
    assert.equal(counts.cancelled, 1);
  });
});

test("m4 webhook: cancel refuses unknown ids and non-pending tasks without corrupting state", async () => {
  const store = seededStore(tmpRoot());
  const done = store.enqueue("scout", "already finished");
  store.complete(done.id, "ok");
  const firstPending = store.enqueue("scout", "claimed by a worker");
  // The worker claims FIFO: with only this one pending, next() takes it.
  const claimed = store.next();
  assert.equal(claimed.id, firstPending.id);
  assert.equal(claimed.status, "running");
  const alsoPending = store.enqueue("scout", "queued behind the running one");
  await withWebhook(store, async (base) => {
    const unknown = await fetch(`${base}/cancel/00000000-0000-0000-0000-000000000000`, {
      method: "POST",
      headers: authHeaders()
    });
    assert.equal(unknown.status, 404);

    const finished = await fetch(`${base}/cancel/${done.id}`, { method: "POST", headers: authHeaders() });
    assert.equal(finished.status, 409);

    // M11: a running task can now be cancelled — the route records the
    // request and the worker kills the subprocess. It must NOT flip straight
    // to "cancelled" while that process is still alive.
    const running = await fetch(`${base}/cancel/${claimed.id}`, { method: "POST", headers: authHeaders() });
    assert.equal(running.status, 200);
    assert.equal((await running.json()).state, "cancelling");
    assert.equal(store.getTask(claimed.id).status, "cancelling");
    // The worker, not the route, finalizes the status.
    store.finishCancellation(claimed.id, "cancelled while running");
    assert.equal(store.getTask(claimed.id).status, "cancelled");
    // Untouched.
    assert.equal(store.getTask(alsoPending.id).status, "pending");
    assert.equal(store.getTask(done.id).status, "done");

    // The pending ones still cancel fine afterwards.
    const ok = await fetch(`${base}/cancel/${alsoPending.id}`, { method: "POST", headers: authHeaders() });
    assert.equal(ok.status, 200);
  });
});

// ---- status exposes pending tasks for the cancel UI ----

test("m4 webhook: /status teammateDetails lists pending tasks (capped at 5, oldest first)", async () => {
  const store = seededStore(tmpRoot());
  for (let i = 1; i <= 7; i += 1) store.enqueue("scout", `chore ${i}`);
  await withWebhook(store, async (base) => {
    const res = await fetch(`${base}/status`, { headers: authHeaders() });
    const body = await res.json();
    const scout = body.teammateDetails.find((t) => t.name === "scout");
    assert.equal(scout.pending, 7);
    // Oldest-first ordering, capped to the 5 most recent pending chores.
    assert.equal(scout.pendingTasks.length, 5);
    assert.equal(scout.pendingTasks[0].instruction, "chore 3");
    assert.equal(scout.pendingTasks[4].instruction, "chore 7");
    assert.ok(scout.pendingTasks.every((p) => typeof p.id === "string" && p.id.length > 10));
  });
});

// ---- PWA assets carry the write actions ----

test("m4 pwa: app.js wires the task form and cancel buttons; still no credentials", () => {
  const app = COMPANION_PWA_ASSETS["/app.js"].body;
  // M16 replaced the per-card form with a chat composer; the routes are the
  // same ones, so what matters is that both writes still go through them.
  assert.match(app, /\/task\//);
  assert.match(app, /\/cancel\//);
  assert.match(COMPANION_PWA_ASSETS["/"].body, /id="send"/);
  // The submit path must encode the teammate name (kebab-case is safe, but
  // never trust template-built URLs).
  assert.match(app, /encodeURIComponent/);
  // Write POSTs stay same-origin: the SW never intercepts non-GET.
  const sw = COMPANION_PWA_ASSETS["/sw.js"].body;
  assert.match(sw, /method !== "GET"/);
  for (const [name, asset] of Object.entries(COMPANION_PWA_ASSETS)) {
    assert.ok(!asset.body.includes(TEST_CREDENTIAL), `asset ${name} must not contain the credential`);
  }
});
