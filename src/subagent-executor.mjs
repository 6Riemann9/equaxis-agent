import { spawn } from "node:child_process";
import path from "node:path";
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
      const child = spawnImpl(nodePath, args, { cwd: spawnOptions.cwd, env: spawnOptions.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (error) => {
        if (settled) return;
        settled = true;
        child.kill();
        if (error) return reject(error);
        resolve({ ok: true, id: task.id, label: task.label, output: stdout.trim(), stderr: stderr.trim() });
      };
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (error) => done(error));
      child.on("close", (code) => {
        if (signal?.aborted) return done(new Error("cancelled"));
        done(code === 0 ? undefined : new Error(`pi json subprocess exited ${code}: ${stderr.trim()}`));
      });
      if (signal) {
        signal.addEventListener("abort", () => {
          child.kill("SIGTERM");
          done(new Error("cancelled"));
        }, { once: true });
      }
    });
  };
}
