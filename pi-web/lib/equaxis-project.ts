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

const RUNTIME_MARKER = join("scripts", "memory-json.mjs");

/**
 * Locate the Equaxis RUNTIME (scripts/, bridge/, .pi/extensions) — which is
 * not necessarily the project root. Global installs serve workspaces that
 * only hold project data (.pi/equaxis.json, memory store); the runtime lives
 * in the installed package. Resolution order:
 *  1. EQUAXIS_RUNTIME_HOME env (the /pi-web launcher sets it from the
 *     extension's own module location — deterministic for every layout)
 *  2. the project root itself (repo checkout / source-cache layouts)
 *  3. the package containing this pi-web (bin/pi-web.js → <pkg>/pi-web/bin)
 * Returns null when no candidate carries the runtime marker.
 */
export function findEquaxisRuntime(projectRoot?: string | null): string | null {
  const envHome = process.env.EQUAXIS_RUNTIME_HOME?.trim();
  if (envHome && existsSync(join(envHome, RUNTIME_MARKER))) return resolve(envHome);
  if (projectRoot && existsSync(join(projectRoot, RUNTIME_MARKER))) return projectRoot;
  const launcher = process.argv[1];
  if (launcher) {
    const bundled = resolve(launcher, "..", "..");
    if (existsSync(join(bundled, RUNTIME_MARKER))) return bundled;
  }
  return null;
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
export function runEquaxisScript(projectRoot: string, scriptName: string, args: string[] = []): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  // The SCRIPT comes from the runtime root, but it runs with the PROJECT
  // root as cwd: snapshots resolve workspace state (sessions, memory store,
  // project config) from cwd and borrow runtime files themselves.
  const runtimeRoot = findEquaxisRuntime(projectRoot) ?? projectRoot;
  const scriptPath = join(runtimeRoot, "scripts", scriptName);
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    env: { ...process.env, EQUAXIS_PROJECT_ROOT: projectRoot },
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
