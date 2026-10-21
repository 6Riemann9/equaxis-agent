import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  artifactDiff,
  captureBaseline,
  captureResult,
  formatArtifactSummary,
  lineDiff,
  readManifest,
  resolveArtifactFile,
  snapshotWorkspace
} from "../src/companion-artifacts.mjs";
import { COMPANION_PWA_ASSETS } from "../src/companion-pwa.mjs";
import { CompanionStore } from "../src/companion-store.mjs";
import { runCompanionWorker } from "../src/companion-runtime.mjs";
import { startCompanionWebhook } from "../src/companion-webhook.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-m14-"));
}

// A synthetic non-secret fixture value, built at runtime so no literal in
// this file resembles a real credential.
const ADMIN = ["fixture", "admin", "value", "for", "tests"].join("-");

function authHeaders() {
  return { authorization: `Bearer ${ADMIN}` };
}

function write(dir, relPath, content) {
  const target = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

// ---- snapshots ----

test("m14 artifacts: snapshot lists files and ignores build/vcs noise", () => {
  const ws = tmpRoot();
  write(ws, "notes.md", "hello");
  write(ws, "src/app.js", "console.log(1)");
  write(ws, "node_modules/pkg/index.js", "ignored");
  write(ws, ".git/config", "ignored");
  write(ws, "dist/bundle.js", "ignored");

  const snapshot = snapshotWorkspace(ws);
  assert.deepEqual([...snapshot.keys()].sort(), ["notes.md", "src/app.js"]);
  assert.equal(snapshot.get("notes.md").size, 5);
});

// ---- baseline → result ----

test("m14 artifacts: added, modified and deleted files are detected", () => {
  const root = tmpRoot();
  const ws = path.join(root, "ws");
  write(ws, "keep.md", "unchanged");
  write(ws, "change.md", "before line");
  write(ws, "gone.md", "to be removed");

  captureBaseline(root, "task-1", ws);

  write(ws, "new.md", "brand new");
  write(ws, "change.md", "after line, longer than before");
  fs.rmSync(path.join(ws, "gone.md"));

  const manifest = captureResult(root, "task-1", ws);
  assert.deepEqual(manifest.counts, { added: 1, modified: 1, deleted: 1 });
  assert.deepEqual(manifest.added.map((entry) => entry.path), ["new.md"]);
  assert.deepEqual(manifest.modified.map((entry) => entry.path), ["change.md"]);
  assert.deepEqual(manifest.deleted.map((entry) => entry.path), ["gone.md"]);
  assert.equal(manifest.modified[0].diffable, true);
  assert.equal(formatArtifactSummary(manifest), "1 added, 1 modified, 1 deleted");

  // Persisted and reloadable by the API.
  assert.deepEqual(readManifest(root, "task-1").counts, manifest.counts);
  assert.equal(readManifest(root, "missing-task"), null);
});

test("m14 artifacts: an unchanged workspace reports nothing, not a false change", () => {
  const root = tmpRoot();
  const ws = path.join(root, "ws");
  write(ws, "stable.md", "same");
  captureBaseline(root, "task-2", ws);
  const manifest = captureResult(root, "task-2", ws);
  assert.deepEqual(manifest.counts, { added: 0, modified: 0, deleted: 0 });
  assert.equal(formatArtifactSummary(manifest), "no files changed");
});

test("m14 artifacts: binary-ish and oversized files are listed but not diffable", () => {
  const root = tmpRoot();
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws, { recursive: true });
  captureBaseline(root, "task-3", ws);
  write(ws, "image.png", "not really a png");
  write(ws, "huge.txt", "x".repeat(300 * 1024));
  const manifest = captureResult(root, "task-3", ws);
  const byPath = new Map(manifest.added.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get("image.png").diffable, false, "unknown extension is not diffed");
  assert.equal(byPath.get("huge.txt").diffable, false, "oversized text is not diffed");
});

// ---- diffs ----

test("m14 artifacts: lineDiff marks added, removed and context lines", () => {
  const hunks = lineDiff("a\nb\nc", "a\nB\nc");
  const kinds = hunks.map((hunk) => hunk.type);
  assert.ok(kinds.includes("removed"));
  assert.ok(kinds.includes("added"));
  assert.equal(hunks.filter((hunk) => hunk.type === "context").length, 2);
  assert.deepEqual(hunks.filter((hunk) => hunk.type !== "context").map((hunk) => hunk.text), ["b", "B"]);
});

test("m14 artifacts: artifactDiff works for modified and added files, refuses unknown paths", () => {
  const root = tmpRoot();
  const ws = path.join(root, "ws");
  write(ws, "doc.md", "one\ntwo\n");
  captureBaseline(root, "task-4", ws);
  write(ws, "doc.md", "one\ntwo\nthree\n");
  write(ws, "fresh.md", "brand new\n");
  captureResult(root, "task-4", ws);

  const modified = artifactDiff({ rootDir: root, taskId: "task-4", workspace: ws, relPath: "doc.md" });
  assert.equal(modified.ok, true);
  assert.equal(modified.mode, "modified");
  assert.ok(modified.hunks.some((hunk) => hunk.type === "added" && hunk.text === "three"));

  const added = artifactDiff({ rootDir: root, taskId: "task-4", workspace: ws, relPath: "fresh.md" });
  assert.equal(added.mode, "added");
  assert.deepEqual(added.hunks.map((hunk) => hunk.text), ["brand new", ""]);

  const unknown = artifactDiff({ rootDir: root, taskId: "task-4", workspace: ws, relPath: "../etc/passwd" });
  assert.equal(unknown.ok, false);
});

test("m14 artifacts: reads are confined to the workspace and to the manifest", () => {
  const root = tmpRoot();
  const ws = path.join(root, "ws");
  write(ws, "ok.md", "fine");
  captureBaseline(root, "task-5", ws);
  write(ws, "ok.md", "fine, edited");
  captureResult(root, "task-5", ws);

  const inside = resolveArtifactFile({ rootDir: root, taskId: "task-5", workspace: ws, relPath: "ok.md" });
  assert.equal(inside, path.join(ws, "ok.md"));

  // Traversal, absolute paths and unlisted files are all refused.
  assert.equal(resolveArtifactFile({ rootDir: root, taskId: "task-5", workspace: ws, relPath: "../../etc/passwd" }), null);
  assert.equal(resolveArtifactFile({ rootDir: root, taskId: "task-5", workspace: ws, relPath: "/etc/passwd" }), null);
  assert.equal(resolveArtifactFile({ rootDir: root, taskId: "task-5", workspace: ws, relPath: "not-listed.md" }), null);
  assert.equal(resolveArtifactFile({ rootDir: root, taskId: "unknown", workspace: ws, relPath: "ok.md" }), null);
});

// ---- worker integration ----

test("m14 artifacts: a real worker run records the files it changed", async () => {
  const root = tmpRoot();
  const store = CompanionStore.open(path.join(root, "companion"));
  const teammate = store.createTeammate({ name: "scout", workspace: "ws" });
  const projectRoot = path.dirname(path.join(root, "companion"));
  // Same path the worker will use: teammateDirectory(projectRoot) puts
  // workspaces under <project>/.pi/companion/workspaces.
  const ws = store.teammateDirectory(teammate, projectRoot);
  write(ws, "existing.md", "before");

  store.enqueue("scout", "make changes");
  await runCompanionWorker({
    store,
    once: true,
    maxTasks: 1,
    projectRoot,
    executor: async (_task, ctx) => {
      write(ctx.workspacePath, "existing.md", "after (changed)");
      write(ctx.workspacePath, "made.txt", "new file");
      return "done\nRESULT: changed things";
    }
  });

  const task = store.listTasks({}).find((entry) => entry.status === "done");
  assert.ok(task.artifacts, "the task carries an artifact summary");
  assert.deepEqual(task.artifacts.counts, { added: 1, modified: 1, deleted: 0 });

  const manifest = readManifest(store.rootDir, task.id);
  assert.deepEqual(manifest.added.map((entry) => entry.path), ["made.txt"]);
});

// ---- HTTP surface ----

async function withWebhook(root, handler) {
  const store = CompanionStore.open(path.join(root, "companion"));
  if (!store.getTeammate("scout")) store.createTeammate({ name: "scout", workspace: "ws" });
  const webhook = await startCompanionWebhook({ store, credential: ADMIN, port: 0, projectRoot: path.dirname(path.join(root, "companion")) });
  try {
    return await handler(`http://${webhook.host}:${webhook.port}`, store);
  } finally {
    await webhook.close();
  }
}

test("m14 artifacts: the HTTP surface serves the manifest, a diff and the raw file", async () => {
  const root = tmpRoot();
  const storeRoot = path.join(root, "companion");
  fs.mkdirSync(storeRoot, { recursive: true });
  const store = CompanionStore.open(storeRoot);
  store.createTeammate({ name: "scout", workspace: "ws" });
  const task = store.enqueue("scout", "change files");
  const ws = path.join(storeRoot, "workspaces", "ws");

  write(ws, "readme.md", "old\n");
  captureBaseline(storeRoot, task.id, ws);
  write(ws, "readme.md", "old\nnew line\n");
  const manifest = captureResult(storeRoot, task.id, ws);
  store.recordArtifacts(task.id, { counts: manifest.counts, capturedAt: manifest.capturedAt });

  await withWebhook(root, async (base) => {
    const listed = await fetch(`${base}/artifacts/${task.id}`, { headers: authHeaders() });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).counts, { added: 0, modified: 1, deleted: 0 });

    const diff = await fetch(`${base}/artifact/${task.id}/diff?path=readme.md`, { headers: authHeaders() });
    assert.equal(diff.status, 200);
    const body = await diff.json();
    assert.equal(body.mode, "modified");
    assert.ok(body.hunks.some((hunk) => hunk.type === "added" && hunk.text === "new line"));

    const raw = await fetch(`${base}/artifact/${task.id}/raw?path=readme.md`, { headers: authHeaders() });
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get("content-disposition"), /attachment; filename="readme.md"/);
    assert.equal(await raw.text(), "old\nnew line\n");

    // Auth + traversal are refused on both read routes.
    assert.equal((await fetch(`${base}/artifacts/${task.id}`)).status, 401);
    const escape = await fetch(`${base}/artifact/${task.id}/raw?path=${encodeURIComponent("../../etc/passwd")}`, { headers: authHeaders() });
    assert.equal(escape.status, 404);
    const unlisted = await fetch(`${base}/artifact/${task.id}/diff?path=secret.md`, { headers: authHeaders() });
    assert.equal(unlisted.status, 400);

    const unknownTask = await fetch(`${base}/artifacts/00000000-0000-0000-0000-000000000000`, { headers: authHeaders() });
    assert.equal(unknownTask.status, 404);
  });
});

test("m14 artifacts: the thread carries artifact counts so the dashboard can offer files", async () => {
  const root = tmpRoot();
  const storeRoot = path.join(root, "companion");
  fs.mkdirSync(storeRoot, { recursive: true });
  const store = CompanionStore.open(storeRoot);
  store.createTeammate({ name: "scout", workspace: "ws" });
  const task = store.enqueue("scout", "change");
  store.recordArtifacts(task.id, { counts: { added: 2, modified: 0, deleted: 1 }, capturedAt: new Date().toISOString() });
  store.complete(task.id, "ok");

  await withWebhook(root, async (base) => {
    const thread = await (await fetch(`${base}/thread/scout`, { headers: authHeaders() })).json();
    assert.deepEqual(thread.turns[0].artifacts.counts, { added: 2, modified: 0, deleted: 1 });
  });
});

test("m14 artifacts: the dashboard wires a files view with diff and download", async () => {
  const vm = await import("node:vm");
  const js = COMPANION_PWA_ASSETS["/app.js"].body;
  assert.doesNotThrow(() => new vm.Script(js, { filename: "app.js" }));
  assert.match(js, /show-files/);
  assert.match(js, /\/artifacts\//);
  assert.match(js, /\/diff\?path=/);
  assert.match(js, /\/raw\?path=/);
  assert.match(js, /artifactLabel/);
});
