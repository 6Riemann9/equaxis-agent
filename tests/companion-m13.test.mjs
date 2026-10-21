import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listPendingApprovals, readApprovalDecision, writeApprovalRequest } from "../src/approval-queue.mjs";
import { COMPANION_PWA_ASSETS } from "../src/companion-pwa.mjs";
import { CompanionStore } from "../src/companion-store.mjs";
import { startCompanionWebhook } from "../src/companion-webhook.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-m13-"));
}

// A synthetic non-secret fixture value, built at runtime so no literal in
// this file resembles a real credential.
const ADMIN = ["fixture", "admin", "value", "for", "tests"].join("-");

function authHeaders() {
  return { authorization: `Bearer ${ADMIN}` };
}

function seeded(root) {
  const store = CompanionStore.open(path.join(root, "companion"));
  store.createTeammate({ name: "scout" });
  return store;
}

async function withWebhook(root, handler) {
  const store = seeded(root);
  const webhook = await startCompanionWebhook({
    store,
    credential: ADMIN,
    port: 0,
    projectRoot: root,
    traceDir: ".pi/runtime"
  });
  try {
    return await handler(`http://${webhook.host}:${webhook.port}`, store);
  } finally {
    await webhook.close();
  }
}

function park(root, requestId, overrides = {}) {
  writeApprovalRequest(root, ".pi/runtime", {
    requestId,
    toolName: "bash",
    reason: "recursive deletion",
    summary: "rm -rf /somewhere",
    ...overrides
  });
}

function decide(base, requestId, decision, headers = authHeaders()) {
  return fetch(`${base}/approval/${encodeURIComponent(requestId)}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ decision })
  });
}

// ---- listing ----

test("m13 approvals: the parked high-risk requests are listed for a human", async () => {
  const root = tmpRoot();
  park(root, "req-1", { toolName: "bash", reason: "recursive deletion" });
  park(root, "req-2", { toolName: "write", reason: "write outside the workspace", summary: "/etc/hosts" });

  await withWebhook(root, async (base) => {
    const res = await fetch(`${base}/approvals`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pending.length, 2);
    assert.deepEqual(body.pending.map((entry) => entry.requestId).sort(), ["req-1", "req-2"]);
    assert.ok(body.pending.every((entry) => typeof entry.ageMs === "number"));
    assert.deepEqual(body.history, []);
  });
});

test("m13 approvals: an empty queue is an empty list, never an error", async () => {
  const root = tmpRoot();
  await withWebhook(root, async (base) => {
    const body = await (await fetch(`${base}/approvals`, { headers: authHeaders() })).json();
    assert.deepEqual(body.pending, []);
  });
});

// ---- deciding ----

test("m13 approvals: approving writes the decision the harness polls for", async () => {
  const root = tmpRoot();
  park(root, "req-approve");
  await withWebhook(root, async (base) => {
    const res = await decide(base, "req-approve", "approve");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.decision, "approve");

    const decision = readApprovalDecision(root, ".pi/runtime", "req-approve");
    assert.equal(decision.decision, "approve");
    assert.ok(decision.decidedAt);

    // The request leaves the pending list and appears in history.
    const after = await (await fetch(`${base}/approvals`, { headers: authHeaders() })).json();
    assert.deepEqual(after.pending, []);
    assert.deepEqual(after.history.map((entry) => entry.requestId), ["req-approve"]);
  });
});

test("m13 approvals: denying is symmetric and equally durable", async () => {
  const root = tmpRoot();
  park(root, "req-deny");
  await withWebhook(root, async (base) => {
    assert.equal((await decide(base, "req-deny", "deny")).status, 200);
    assert.equal(readApprovalDecision(root, ".pi/runtime", "req-deny").decision, "deny");
    assert.deepEqual(listPendingApprovals(root, ".pi/runtime"), []);
  });
});

test("m13 approvals: unknown ids, bad decisions and cross-origin posts are refused", async () => {
  const root = tmpRoot();
  park(root, "req-guarded");
  await withWebhook(root, async (base) => {
    assert.equal((await decide(base, "req-never-existed", "approve")).status, 404);

    const bogus = await decide(base, "req-guarded", "maybe");
    assert.equal(bogus.status, 400);
    assert.match((await bogus.json()).error, /approve.*deny/);

    const foreign = await fetch(`${base}/approval/req-guarded`, {
      method: "POST",
      headers: { ...authHeaders(), origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" })
    });
    assert.equal(foreign.status, 403);

    // Nothing was decided by any of the refused calls.
    assert.equal(readApprovalDecision(root, ".pi/runtime", "req-guarded"), null);
    assert.equal(listPendingApprovals(root, ".pi/runtime").length, 1);
  });
});

test("m13 approvals: only the admin credential may list or decide", async () => {
  const root = tmpRoot();
  park(root, "req-auth");
  const store = seeded(root);
  const { mint } = store.issueTeammateCredential("scout");
  const webhook = await startCompanionWebhook({
    store,
    credential: ADMIN,
    port: 0,
    projectRoot: root,
    traceDir: ".pi/runtime"
  });
  try {
    const base = `http://${webhook.host}:${webhook.port}`;
    assert.equal((await fetch(`${base}/approvals`)).status, 401);
    const scopedList = await fetch(`${base}/approvals`, { headers: { authorization: `Bearer ${mint}` } });
    assert.equal(scopedList.status, 403);

    const scopedDecide = await decide(base, "req-auth", "approve", { authorization: `Bearer ${mint}` });
    assert.equal(scopedDecide.status, 403);
    assert.equal(readApprovalDecision(root, ".pi/runtime", "req-auth"), null, "a scoped credential can never self-approve");
  } finally {
    await webhook.close();
  }
});

// ---- dashboard ----

test("m13 pwa: the dashboard renders pending approvals with approve/deny", async () => {
  const vm = await import("node:vm");
  const js = COMPANION_PWA_ASSETS["/app.js"].body;
  assert.doesNotThrow(() => new vm.Script(js, { filename: "app.js" }));
  assert.match(js, /renderApprovals/);
  assert.match(js, /"\/approvals"/);
  assert.match(js, /class="approve primary"/);
  assert.match(js, /class="deny danger"/);
  // Nothing pending: the panel says so instead of showing an empty list, and
  // the sidebar badge is hidden.
  assert.match(js, /badge\.hidden = /);
  assert.match(js, /Nothing waiting/);
});
