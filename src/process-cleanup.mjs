// Unified process cleanup protocol (roadmap P0).
// Cancellation, timeout and exit must never leave residual subprocesses
// behind. This module provides a platform-aware process-tree kill, a
// registry of spawned children for session-shutdown sweeps, and an
// injectable kill strategy so unit tests never touch real processes.

import { execFile, spawn } from "node:child_process";
import os from "node:os";

const registry = new Map();
let nextToken = 0;

function defaultKill(pid, { signal = "SIGTERM" } = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve({ pid, killed: false, reason: "invalid-pid" });
    if (os.platform() === "win32") {
      // taskkill /T /F terminates the whole process tree on Windows.
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
        resolve({ pid, killed: !error, reason: error ? String(error.message) : null });
      });
    } else {
      // When spawned detached the child is a process-group leader; a
      // negative pid kills the whole group. Fall back to the direct pid.
      let killed = false;
      let reason = null;
      try {
        process.kill(-pid, signal);
        killed = true;
      } catch (error) {
        try {
          process.kill(pid, signal);
          killed = true;
        } catch (killError) {
          reason = String(killError?.message ?? killError);
        }
      }
      resolve({ pid, killed, reason });
    }
  });
}

/**
 * Kill a process tree. The kill strategy is injectable for tests; the
 * default uses taskkill /T /F on Windows and process-group SIGKILL elsewhere.
 */
export function killProcessTree(pid, options = {}) {
  const killImpl = options.killImpl ?? defaultKill;
  const signal = options.signal ?? "SIGKILL";
  return killImpl(pid, { signal });
}

export function registerChild({ pid, label, command = "", token }) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const key = token ?? `child-${++nextToken}`;
  registry.set(key, { pid, label: label ?? command.slice(0, 80), startedAt: new Date().toISOString() });
  return key;
}

export function unregisterChild(token) {
  return registry.delete(token);
}

export function registeredChildren() {
  return [...registry.values()];
}

/**
 * Sweep every registered child with the process-tree kill. Returns one
 * result per child; callers can log failures for diagnosis.
 */
export async function sweepRegisteredChildren(options = {}) {
  const killImpl = options.killImpl;
  const results = [];
  for (const [token, child] of [...registry]) {
    try {
      const outcome = await killProcessTree(child.pid, { killImpl });
      results.push({ token, ...child, ...outcome });
    } catch (error) {
      results.push({ token, ...child, killed: false, reason: String(error?.message ?? error) });
    } finally {
      registry.delete(token);
    }
  }
  return results;
}

/**
 * Spawn a child and track it in the registry so session shutdown can sweep
 * it. Returns the child; the caller keeps full ownership.
 */
export function spawnTracked({ command, args = [], options = {}, label, token, spawnImpl }) {
  const spawnFn = spawnImpl ?? spawn;
  const child = spawnFn(command, args, options);
  if (child?.pid) {
    const key = registerChild({ pid: child.pid, label, command, token });
    if (key) {
      child.once("exit", () => unregisterChild(key));
      child._equaxisCleanupToken = key;
    }
  }
  return child;
}

export function describeProcessCleanup() {
  return {
    strategy: os.platform() === "win32" ? "taskkill /T /F" : "process-group SIGKILL",
    registered: registry.size
  };
}