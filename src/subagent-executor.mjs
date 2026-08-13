import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { killProcessTree, spawnTracked } from "./process-cleanup.mjs";
import { prepareRuntimeIsolation } from "./runtime-isolation.mjs";

/**
 * Real subagent executor that runs Pi in JSON mode as a subprocess per agent.
 *
 * The executor is the "effect" a SubagentRuntime schedules. This module keeps
 * the subprocess plumbing isolated so the runtime stays deterministic and the
 * spawn is injectable for tests. Pi JSON mode writes its final reply to stdout;
 * we also expose stderr for diagnostics.
 */

export function createPiJsonExecutor(options = {}) {
  const nodePath = options.nodePath ?? process.execPath;
  const piEntry = options.piEntry;
  if (!piEntry) throw new Error("piEntry is required");
  const spawnImpl = options.spawnImpl ?? spawn;
  const baseArgs = options.args ?? [];
  const projectRoot = options.projectRoot ?? process.cwd();
  const cwd = options.cwd ?? projectRoot;
  const baseEnv = { ...process.env, ...(options.env ?? {}) };
  const isolation = options.isolation ?? { enabled: true };
  // Failed subagent output is spilled to this directory (DSH-style): the
  // error message carries the tail plus the artifact path so diagnosis does
  // not require keeping unbounded output in memory.
  const artifactDir = options.artifactDir ?? path.join(projectRoot, ".pi", "runtime", "subagents", "artifacts");

  function spillFailure(task, { code, stdout, stderr }) {
    try {
      fs.mkdirSync(artifactDir, { recursive: true });
      const filePath = path.join(artifactDir, `${task.id}-attempt${task.attempt ?? 1}.out`);
      fs.writeFileSync(filePath, `--- pi json subprocess exited ${code} ---\n\n=== stdout ===\n${stdout}\n\n=== stderr ===\n${stderr}\n`, "utf8");
      return path.relative(projectRoot, filePath);
    } catch {
      return null;
    }
  }

  return async function piJsonExecutor(task, { signal } = {}) {
    if (!task?.prompt) throw new Error("subagent prompt is required");
    const args = [piEntry, ...baseArgs, "--mode", "json", task.prompt];
    return new Promise((resolve, reject) => {
      const spawnOptions = isolation.enabled === false
        ? { cwd, env: baseEnv }
        : prepareRuntimeIsolation({
            projectRoot,
            cwd,
            env: baseEnv,
            kind: "subagent",
            id: task.id,
            outputRoot: isolation.outputRoot ?? path.join(".pi", "runtime", "isolated"),
            scrubEnv: isolation.scrubEnv,
            extraEnvAllowlist: isolation.extraEnvAllowlist,
            extraEnv: isolation.extraEnv,
            allowSecretExtraEnv: isolation.allowSecretExtraEnv
          });
      const child = spawnTracked({
        command: nodePath,
        args,
        options: { cwd: spawnOptions.cwd, env: spawnOptions.env, stdio: ["ignore", "pipe", "pipe"] },
        label: `subagent:${task.id}`,
        spawnImpl
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (error) => {
        if (settled) return;
        settled = true;
        // Kill the whole process tree so grandchildren (shells, servers)
        // cannot outlive the subagent on cancel/timeout/exit.
        if (child?.pid) void killProcessTree(child.pid);
        if (error) return reject(error);
        resolve({ ok: true, id: task.id, label: task.label, output: stdout.trim(), stderr: stderr.trim() });
      };
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (error) => done(error));
      child.on("close", (code) => {
        if (signal?.aborted) return done(new Error("cancelled"));
        if (code === 0) return done(undefined);
        const artifact = spillFailure(task, { code, stdout, stderr });
        const tail = stderr.trim().slice(-400);
        const detail = artifact ? ` (full output: ${artifact})` : "";
        done(new Error(`pi json subprocess exited ${code}: ${tail}${detail}`));
      });
      if (signal) {
        signal.addEventListener("abort", () => {
          if (child?.pid) void killProcessTree(child.pid, { signal: "SIGTERM" });
          done(new Error("cancelled"));
        }, { once: true });
      }
    });
  };
}
