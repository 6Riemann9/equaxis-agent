import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CompanionStore } from "../src/companion-store.mjs";
import { startCompanionWebhook } from "../src/companion-webhook.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-m5-"));
}

// A synthetic non-secret fixture value, built at runtime so no literal in
// this file resembles a real credential.
const ADMIN = ["fixture", "admin", "value", "for", "tests"].join("-");

function seededStore(root) {
  const store = CompanionStore.open(root);
  store.createTeammate({ name: "scout", persona: "researcher" });
  store.createTeammate({ name: "builder", persona: "ships things" });
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

function bearer(value) {
  return { authorization: `Bearer ${value}` };
}

// ---- store: issuance, storage, revocation ----

test("m5 credentials: issuance returns the value once and persists only a digest", () => {
  const root = tmpRoot();
  const store = seededStore(root);
  const { credential, mint } = store.issueTeammateCredential("scout", { label: "phone" });

  assert.match(mint, /^eqc1_[a-z0-9]{20,}$/);
  assert.equal(credential.teammate, "scout");
  assert.equal(credential.label, "phone");
  assert.equal(credential.revokedAt, null);
  assert.equal(credential.lastUsedAt, null);

  // The on-disk record must not contain the value itself.
  const raw = fs.readFileSync(path.join(root, "credentials.json"), "utf8");
  assert.ok(!raw.includes(mint), "plaintext credential must never be persisted");
  assert.match(raw, /"digest"/);
  const persisted = JSON.parse(raw);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].teammate, "scout");
  assert.equal(persisted[0].digest.length, 64); // sha256 hex
});

test("m5 credentials: resolve accepts live values, rejects unknown/foreign/revoked", () => {
  const store = seededStore(tmpRoot());
  const { credential, mint } = store.issueTeammateCredential("scout");

  const live = store.resolveCredential(mint);
  assert.equal(live.id, credential.id);
  assert.ok(live.lastUsedAt, "a successful resolve stamps lastUsedAt");

  assert.equal(store.resolveCredential("eqc1_deadbeef"), null, "unknown value rejected");
  assert.equal(store.resolveCredential(ADMIN), null, "the admin value is not a teammate credential");
  assert.equal(store.resolveCredential(""), null);
  assert.equal(store.resolveCredential(null), null);

  store.revokeCredential(credential.id);
  assert.equal(store.resolveCredential(mint), null, "revoked credentials stop resolving");
  assert.equal(store.listCredentials()[0].revokedAt !== null, true);
});

test("m5 credentials: issuing for an unknown teammate fails; revoke is prefix-matched and unambiguous", () => {
  const store = seededStore(tmpRoot());
  assert.throws(() => store.issueTeammateCredential("ghost"), /teammate "ghost" not found/);

  const a = store.issueTeammateCredential("scout");
  const b = store.issueTeammateCredential("builder");
  // A short prefix that matches both must be refused, not silently resolved.
  assert.throws(() => store.revokeCredential(""), /ambiguous/);
  const revoked = store.revokeCredential(b.credential.id.slice(0, 8));
  assert.equal(revoked.id, b.credential.id);
  assert.equal(store.resolveCredential(a.mint).id, a.credential.id, "other credential still live");
});

test("m5 credentials: deleting the teammate kills its credentials", () => {
  const store = seededStore(tmpRoot());
  const { mint } = store.issueTeammateCredential("scout");
  assert.ok(store.resolveCredential(mint));
  store.deleteTeammate("scout");
  assert.equal(store.resolveCredential(mint), null);
});

// ---- webhook: scope enforcement ----

test("m5 webhook: a scoped credential queues only for its own teammate", async () => {
  const store = seededStore(tmpRoot());
  const { credential, mint } = store.issueTeammateCredential("scout");
  await withWebhook(store, async (base) => {
    const own = await fetch(`${base}/task/scout`, {
      method: "POST",
      headers: { ...bearer(mint), "content-type": "application/json" },
      body: JSON.stringify({ instruction: "my own chore" })
    });
    assert.equal(own.status, 202);
    const task = store.getTask((await own.json()).taskId);
    assert.equal(task.runSource, "credential:scout", "audit trail names the scoped credential");
    assert.equal(credential.teammate, "scout");

    const other = await fetch(`${base}/task/builder`, {
      method: "POST",
      headers: { ...bearer(mint), "content-type": "application/json" },
      body: JSON.stringify({ instruction: "not mine to queue" })
    });
    assert.equal(other.status, 403);
    assert.match((await other.json()).error, /only queue tasks for @scout/);
  });
});

test("m5 webhook: scoped credentials cannot read state or cancel tasks", async () => {
  const store = seededStore(tmpRoot());
  const { mint } = store.issueTeammateCredential("scout");
  const task = store.enqueue("scout", "someone else's chore");
  await withWebhook(store, async (base) => {
    for (const [method, route] of [["GET", "/status"], ["GET", "/feed"], ["POST", `/cancel/${task.id}`]]) {
      const res = await fetch(`${base}${route}`, { method, headers: bearer(mint) });
      assert.equal(res.status, 403, `${method} ${route} must be admin-only`);
      assert.match((await res.json()).error, /global webhook credential/);
    }
    assert.equal(store.getTask(task.id).status, "pending", "task untouched");
    // healthz stays open for everyone.
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });
});

test("m5 webhook: revoked and unknown credentials are 401; the admin credential keeps full access", async () => {
  const store = seededStore(tmpRoot());
  const { credential, mint } = store.issueTeammateCredential("scout");
  await withWebhook(store, async (base) => {
    const before = await fetch(`${base}/status`, { headers: bearer(ADMIN) });
    assert.equal(before.status, 200);

    store.revokeCredential(credential.id);
    const revoked = await fetch(`${base}/task/scout`, {
      method: "POST",
      headers: { ...bearer(mint), "content-type": "application/json" },
      body: JSON.stringify({ instruction: "after revoke" })
    });
    assert.equal(revoked.status, 401);

    const unknown = await fetch(`${base}/task/scout`, {
      method: "POST",
      headers: { ...bearer("eqc1_doesnotexist"), "content-type": "application/json" },
      body: JSON.stringify({ instruction: "bogus" })
    });
    assert.equal(unknown.status, 401);

    // Admin still works everywhere, including cross-teammate queueing.
    const adminPost = await fetch(`${base}/task/builder`, {
      method: "POST",
      headers: { ...bearer(ADMIN), "content-type": "application/json" },
      body: JSON.stringify({ instruction: "admin chore" })
    });
    assert.equal(adminPost.status, 202);
    assert.equal(store.getTask((await adminPost.json()).taskId).runSource, "webhook");
  });
});

test("m5 webhook: scoped credentials still obey the Origin guard", async () => {
  const store = seededStore(tmpRoot());
  const { mint } = store.issueTeammateCredential("scout");
  await withWebhook(store, async (base) => {
    const foreign = await fetch(`${base}/task/scout`, {
      method: "POST",
      headers: { ...bearer(mint), origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ instruction: "x" })
    });
    assert.equal(foreign.status, 403);
    assert.match((await foreign.json()).error, /cross-origin/i);
  });
});

// ---- cross-process freshness (the bug the live E2E caught) ----

test("m5 credentials: revocation in another process takes effect in a running server", () => {
  const root = tmpRoot();
  // Two independent store instances model the CLI and the running serve
  // process; both point at the same state directory.
  const serverSide = CompanionStore.open(root);
  serverSide.createTeammate({ name: "scout" });
  const { credential, mint } = serverSide.issueTeammateCredential("scout");

  // Warm the server's cache — a resolve before revocation.
  assert.equal(serverSide.resolveCredential(mint).id, credential.id);

  // A separate process (the CLI) revokes it.
  const cliSide = CompanionStore.open(root);
  cliSide.revokeCredential(credential.id);

  // The running server must observe the revocation without a restart.
  assert.equal(serverSide.resolveCredential(mint), null, "stale cache must not keep a revoked credential alive");
  assert.equal(serverSide.listCredentials()[0].revokedAt !== null, true);
});

test("m5 credentials: issuance in another process is picked up too", () => {
  const root = tmpRoot();
  const serverSide = CompanionStore.open(root);
  serverSide.createTeammate({ name: "scout" });
  assert.equal(serverSide.listCredentials().length, 0);

  const cliSide = CompanionStore.open(root);
  const { mint } = cliSide.issueTeammateCredential("scout");

  assert.equal(serverSide.listCredentials().length, 1);
  assert.equal(serverSide.resolveCredential(mint).teammate, "scout");
});
