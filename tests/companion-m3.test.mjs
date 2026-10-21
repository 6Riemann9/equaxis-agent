import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { COMPANION_PWA_ASSETS } from "../src/companion-pwa.mjs";
import { CompanionStore } from "../src/companion-store.mjs";
import { startCompanionWebhook } from "../src/companion-webhook.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-m3-"));
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
  store.createTeammate({ name: "builder", persona: "ships things" });
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

/** Raw HTTP request with full header control (fetch/undici drops the Host header). */
function rawRequest({ base, method = "GET", path: requestPath = "/", headers = {} }) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, base);
    const req = http.request({ host: url.hostname, port: url.port, method, path: `${url.pathname}${url.search}`, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

// ---- PWA assets module ----

test("m3 pwa: assets module ships the full shell with safe content types", () => {
  const expected = ["/", "/app.js", "/sw.js", "/manifest.webmanifest", "/icon.svg"];
  assert.deepEqual(Object.keys(COMPANION_PWA_ASSETS).sort(), expected.sort());
  for (const asset of Object.values(COMPANION_PWA_ASSETS)) {
    assert.ok(asset.body.length > 0, "asset body must be non-empty");
    assert.match(asset.contentType, /^(text\/html|text\/javascript|application\/manifest\+json|image\/svg\+xml)/);
  }
  // The shell must reference the manifest and the script (PWA installability).
  assert.match(COMPANION_PWA_ASSETS["/"].body, /manifest\.webmanifest/);
  assert.match(COMPANION_PWA_ASSETS["/"].body, /app\.js/);
  // The manifest must be valid JSON with the required PWA fields.
  const manifest = JSON.parse(COMPANION_PWA_ASSETS["/manifest.webmanifest"].body);
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.display, "standalone");
  // No secrets embedded in any static asset.
  for (const [name, asset] of Object.entries(COMPANION_PWA_ASSETS)) {
    assert.ok(!asset.body.includes(TEST_CREDENTIAL), `asset ${name} must not contain the credential`);
  }
});

// ---- PWA routes ----

test("m3 webhook: the dashboard shell is served without auth; unknown paths are 404", async () => {
  const store = seededStore(tmpRoot());
  await withWebhook(store, async (base) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /text\/html/);
    assert.match(await index.text(), /<!doctype html>/i);
    assert.equal(index.headers.get("x-content-type-options"), "nosniff");

    const manifest = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get("content-type"), /application\/manifest\+json/);
    JSON.parse(await manifest.text());

    const sw = await fetch(`${base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.equal(sw.headers.get("cache-control"), "no-store");

    // Static routes are exact-match only: no traversal, no listing.
    const escape = await fetch(`${base}/..%2f..%2fetc%2fpasswd`, { headers: authHeaders() });
    assert.equal(escape.status, 404);
    const unknown = await fetch(`${base}/definitely-not-an-asset.js`, { headers: authHeaders() });
    assert.equal(unknown.status, 404);
  });
});

test("m3 webhook: servePwa=false disables the dashboard but keeps the API", async () => {
  const store = seededStore(tmpRoot());
  await withWebhook(store, async (base) => {
    const index = await fetch(`${base}/`, { headers: authHeaders() });
    assert.equal(index.status, 404);
    const status = await fetch(`${base}/status`, { headers: authHeaders() });
    assert.equal(status.status, 200);
  }, { servePwa: false });
});

// ---- /feed and /status detail ----

test("m3 webhook: GET /feed requires auth and returns recent entries (n clamped)", async () => {
  const store = seededStore(tmpRoot());
  for (let i = 1; i <= 3; i += 1) {
    store.appendFeed({ at: new Date(Date.UTC(2025, 0, i)).toISOString(), kind: "done", teammate: "scout", text: `entry ${i}` });
  }
  await withWebhook(store, async (base) => {
    const denied = await fetch(`${base}/feed`);
    assert.equal(denied.status, 401);

    const feed = await fetch(`${base}/feed`, { headers: authHeaders() });
    assert.equal(feed.status, 200);
    const body = await feed.json();
    assert.equal(body.entries.length, 3);
    assert.equal(body.entries[0].text, "entry 1");
    assert.equal(body.entries[2].text, "entry 3");

    const one = await fetch(`${base}/feed?n=1`, { headers: authHeaders() });
    const oneBody = await one.json();
    assert.equal(oneBody.entries.length, 1);
    assert.equal(oneBody.entries[0].text, "entry 3");

    const capped = await fetch(`${base}/feed?n=99999`, { headers: authHeaders() });
    assert.equal(capped.status, 200); // clamped server-side, never an error

    const garbage = await fetch(`${base}/feed?n=abc`, { headers: authHeaders() });
    assert.equal(garbage.status, 200);
  });
});

test("m3 webhook: GET /status gains teammateDetails (backward-compatible shape)", async () => {
  const store = seededStore(tmpRoot());
  const task = store.enqueue("scout", "survey config loading");
  const done = store.enqueue("scout", "check the release notes");
  store.complete(done.id, "all good");
  await withWebhook(store, async (base) => {
    const res = await fetch(`${base}/status`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    // Old field shape preserved for M2 clients.
    assert.deepEqual(body.teammates, ["scout", "builder"]);
    assert.equal(body.queue.pending, 1);
    assert.equal(body.queue.done, 1);

    const scout = body.teammateDetails.find((t) => t.name === "scout");
    assert.ok(scout, "scout detail present");
    assert.equal(scout.model, "sonnet");
    assert.equal(scout.pending, 1);
    assert.equal(scout.running, null);
    assert.equal(scout.lastTask.status, "done");
    assert.match(scout.lastTask.instruction, /release notes/);
    assert.ok(scout.lastTask.finishedAt);

    const builder = body.teammateDetails.find((t) => t.name === "builder");
    assert.equal(builder.lastTask, null);
    assert.equal(builder.pending, 0);
    assert.ok(task.id);
  });
});

// ---- Origin / Host policy with the dashboard in play ----

test("m3 webhook: same-origin requests pass the Origin guard; foreign origins stay refused", async () => {
  const store = seededStore(tmpRoot());
  await withWebhook(store, async (base) => {
    // Same-origin GET (the dashboard's own fetch) — allowed.
    const sameOrigin = await fetch(`${base}/status`, { headers: { ...authHeaders(), origin: base } });
    assert.equal(sameOrigin.status, 200);

    // Same-origin POST — the token alone is not enough without same-origin.
    const sameOriginPost = await fetch(`${base}/task/scout`, {
      method: "POST",
      headers: { ...authHeaders(), origin: base, "content-type": "application/json" },
      body: JSON.stringify({ instruction: "from the dashboard origin" })
    });
    assert.equal(sameOriginPost.status, 202);

    // Foreign origin — refused before auth even with a valid credential.
    const foreign = await fetch(`${base}/status`, { headers: { ...authHeaders(), origin: "https://evil.example" } });
    assert.equal(foreign.status, 403);
    const foreignBody = await foreign.json();
    assert.match(foreignBody.error, /cross-origin/i);

    // Garbage Origin header — refused, never a 500.
    const garbage = await rawRequest({ base, path: "/status", headers: { ...authHeaders(), origin: "::not a url::" } });
    assert.equal(garbage.status, 403);
  });
});

test("m3 webhook: extraHosts extend the Host allowlist for LAN phones", async () => {
  const store = seededStore(tmpRoot());
  // Without the declaration the LAN host is a foreign Host.
  await withWebhook(store, async (base, webhook) => {
    const lanHost = `192.168.1.50:${webhook.port}`;
    const refused = await rawRequest({ base, headers: { ...authHeaders(), host: lanHost } });
    assert.equal(refused.status, 403);
  });

  // Bare host (any port) — works even though the test binds an ephemeral port.
  const store2 = seededStore(tmpRoot());
  await withWebhook(store2, async (base, webhook) => {
    const lanHost = `192.168.1.50:${webhook.port}`;
    const allowed = await rawRequest({ base, headers: { ...authHeaders(), host: lanHost } });
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers["content-type"], /text\/html/); // dashboard shell

    // A matching Origin from that host is same-origin and passes.
    const withOrigin = await rawRequest({
      base,
      path: "/status",
      headers: { ...authHeaders(), host: lanHost, origin: `http://${lanHost}` }
    });
    assert.equal(withOrigin.status, 200);

    // Loopback still works alongside the LAN host.
    const loopback = await fetch(`${base}/status`, { headers: authHeaders() });
    assert.equal(loopback.status, 200);
  }, { extraHosts: ["192.168.1.50"] });
});

test("m3 webhook: pinned host:port entries only match that port; rebinding stays blocked", async () => {
  const store = seededStore(tmpRoot());
  await withWebhook(store, async (base, webhook) => {
    // Declared for a different port — must not match this listener.
    const wrongPort = await rawRequest({ base, headers: { ...authHeaders(), host: `mybox.local:${webhook.port}` } });
    assert.equal(wrongPort.status, 403);

    // DNS rebinding: the attacker's hostname in Host/Origin is never in the
    // allowlist, even with a valid credential.
    const rebind = await rawRequest({
      base,
      path: "/status",
      headers: { ...authHeaders(), host: "evil.example", origin: "http://evil.example" }
    });
    assert.equal(rebind.status, 403);
  }, { extraHosts: ["mybox.local:7890"] });

  // The declared port does match when it is the real one.
  const store2 = seededStore(tmpRoot());
  const fixed = await startCompanionWebhook({
    store: store2,
    credential: TEST_CREDENTIAL,
    port: 0,
    extraHosts: ["mybox.local:7890"]
  });
  try {
    const rebind2 = await rawRequest({
      base: `http://${fixed.host}:${fixed.port}`,
      headers: { ...authHeaders(), host: "mybox.local:7890", origin: "http://mybox.local:7890" }
    });
    assert.equal(rebind2.status, 200);
  } finally {
    await fixed.close();
  }
});

// The dashboard JS lives inside a template literal: a stray escape (e.g. "\n"
// written instead of "\\n") silently becomes a newline and breaks the browser
// only. Compiling the emitted assets catches it in CI.
test("m3 pwa: every emitted script is syntactically valid JS", () => {
  const vm = createRequire(import.meta.url)("node:vm");
  for (const assetPath of ["/app.js", "/sw.js"]) {
    const source = COMPANION_PWA_ASSETS[assetPath].body;
    assert.doesNotThrow(
      () => new vm.Script(source, { filename: assetPath }),
      `${assetPath} must compile`
    );
  }
  // Nothing in the shell may resolve to a template-escaped newline inside a
  // string literal (the failure mode above).
  const app = COMPANION_PWA_ASSETS["/app.js"].body;
  assert.equal(/join\("\n"\)/.test(app), false, 'app.js must use join("\\n"), not a literal newline');
});
