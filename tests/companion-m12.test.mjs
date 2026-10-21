import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { COMPANION_PWA_ASSETS } from "../src/companion-pwa.mjs";
import { CompanionStore } from "../src/companion-store.mjs";
import { startCompanionWebhook } from "../src/companion-webhook.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-m12-"));
}

// A synthetic non-secret fixture value, built at runtime so no literal in
// this file resembles a real credential.
const ADMIN = ["fixture", "admin", "value", "for", "tests"].join("-");

function authHeaders() {
  return { authorization: `Bearer ${ADMIN}` };
}

function seeded(root = tmpRoot()) {
  const store = CompanionStore.open(root);
  store.createTeammate({ name: "scout" });
  store.createTeammate({ name: "builder" });
  return store;
}

async function withWebhook(store, handler) {
  const webhook = await startCompanionWebhook({ store, credential: ADMIN, port: 0 });
  try {
    return await handler(`http://${webhook.host}:${webhook.port}`);
  } finally {
    await webhook.close();
  }
}

// ---- session continuity (store) ----

test("m12 continuity: a teammate gets one stable session id, allocated lazily", () => {
  const root = tmpRoot();
  const store = seeded(root);
  assert.equal(store.getTeammate("scout").sessionId, null, "no session until the first run");

  const first = store.ensureTeammateSession("scout");
  const second = store.ensureTeammateSession("scout");
  assert.equal(first, second, "the id must be stable across tasks");
  assert.match(first, /^[0-9a-f-]{36}$/);

  assert.notEqual(store.ensureTeammateSession("builder"), first, "teammates never share a thread");

  const reloaded = CompanionStore.open(root);
  assert.equal(reloaded.getTeammate("scout").sessionId, first, "the id must survive a restart");
});

test("m12 continuity: reset clears the conversation, keeps the teammate", () => {
  const store = seeded();
  const id = store.ensureTeammateSession("scout");
  const previous = store.resetTeammateSession("scout");
  assert.equal(previous, id);
  assert.equal(store.getTeammate("scout").sessionId, null);
  assert.ok(store.getTeammate("scout"), "the teammate itself is untouched");

  // A reset teammate simply gets a fresh thread next time.
  assert.notEqual(store.ensureTeammateSession("scout"), id);
  assert.throws(() => store.resetTeammateSession("ghost"), /teammate "ghost" not found/);
});

// ---- thread route ----

test("m12 thread: recent turns come back oldest-first with results and usage", async () => {
  const store = seeded();
  const first = store.enqueue("scout", "remember ORANGE");
  store.complete(first.id, "stored");
  store.recordUsage(first.id, { turns: 2, totalTokens: 100, costUsd: 0.002, model: "m" });
  store.enqueue("scout", "what was it?");
  store.enqueue("builder", "unrelated");

  await withWebhook(store, async (base) => {
    const res = await fetch(`${base}/thread/scout`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.teammate, "scout");
    assert.equal(body.turns.length, 2, "only this teammate's turns");
    assert.equal(body.turns[0].instruction, "remember ORANGE");
    assert.equal(body.turns[0].result, "stored");
    assert.equal(body.turns[0].usage.costUsd, 0.002);
    assert.equal(body.turns[1].status, "pending");
    assert.equal(body.turns[1].result, null);
  });
});

test("m12 thread: reports whether the conversation is continuous", async () => {
  const store = seeded();
  store.enqueue("scout", "hi");
  await withWebhook(store, async (base) => {
    const cold = await (await fetch(`${base}/thread/scout`, { headers: authHeaders() })).json();
    assert.equal(cold.continuous, false);
    assert.equal(cold.sessionId, null);

    store.ensureTeammateSession("scout");
    const warm = await (await fetch(`${base}/thread/scout`, { headers: authHeaders() })).json();
    assert.equal(warm.continuous, true);
    assert.match(warm.sessionId, /^[0-9a-f-]{36}$/);
  });
});

test("m12 thread: unknown teammates are 404; the route is admin-only; n is clamped", async () => {
  const store = seeded();
  for (let i = 0; i < 30; i += 1) store.enqueue("scout", `turn ${i + 1}`);
  const { mint } = store.issueTeammateCredential("scout");

  await withWebhook(store, async (base) => {
    assert.equal((await fetch(`${base}/thread/scout`)).status, 401);
    const scoped = await fetch(`${base}/thread/scout`, { headers: { authorization: `Bearer ${mint}` } });
    assert.equal(scoped.status, 403);

    assert.equal((await fetch(`${base}/thread/ghost`, { headers: authHeaders() })).status, 404);

    const few = await (await fetch(`${base}/thread/scout?n=5`, { headers: authHeaders() })).json();
    assert.equal(few.turns.length, 5);
    assert.equal(few.turns.at(-1).instruction, "turn 30", "the window is the most recent turns");

    const capped = await fetch(`${base}/thread/scout?n=99999`, { headers: authHeaders() });
    assert.equal(capped.status, 200, "clamped, never an error");
  });
});

// ---- dashboard wiring ----

test("m12 pwa: the dashboard has a conversation view with a compose box", async () => {
  const vm = await import("node:vm");
  const js = COMPANION_PWA_ASSETS["/app.js"].body;
  assert.doesNotThrow(() => new vm.Script(js, { filename: "app.js" }), "the emitted JS must compile");

  assert.match(js, /\/thread\//);
  // M16: the thread IS the main pane now (no per-card "chat" toggle), and the
  // composer sends through the same task route.
  assert.match(js, /renderChat/);
  assert.match(COMPANION_PWA_ASSETS["/"].body, /id="input"/);
  assert.match(COMPANION_PWA_ASSETS["/"].body, /id="send"/);
  assert.match(js, /post\("\/task\//);
});
