import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOST = "127.0.0.1";
const PORT = 30141;

type Action = "start" | "status" | "trust" | "help";

export default function piWebCommandExtension(pi: ExtensionAPI) {
  pi.registerCommand("pi-web", {
    description: "Start agegr/pi-web for this Equaxis project",
    handler: async (rawArgs, ctx) => {
      const action = parseAction(rawArgs);
      if (action === "help") {
        ctx.ui.notify(helpText(), "info");
        return;
      }

      const root = findEquaxisRoot(commandCwd(ctx));
      const url = `http://${HOST}:${PORT}`;
      const workspaceUrl = `${url}/?${new URLSearchParams({ cwd: root })}`;

      if (action === "status") {
        ctx.ui.notify(await status(url, root), "info");
        return;
      }

      if (!(await isRunning(url))) {
        try {
          launchPiWeb(root);
        } catch (error) {
          ctx.ui.notify(`Unable to start pi-web: ${messageOf(error)}\nInstall it with: npm install -g @agegr/pi-web@latest`, "error");
          return;
        }
        if (!(await waitUntilReady(url))) {
          ctx.ui.notify(`pi-web did not become ready at ${url}. Check whether port ${PORT} is occupied.`, "error");
          return;
        }
      }

      const lines = await connectProject(url, root, true);
      openBrowser(workspaceUrl);
      ctx.ui.notify([`Pi Web ready: ${workspaceUrl}`, `Equaxis project: ${root}`, ...lines].join("\n"), "info");
    }
  });
}

function parseAction(raw: unknown): Action {
  const first = typeof raw === "string" ? raw.trim().split(/\s+/).find(Boolean) : undefined;
  if (first === "status" || first === "trust" || first === "help") return first;
  return "start";
}

function commandCwd(ctx: { cwd?: unknown }): string {
  return typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
}

function findEquaxisRoot(cwd: string): string {
  let current = path.resolve(cwd);
  while (true) {
    if (existsSync(path.join(current, ".pi", "equaxis.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

function launchPiWeb(root: string): void {
  const agentDir = path.join(root, ".pi");
  const sessionDir = historicalSessionDir();
  const { command, args } = piWebLauncher(root);
  // Pass the agent/session dirs through the spawn env option instead of a
  // cmd.exe/sh wrapper: nested quotes in `cmd /c "set ... && ..."` break on
  // Windows (Node escapes embedded quotes as \" which cmd misparses), so the
  // server never starts. Direct spawn also works for the vendored fork and
  // the global install on every platform.
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PATH: [gitBashDir(), process.env.PATH].filter(Boolean).join(path.delimiter)
  };
  const child = spawn(command, [...args, "-H", HOST, "-p", String(PORT), "--no-open"], {
    cwd: root,
    env,
    detached: true,
    stdio: "ignore"
  });
  child.on("error", () => {
    // Unresolvable launcher surfaces in the readiness check; never crash the host.
  });
  child.unref();
}

function gitBashDir(): string {
  const candidates = [
    path.join(process.env.ProgramFiles ?? "", "Git", "bin"),
    path.join("D:\\Program Files", "Git", "bin")
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "bash.exe"))) ?? "";
}

function piWebLauncher(root: string): { command: string; args: string[] } {
  // Prefer the versioned fork in the repo (pi-web/), then the legacy
  // source-cache copy, then the global install.
  const candidates = [
    path.join(root, "pi-web", "bin", "pi-web.js"),
    path.join(root, ".pi", "runtime", "source-cache", "agegr-pi-web", "bin", "pi-web.js")
  ];
  for (const localBin of candidates) {
    const localBuild = path.join(path.dirname(path.dirname(localBin)), ".next", "BUILD_ID");
    if (existsSync(localBin) && existsSync(localBuild)) {
      return { command: process.execPath, args: [localBin] };
    }
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    const bin = path.join(process.env.APPDATA, "npm", "node_modules", "@agegr", "pi-web", "bin", "pi-web.js");
    if (existsSync(bin)) return { command: process.execPath, args: [bin] };
  }
  return { command: "pi-web", args: [] };
}

function historicalSessionDir(): string {
  return path.join(homedir(), ".pi", "agent", "sessions");
}

async function status(url: string, root: string): Promise<string> {
  const lines = [
    `Pi Web: ${url}`,
    `Equaxis project: ${root}`,
    `Pi agent state: ${path.join(root, ".pi")}`,
    `Pi sessions: ${historicalSessionDir()}`
  ];
  if (!(await isRunning(url))) return [...lines, "status: not running", "run: /pi-web"].join("\n");
  lines.push("status: running");
  lines.push(...(await connectProject(url, root, false)));
  return lines.join("\n");
}

async function connectProject(url: string, root: string, trust: boolean): Promise<string[]> {
  const params = new URLSearchParams({ cwd: root });
  const registered = await post(`${url}/api/cwd/validate`, { cwd: root });
  if (!registered.ok) return [`cwd registration failed: ${registered.status} ${oneLine(registered.text)}`];

  let trustStatus = await get(`${url}/api/project-trust?${params}`);
  if (trust && trustStatus.ok && trustStatus.text.includes('"requiresTrust":true') && !trustStatus.text.includes('"trusted":true')) {
    trustStatus = await post(`${url}/api/project-trust`, { cwd: root });
  }

  const models = await get(`${url}/api/models?${params}`);
  const plugins = await get(`${url}/api/plugins?${params}`);
  return [
    `workspace: ${root}`,
    trustStatus.ok ? `trust: ${trustStatus.text.includes('"trusted":true') ? "trusted" : "not trusted"}` : `trust: unavailable (${trustStatus.status})`,
    models.ok ? "models: available" : `models: unavailable (${models.status})`,
    plugins.ok && plugins.text.includes('"projectResourcesLoaded":true') ? "project resources: loaded" : `project resources: unavailable or not loaded (${plugins.status})`
  ];
}

async function isRunning(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/sessions`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitUntilReady(url: string): Promise<boolean> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await isRunning(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function get(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, text: messageOf(error) };
  }
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, text: messageOf(error) };
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function helpText(): string {
  return [
    "Usage:",
    "  /pi-web         start Pi Web and open this Equaxis workspace",
    "  /pi-web status  show server, trust, model, and plugin status",
    "  /pi-web trust   start and trust this project for Pi Web resources"
  ].join("\n");
}
