// Git worktree sandbox for subagents (roadmap P0: worktree isolation).
// When enabled, a subagent runs in a detached git worktree so it cannot
// touch the main checkout. The worktree is created before the run and
// removed (force) afterwards; failures fall back to the normal cwd.

import fs from "node:fs";
import path from "node:path";

function execFilePromise(execImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    execImpl(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr ?? error?.message ?? error).trim().slice(0, 300);
        const wrapped = new Error(`git ${command} ${args.join(" ")}: ${detail || "failed"}`);
        wrapped.code = error?.code ?? "GIT_ERROR";
        reject(wrapped);
      } else {
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    });
  });
}

export function worktreePath(projectRoot, id) {
  return path.join(projectRoot, ".pi", "runtime", "worktrees", String(id).replace(/[^A-Za-z0-9_.-]/g, "_"));
}

export async function isGitRepository(projectRoot, options = {}) {
  const execImpl = options.execImpl ?? (await import("node:child_process")).execFile;
  try {
    await execFilePromise(execImpl, "git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectRoot, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Create a detached worktree; returns its absolute path. */
export async function createWorktree(projectRoot, id, options = {}) {
  const execImpl = options.execImpl ?? (await import("node:child_process")).execFile;
  const target = worktreePath(projectRoot, id);
  await execFilePromise(execImpl, "git", ["worktree", "add", "--detach", target], { cwd: projectRoot, windowsHide: true });
  return target;
}

/** Remove a worktree (force) and clean any leftover directory. Best-effort. */
export async function removeWorktree(projectRoot, id, options = {}) {
  const execImpl = options.execImpl ?? (await import("node:child_process")).execFile;
  const target = worktreePath(projectRoot, id);
  try {
    await execFilePromise(execImpl, "git", ["worktree", "remove", "--force", target], { cwd: projectRoot, windowsHide: true });
  } catch {
    // fall through: remove the leftover directory directly
  }
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

/**
 * Prepare a worktree sandbox; returns null when unavailable (not a repo or
 * git failure) so callers can fall back to the normal cwd.
 */
export async function prepareWorktreeSandbox(projectRoot, id, options = {}) {
  try {
    const isRepo = await isGitRepository(projectRoot, options);
    if (!isRepo) return null;
    return await createWorktree(projectRoot, id, options);
  } catch {
    return null;
  }
}