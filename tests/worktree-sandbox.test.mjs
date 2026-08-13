import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createWorktree, isGitRepository, prepareWorktreeSandbox, removeWorktree, worktreePath } from "../src/worktree-sandbox.mjs";

function fakeGit(results) {
  const calls = [];
  const execImpl = (command, args, options, callback) => {
    calls.push({ command, args, options });
    const key = args[0] === "worktree" ? args[1] : args[0];
    const result = results[key];
    if (result?.ok) return callback(null, result.stdout ?? "", "");
    const error = new Error(result?.error ?? "git failed");
    error.code = "GIT_ERROR";
    return callback(error, "", result?.stderr ?? "");
  };
  return { execImpl, calls };
}

test("isGitRepository probes with rev-parse", async () => {
  const { execImpl, calls } = fakeGit({ "rev-parse": { ok: true } });
  assert.equal(await isGitRepository("/repo", { execImpl }), true);
  assert.equal(calls[0].args[0], "rev-parse");
  const { execImpl: bad } = fakeGit({ "rev-parse": { error: "not a repo" } });
  assert.equal(await isGitRepository("/repo", { execImpl: bad }), false);
});

test("createWorktree builds a detached worktree path under .pi/runtime/worktrees", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-wt-"));
  const { execImpl, calls } = fakeGit({ add: { ok: true } });
  const target = await createWorktree(root, "agent_1", { execImpl });
  assert.equal(target, worktreePath(root, "agent_1"));
  assert.ok(target.startsWith(path.join(root, ".pi", "runtime", "worktrees")));
  const add = calls.find((call) => call.args[0] === "worktree" && call.args[1] === "add");
  assert.deepEqual(add.args, ["worktree", "add", "--detach", target]);
  assert.equal(add.options.cwd, root);
});

test("removeWorktree force-removes and cleans leftovers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-wt-"));
  const target = worktreePath(root, "a1");
  fs.mkdirSync(target, { recursive: true });
  const { execImpl } = fakeGit({ remove: { ok: true } });
  await removeWorktree(root, "a1", { execImpl });
  assert.equal(fs.existsSync(target), false, "leftover dir removed");
});

test("prepareWorktreeSandbox returns null when not a git repository", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-wt-"));
  const { execImpl } = fakeGit({ "rev-parse": { error: "not a repo" } });
  assert.equal(await prepareWorktreeSandbox(root, "a1", { execImpl }), null);
});

test("prepareWorktreeSandbox falls back to null when worktree creation fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-wt-"));
  const { execImpl } = fakeGit({ "rev-parse": { ok: true }, add: { error: "invalid ref" } });
  assert.equal(await prepareWorktreeSandbox(root, "a1", { execImpl }), null);
});