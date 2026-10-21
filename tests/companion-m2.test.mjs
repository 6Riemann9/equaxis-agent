import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CompanionStore } from "../src/companion-store.mjs";
import { buildBwrapArgs } from "../src/companion-sandbox.mjs";
import { startCompanionWebhook } from "../src/companion-webhook.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-m2-"));
}

// A synthetic non-secret fixture value, built at runtime so no literal in
// this file resembles a real credential.
const TEST_CREDENTIAL = ["fixture", "credential", "for", "tests"].join("-");

function authHeaders() {
  return { authorization: `Bearer ${TEST_CREDENTIAL}` };
}

function seededStore(root) {
  const store = CompanionStore.open(root);
  store.createTeammate({ name: "scout", persona: "researcher" });
  store.createTeammate({ name: "builder", persona: "ships things" });
  return store;
}

// ---- isolated HOME sandbox ----

test("m2 sandbox: homeDir mode binds a private writable HOME and seeds only credential files", () => {
  const args = buildBwrapArgs({
    workspace: "/proj/.pi/companion/workspaces/scout",
    projectRoot: "/proj",
    home: "/home/user",
    homeDir: "/proj/.pi/companion/home/scout"
  });
  const joined = args.join(" ");
  // The real HOME must NOT be bound at all in isolated mode.
  assert.ok(!joined.includes("--ro-bind /home/user /home/user"), "real HOME must be invisible in isolated mode");
  assert.ok(!joined.includes("--bind /home/user/.pi"), "real ~/.pi must not be writable in isolated mode");
  // The private HOME is writable and seeded read-only with the three Pi files.
  assert.match(joined, /--bind \/proj\/\.pi\/companion\/home\/scout \/proj\/\.pi\/companion\/home\/scout/);
  assert.match(joined, /--ro-bind-try \/home\/user\/\.pi\/agent\/auth\.json/);
  assert.match(joined, /--ro-bind-try \/home\/user\/\.pi\/agent\/models\.json/);
  assert.match(joined, /--ro-bind-try \/home\/user\/\.pi\/agent\/settings\.json/);
  // Workspace still writable on top of the ro project root.
  assert.match(joined, /--bind \/proj\/\.pi\/companion\/workspaces\/scout/);
  // Bind order: the ro project root must precede the writable homeDir bind,
  // which must precede the workspace bind (later binds shadow earlier ones).
  const projectBind = args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === "/proj");
  const homeBind = args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/proj/.pi/companion/home/scout");
  const workspaceBind = args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/proj/.pi/companion/workspaces/scout");
  assert.ok(projectBind >= 0 && homeBind > projectBind, "private HOME bind must shadow the read-only project root");
  assert.ok(workspaceBind > homeBind, "workspace bind comes last");
});

test("m2 sandbox: shared mode (no homeDir) keeps the M1 behavior", () => {
  const args = buildBwrapArgs({ workspace: "/w", projectRoot: "/proj", home: "/home/user" });
  const joined = args.join(" ");
  assert.match(joined, /--ro-bind \/home\/user \/home\/user/);
  assert.match(joined, /--bind \/home\/user\/\.pi \/home\/user\/\.pi/);
});

// ---- store: teammate home + webhook credential ----

test("m2 store: teammateHome is per-name under .pi/companion/home", () => {
  const store = seededStore(tmpRoot());
  const home = store.teammateHome(store.getTeammate("scout"), "/proj");
  assert.equal(home, path.join("/proj", ".pi", "companion", "home", "scout"));
});

test("m2 store: webhook credential is issued once and stays stable", () => {
  const store = seededStore(tmpRoot());
  const file = store.webhookCredentialFile();
  assert.ok(!fs.existsSync(file), "no credential before first use");
  store.issueWebhookCredential();
  const first = fs.readFileSync(file, "utf8");
  assert.ok(first.trim().length >= 32, "credential has entropy");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "credential file is owner-only");
  assert.throws(() => store.issueWebhookCredential(), /EEXIST|file exists/, "second issue refuses to overwrite");
});

// ---- webhook ----

async function withWebhook(store, handler) {
  const webhook = await startCompanionWebhook({ store, credential: TEST_CREDENTIAL, port: 0 });
  try {
    return await handler(`http://${webhook.host}:${webhook.port}`, webhook);
  } finally {
    await webhook.close();
  }
}

test("m2 webhook: POST /task enqueues with runSource webhook; GET /status summarizes", async () => {
  const store = seededStore(tmpRoot());
  await withWebhook(store, async (base) => {
    const res = await fetch(`${base}/task/scout`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ instruction: "check the webhook" })
    });
    assert.equal(res.status, 202);
    const payload = await res.json();
    assert.equal(payload.teammate, "scout");
    assert.equal(store.getTask(payload.taskId).runSource, "webhook");
    assert.equal(store.getTask(payload.taskId).instruction, "check the webhook");

    const status = await fetch(`${base}/status`, { headers: authHeaders() });
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.deepEqual(body.teammates, ["scout", "builder"]);
    assert.equal(body.queue.pending, 1);
  });
});

test("m2 webhook: requests without the credential are rejected on every state-changing route", async () => {
  const store = seededStore(tmpRoot());
  await withWebhook(store, async (base) => {
    const post = await fetch(`${base}/task/scout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "x" })
    });
    assert.equal(post.status, 401);
    const status = await fetch(`${base}/status`);
    assert.equal(status.status, 401);
    // healthz stays open (liveness probe)
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
  });
});

/** Raw HTTP request with full header control (fetch/undici drops the Host header). */
function rawRequest({ base, method = "GET", path: requestPath = "/status", headers = {} }) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, base);
    const req = http.request({ host: url.hostname, port: url.port, method, path: `${url.pathname}${url.search}`, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("m2 webhook: Origin-bearing and foreign-Host requests are refused before auth", async () => {
  const store = seededStore(tmpRoot());
  await withWebhook(store, async (base) => {
    const withOrigin = await fetch(`${base}/task/scout`, {
      method: "POST",
      headers: { origin: "https://evil.example", ...authHeaders() },
      body: "{}"
    });
    assert.equal(withOrigin.status, 403);
    const withOriginBody = await withOrigin.json();
    // M3 relaxed the blanket Origin refusal into a same-origin allowlist;
    // a foreign origin must still be refused before auth (message updated
    // from the M2 wording to distinguish cross-origin from Host refusal).
    assert.match(withOriginBody.error, /cross-origin/i);

    const foreignHost = await rawRequest({ base, headers: { ...authHeaders(), host: "evil.example" } });
    assert.equal(foreignHost.status, 403);
  });
});

test("m2 webhook: bad payloads and unknown teammates are 4xx, never 500", async () => {
  const store = seededStore(tmpRoot());
  await withWebhook(store, async (base) => {
    const auth = authHeaders();
    const notJson = await fetch(`${base}/task/scout`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "not json" });
    assert.equal(notJson.status, 400);
    const empty = await fetch(`${base}/task/scout`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(empty.status, 400);
    const unknown = await fetch(`${base}/task/ghost`, { method: "POST", headers: auth, body: JSON.stringify({ instruction: "x" }) });
    assert.equal(unknown.status, 404);
    const notFound = await fetch(`${base}/nope`, { headers: auth });
    assert.equal(notFound.status, 404);
  });
});
