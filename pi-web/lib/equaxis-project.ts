import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT_TIMEOUT_MS = 30_000;

/**
 * Walk up from the requested workspace until an Equaxis project
 * (.pi/equaxis.json) is found. Returns the project root or null.
 */
export function findEquaxisRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".pi", "equaxis.json"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Pi's per-project session directory: ~/.pi/agent/sessions/--<encoded-cwd>--
 * (matches the coding-agent's encoding: strip leading slash, then / \ : -> -).
 * Prefers PI_CODING_AGENT_SESSION_DIR (set by the Equaxis pi-web launcher) so
 * the resolution does not depend on the server process's homedir().
 */
export function getProjectSessionDir(projectRoot: string): string {
  const encoded = `--${projectRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionsRoot = process.env.PI_CODING_AGENT_SESSION_DIR ?? join(homedir(), ".pi", "agent", "sessions");
  return join(sessionsRoot, encoded);
}

/**
 * Run one of the project's one-shot scripts (e.g. harness-snapshot.mjs) and
 * resolve its JSON stdout. Uses `Promise.withResolvers` so a slow or dead
 * script cannot hang the request forever.
 */
export function runEquaxisScript(projectRoot: string, scriptName: string): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const scriptPath = join(projectRoot, "scripts", scriptName);
  const child = spawn(process.execPath, [scriptPath], {
    cwd: projectRoot,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill();
    reject(new Error(`Equaxis script timed out: ${scriptName}`));
  }, SCRIPT_TIMEOUT_MS);

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn();
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", (error) => {
    settle(() => reject(error));
  });
  child.once("exit", (code) => {
    settle(() => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Equaxis script exited with code ${code}: ${scriptName}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as unknown);
      } catch (error) {
        reject(new Error(`Equaxis script returned invalid JSON: ${String(error)}`));
      }
    });
  });
  return promise;
}
