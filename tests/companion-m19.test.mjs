import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { COMPANION_PWA_ASSETS } from "../src/companion-pwa.mjs";
import { CompanionStore } from "../src/companion-store.mjs";
import { startCompanionWebhook } from "../src/companion-webhook.mjs";
import {
  buildTaskPatch,
  captureBaseline,
  captureResult,
  findLaterTouches,
  readManifest,
  revertTask,
  toUnifiedPatch
} from "../src/companion-artifacts.mjs";

const ADMIN = ["fixture", "admin", "value"].join("-");
function authHeaders() { return { authorization: `Bearer ${ADMIN}` }; }

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-m19-"));
}

function write(dir, relPath, content) {
  const target = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function readOrNull(dir, relPath) {
  try {
    return fs.readFileSync(path.join(dir, relPath), "utf8");
  } catch {
    return null;
  }
}

/** A task that changed: one file modified, one added, one deleted. */
function scenario({ taskId = "task-1" } = {}) {
  const root = tmpRoot();
  const ws = path.join(root, "ws");
  write(ws, "keep.md", "unchanged\n");
  write(ws, "change.md", "one\ntwo\nthree\n");
  write(ws, "gone.md", "was here\n");
  captureBaseline(root, taskId, ws);
  write(ws, "change.md", "one\nTWO\nthree\nfour\n");
  write(ws, "new.md", "brand new\n");
  fs.rmSync(path.join(ws, "gone.md"));
  const manifest = captureResult(root, taskId, ws);
  return { root, ws, manifest, taskId };
}

// ---- patch generation ----

test("m19 patch: added, modified and deleted files each produce a patch", () => {
  const { root, ws, taskId } = scenario();
  const result = buildTaskPatch({ rootDir: root, taskId, workspace: ws });
  assert.equal(result.ok, true);
  assert.match(result.patch, /--- a\/change\.md/);
  assert.match(result.patch, /\+TWO/);
  // A new file is created from /dev/null — that is what makes git apply create it.
  assert.match(result.patch, /--- \/dev\/null/);
  assert.match(result.patch, /\+\+\+ b\/new\.md/);
  assert.match(result.patch, /\+brand new/, "an added file is all additions");
  assert.match(result.patch, /--- a\/gone\.md/);
  assert.match(result.patch, /-was here/, "a deleted file is all removals");
  assert.deepEqual(result.skipped, []);
});

test("m19 patch: the output is a patch git can actually apply", () => {
  const { root, ws, taskId } = scenario();
  const { patch } = buildTaskPatch({ rootDir: root, taskId, workspace: ws });

  // Rebuild the ORIGINAL workspace in a git repo, apply the patch, and compare
  // against the task's real result. This is the only honest test of a patch.
  const repo = tmpRoot();
  write(repo, "keep.md", "unchanged\n");
  write(repo, "change.md", "one\ntwo\nthree\n");
  write(repo, "gone.md", "was here\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: repo });

  fs.writeFileSync(path.join(repo, "task.patch"), patch, "utf8");
  execFileSync("git", ["apply", "--check", "task.patch"], { cwd: repo });
  execFileSync("git", ["apply", "task.patch"], { cwd: repo });

  assert.equal(readOrNull(repo, "change.md"), readOrNull(ws, "change.md"), "modified file matches");
  assert.equal(readOrNull(repo, "new.md"), readOrNull(ws, "new.md"), "added file matches");
  assert.equal(readOrNull(repo, "gone.md"), null, "deleted file is gone");
  assert.equal(readOrNull(repo, "keep.md"), "unchanged\n", "an untouched file is left alone");
});

test("m19 patch: multi-hunk changes stay apply-able", () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const after = before.replace("line 3", "line 3 CHANGED").replace("line 35", "line 35 CHANGED");
  const patch = toUnifiedPatch({ relPath: "big.txt", beforeText: before, afterText: after });
  assert.equal((patch.match(/^@@/gm) ?? []).length, 2, "far-apart edits become two hunks");

  const repo = tmpRoot();
  write(repo, "big.txt", before);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "p.patch"), patch, "utf8");
  execFileSync("git", ["apply", "p.patch"], { cwd: repo });
  assert.equal(fs.readFileSync(path.join(repo, "big.txt"), "utf8"), after);
});

test("m19 patch: files that are not text are reported, never silently dropped", () => {
  const root = tmpRoot();
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws, { recursive: true });
  captureBaseline(root, "task-bin", ws);
  write(ws, "image.png", "not really a png");
  write(ws, "huge.txt", "x".repeat(300 * 1024));
  captureResult(root, "task-bin", ws);
  const result = buildTaskPatch({ rootDir: root, taskId: "task-bin", workspace: ws });
  assert.equal(result.ok, true);
  assert.equal(result.skipped.length, 2, "both are reported as skipped");
  assert.ok(result.skipped.every((entry) => /binary or oversized/.test(entry.reason)));
  assert.equal(result.patch, "", "nothing to apply");
});

test("m19 patch: a task with no manifest reports why", () => {
  const root = tmpRoot();
  const result = buildTaskPatch({ rootDir: root, taskId: "nope", workspace: root });
  assert.equal(result.ok, false);
  assert.match(result.error, /no artifacts/);
});

// ---- revert ----

test("m19 revert: restores modified, removes added, recreates deleted", () => {
  const { root, ws, taskId } = scenario();
  const result = revertTask({ rootDir: root, taskId, workspace: ws });
  assert.equal(result.ok, true);
  assert.deepEqual(result.restored.sort(), ["change.md", "gone.md"]);
  assert.deepEqual(result.removed, ["new.md"]);
  assert.equal(readOrNull(ws, "change.md"), "one\ntwo\nthree\n", "modified file is back to the baseline");
  assert.equal(readOrNull(ws, "new.md"), null, "the added file is gone");
  assert.equal(readOrNull(ws, "gone.md"), "was here\n", "the deleted file is restored");
  assert.equal(readOrNull(ws, "keep.md"), "unchanged\n", "untouched files stay untouched");
});

test("m19 revert: refuses when a later task changed the same files, unless forced", () => {
  const root = tmpRoot();
  const ws = path.join(root, "ws");
  write(ws, "shared.md", "v1\n");
  captureBaseline(root, "task-a", ws);
  write(ws, "shared.md", "v2 from task a\n");
  captureResult(root, "task-a", ws);

  // A later task touches the same file.
  captureBaseline(root, "task-b", ws);
  write(ws, "shared.md", "v3 from task b\n");
  captureResult(root, "task-b", ws);

  const tasks = [{ id: "task-a", status: "done" }, { id: "task-b", status: "done" }];
  const refused = revertTask({ rootDir: root, taskId: "task-a", workspace: ws, tasks });
  assert.equal(refused.ok, false);
  assert.equal(refused.conflict, true);
  assert.match(refused.error, /later tasks changed the same files/);
  assert.equal(readOrNull(ws, "shared.md"), "v3 from task b\n", "the newer work is untouched");
  assert.deepEqual(refused.later.map((entry) => entry.taskId), ["task-b"]);

  const forced = revertTask({ rootDir: root, taskId: "task-a", workspace: ws, tasks, force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  assert.equal(readOrNull(ws, "shared.md"), "v1\n", "forcing really does roll it back");
});

test("m19 revert: removing an addition needs no baseline, restoring a deletion does", () => {
  const root = tmpRoot();
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws, { recursive: true });
  write(ws, "doomed.bin", "z".repeat(100 * 1024)); // too large to capture
  captureBaseline(root, "task-x", ws);

  // The task adds one file and deletes an uncaptured one.
  write(ws, "added.bin", "y".repeat(100 * 1024));
  fs.rmSync(path.join(ws, "doomed.bin"));
  captureResult(root, "task-x", ws);

  const result = revertTask({ rootDir: root, taskId: "task-x", workspace: ws });
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, ["added.bin"], "an addition is removed without needing a baseline copy");
  assert.equal(fs.existsSync(path.join(ws, "added.bin")), false);
  // The deletion cannot be undone, and the caller is told rather than left with
  // a silently incomplete revert.
  assert.deepEqual(result.skipped.map((entry) => entry.path), ["doomed.bin"]);
  assert.match(result.skipped[0].reason, /not captured as text/);
});

test("m19 revert: findLaterTouches only reports tasks that share a path", () => {
  const root = tmpRoot();
  const ws = path.join(root, "ws");
  write(ws, "a.md", "1\n");
  captureBaseline(root, "t1", ws);
  write(ws, "a.md", "2\n");
  captureResult(root, "t1", ws);
  captureBaseline(root, "t2", ws);
  write(ws, "unrelated.md", "x\n");
  captureResult(root, "t2", ws);
  captureBaseline(root, "t3", ws);
  write(ws, "a.md", "3\n");
  captureResult(root, "t3", ws);

  const tasks = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];
  const touches = findLaterTouches(root, "t1", ["a.md"], { tasks });
  assert.deepEqual(touches.map((entry) => entry.taskId), ["t3"]);
  assert.deepEqual(touches[0].paths, ["a.md"]);
  assert.equal(findLaterTouches(root, "t1", ["a.md"], { tasks: [{ id: "t1" }] }).length, 0);
  assert.ok(readManifest(root, "t1"));
});

// ---- HTTP surface ----

test("m19 http: the patch route serves a git-apply-able diff and the revert route undoes it", async () => {
  const root = tmpRoot();
  const storeRoot = path.join(root, "companion");
  fs.mkdirSync(storeRoot, { recursive: true });
  const store = CompanionStore.open(storeRoot);
  store.createTeammate({ name: "builder", workspace: "ws" });
  const task = store.enqueue("builder", "write a file");
  const ws = store.teammateDirectory(store.getTeammate("builder"), root);

  write(ws, "made.md", "version one\n");
  captureBaseline(storeRoot, task.id, ws);
  write(ws, "made.md", "version two\n");
  captureResult(storeRoot, task.id, ws);
  store.complete(task.id, "done");

  const webhook = await startCompanionWebhook({ store, credential: ADMIN, port: 0, projectRoot: root });
  try {
    const base = `http://${webhook.host}:${webhook.port}`;
    const patchRes = await fetch(`${base}/patch/${task.id}`, { headers: authHeaders() });
    assert.equal(patchRes.status, 200);
    assert.match(patchRes.headers.get("content-type"), /text\/x-patch/);
    const patch = await patchRes.text();
    assert.match(patch, /--- a\/made\.md/);
    assert.match(patch, /-version one/);
    assert.match(patch, /\+version two/);

    // Apply the served patch to a fresh repo and compare with the workspace.
    const repo = tmpRoot();
    write(repo, "made.md", "version one\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "p.patch"), patch, "utf8");
    execFileSync("git", ["apply", "p.patch"], { cwd: repo });
    assert.equal(readOrNull(repo, "made.md"), "version two\n");

    // Auth is required on both routes.
    assert.equal((await fetch(`${base}/patch/${task.id}`)).status, 401);
    assert.equal((await fetch(`${base}/revert/${task.id}`, { method: "POST" })).status, 401);

    const reverted = await fetch(`${base}/revert/${task.id}`, { method: "POST", headers: authHeaders() });
    assert.equal(reverted.status, 200);
    const body = await reverted.json();
    assert.deepEqual(body.restored, ["made.md"]);
    assert.equal(readOrNull(ws, "made.md"), "version one\n", "the workspace is back to the baseline");

    assert.equal((await fetch(`${base}/patch/00000000-0000-0000-0000-000000000000`, { headers: authHeaders() })).status, 404);
  } finally {
    await webhook.close();
  }
});

test("m19 pwa: the files panel offers a patch link and a revert button", async () => {
  const vm = await import("node:vm");
  const js = COMPANION_PWA_ASSETS["/app.js"].body;
  assert.doesNotThrow(() => new vm.Script(js, { filename: "app.js" }));
  assert.match(js, /\/patch\//);
  assert.match(js, /revert-task/);
  assert.match(js, /\/revert\//);
});
