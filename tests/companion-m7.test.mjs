import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { COMPANION_PWA_ASSETS } from "../src/companion-pwa.mjs";
import { CompanionStore, MIN_ROUTINE_INTERVAL_MS } from "../src/companion-store.mjs";
import { startCompanionWebhook } from "../src/companion-webhook.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-m7-"));
}

// A synthetic non-secret fixture value, built at runtime so no literal in
// this file resembles a real credential.
const ADMIN = ["fixture", "admin", "value", "for", "tests"].join("-");

function authHeaders() {
  return { authorization: `Bearer ${ADMIN}` };
}

function seededStore(root) {
  const store = CompanionStore.open(root);
  store.createTeammate({ name: "scout" });
  store.createTeammate({ name: "builder" });
  return store;
}

async function withWebhook(store, handler) {
  const webhook = await startCompanionWebhook({ store, credential: ADMIN, port: 0 });
  try {
    return await handler(`http://${webhook.host}:${webhook.port}`, webhook);
  } finally {
    await webhook.close();
  }
}

function postRoutine(base, body, headers = authHeaders()) {
  return fetch(`${base}/routine`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

// ---- create ----

test("m7 routines: POST /routine creates a schedule from a human interval", async () => {
  const store = seededStore(tmpRoot());
  await withWebhook(store, async (base) => {
    const res = await postRoutine(base, { teammate: "scout", every: "30m", instruction: "check for regressions" });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.routine.teammate, "scout");
    assert.equal(body.routine.everyMs, 30 * 60_000);

    const stored = store.listRoutines();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].instruction, "check for regressions");
    assert.equal(stored[0].enabled, true);
  });
});

test("m7 routines: everyMs may be given as a number instead of a duration string", async () => {
  const store = seededStore(tmpRoot());
  await withWebhook(store, async (base) => {
    const res = await postRoutine(base, { teammate: "scout", everyMs: 2 * 3_600_000, instruction: "hourly sweep" });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).routine.everyMs, 2 * 3_600_000);
  });
});

test("m7 routines: bad schedules are 400, never 500, and create nothing", async () => {
  const store = seededStore(tmpRoot());
  await withWebhook(store, async (base) => {
    const cases = [
      [{ teammate: "scout", every: "30m" }, /instruction are required/],
      [{ every: "30m", instruction: "x" }, /teammate and instruction are required/],
      [{ teammate: "scout", every: "banana", instruction: "x" }, /every must be a duration/],
      [{ teammate: "ghost", every: "30m", instruction: "x" }, /teammate "ghost" not found/],
      [{ teammate: "scout", every: "1s", instruction: "x" }, /at least/]
    ];
    for (const [payload, pattern] of cases) {
      const res = await postRoutine(base, payload);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(payload)}`);
      assert.match((await res.json()).error, pattern);
    }
    assert.equal(store.listRoutines().length, 0, "no schedule may be created by a rejected request");

    const notJson = await fetch(`${base}/routine`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: "not json"
    });
    assert.equal(notJson.status, 400);
    assert.ok(MIN_ROUTINE_INTERVAL_MS >= 60_000);
  });
});

test("m7 routines: creating a routine requires the admin credential", async () => {
  const store = seededStore(tmpRoot());
  const { mint } = store.issueTeammateCredential("scout");
  await withWebhook(store, async (base) => {
    const anonymous = await postRoutine(base, { teammate: "scout", every: "30m", instruction: "x" }, {});
    assert.equal(anonymous.status, 401);

    const scoped = await postRoutine(
      base,
      { teammate: "scout", every: "30m", instruction: "x" },
      { authorization: `Bearer ${mint}` }
    );
    assert.equal(scoped.status, 403);
    assert.match((await scoped.json()).error, /global webhook credential/);
    assert.equal(store.listRoutines().length, 0);
  });
});

// ---- list ----

test("m7 routines: /status exposes routineDetails with a computed next run", async () => {
  const store = seededStore(tmpRoot());
  const never = store.addRoutine({ teammate: "scout", instruction: "never ran", everyMs: 30 * 60_000 });
  const ran = store.addRoutine({ teammate: "builder", instruction: "already ran", everyMs: 60 * 60_000 });
  const ranAt = new Date(Date.now() - 15 * 60_000).toISOString();
  store.markRoutineRun(ran.id, "task-1", ranAt);

  await withWebhook(store, async (base) => {
    const res = await fetch(`${base}/status`, { headers: authHeaders() });
    const body = await res.json();
    assert.equal(body.routines, 2);
    const details = body.routineDetails;
    assert.equal(details.length, 2);

    const pending = details.find((r) => r.id === never.id);
    assert.equal(pending.nextRunAt, null, "never-run routines are due now");
    assert.equal(pending.everyMs, 30 * 60_000);

    const tracked = details.find((r) => r.id === ran.id);
    assert.equal(tracked.lastRunAt, ranAt);
    assert.equal(Date.parse(tracked.nextRunAt), Date.parse(ranAt) + 60 * 60_000);
  });
});

// ---- remove ----

test("m7 routines: POST /routine/<id>/remove deletes the schedule; unknown ids are 404", async () => {
  const store = seededStore(tmpRoot());
  const routine = store.addRoutine({ teammate: "scout", instruction: "to be removed", everyMs: 30 * 60_000 });
  await withWebhook(store, async (base) => {
    const denied = await fetch(`${base}/routine/${routine.id}/remove`, { method: "POST" });
    assert.equal(denied.status, 401);

    const res = await fetch(`${base}/routine/${routine.id}/remove`, { method: "POST", headers: authHeaders() });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).routineId, routine.id);
    assert.equal(store.listRoutines().length, 0);

    const again = await fetch(`${base}/routine/${routine.id}/remove`, { method: "POST", headers: authHeaders() });
    assert.equal(again.status, 404);

    const bogus = await fetch(`${base}/routine/not-an-id/remove`, { method: "POST", headers: authHeaders() });
    assert.equal(bogus.status, 404);
  });
});

test("m7 routines: a scoped credential cannot remove schedules either", async () => {
  const store = seededStore(tmpRoot());
  const routine = store.addRoutine({ teammate: "scout", instruction: "protected", everyMs: 30 * 60_000 });
  const { mint } = store.issueTeammateCredential("scout");
  await withWebhook(store, async (base) => {
    const res = await fetch(`${base}/routine/${routine.id}/remove`, {
      method: "POST",
      headers: { authorization: `Bearer ${mint}` }
    });
    assert.equal(res.status, 403);
    assert.equal(store.listRoutines().length, 1, "schedule survives a scoped credential");
  });
});

// ---- dashboard assets ----

test("m7 pwa: the dashboard wires routine create/remove and renders routineDetails", () => {
  const app = COMPANION_PWA_ASSETS["/app.js"].body;
  const html = COMPANION_PWA_ASSETS["/"].body;

  assert.match(app, /\/routine"|"\/routine"/);
  assert.match(app, /remove-routine/);
  assert.match(app, /routineDetails/);
  assert.match(app, /\/remove/);
  assert.match(app, /loadRoutines/);

  // The routines panel is rendered by the app script (it is a slide-over, not
  // part of the static shell), so the ids live there.
  assert.match(app, /id=["\']routines["\']/);
  assert.match(app, /id="routine-form"/);
  assert.match(app, /id="routine-every"/);
  // The interval options offered must be at or above the store's floor.
  const options = [...app.matchAll(/<option value="(\d+)([mhd])"/g)];
  assert.ok(options.length >= 3);
  const toMs = (value, unit) => Number(value) * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
  for (const [, value, unit] of options) {
    assert.ok(toMs(value, unit) >= MIN_ROUTINE_INTERVAL_MS, `option ${value}${unit} is below the routine floor`);
  }
});
