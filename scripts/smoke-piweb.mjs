#!/usr/bin/env node
// Equaxis smoke chain (#10): start pi-web, verify home page, sessions API,
// memory API, harness API, skills API, then shut down. No browser needed —
// HTTP probes only. Exit code 0 = all green.
//
// Usage: node scripts/smoke-piweb.mjs [--cwd <dir>] [--port <port>] [--timeout <ms>]
// Defaults: cwd = repo root, port = free ephemeral port, timeout = 60s.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function get(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal })
    .then(async (res) => ({ status: res.status, text: await res.text() }))
    .catch((err) => ({ status: 0, text: String(err?.cause ?? err?.message ?? err) }))
    .finally(() => clearTimeout(timer));
}

async function waitForReady(base, deadline) {
  while (Date.now() < deadline) {
    const res = await get(`${base}/api/home`, 5000);
    if (res.status === 200) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  const cwdArg = argValue("--cwd", null);
  const port = Number(argValue("--port", String(await findFreePort())));
  const timeoutMs = Number(argValue("--timeout", "60000"));
  const base = `http://127.0.0.1:${port}`;

  // Launcher target mirrors .pi/extensions/pi-web.ts precedence:
  // piWeb.home override (must be built), repo pi-web/, packaged copy, source-cache.
  const candidates = [];
  let overrideRoot = null;
  try {
    const globalConfig = JSON.parse(readFileSync(path.join(process.env.HOME ?? "", ".equaxis", "config.json"), "utf8"));
    const home = globalConfig?.piWeb?.home;
    if (typeof home === "string" && home.trim()) {
      const overrideDir = path.resolve(home.trim());
      candidates.push(overrideDir);
      // A dev override lives at <repo>/pi-web — probe the repo root by default,
      // because pi-web only serves trusted project roots (harness/skills APIs
      // reject arbitrary directories like /tmp with 400/403).
      overrideRoot = path.dirname(overrideDir);
    }
  } catch { /* no global config */ }
  candidates.push(
    path.join(repoRoot, "pi-web"),
    path.join(repoRoot, ".pi", "runtime", "source-cache", "agegr-pi-web"),
  );
  // A candidate only counts when its production build exists (same rule as the extension).
  const bin = candidates.map((dir) => ({
    bin: path.join(dir, "bin", "pi-web.js"),
    built: existsSync(path.join(dir, ".next", "BUILD_ID")),
  })).find((c) => c.built && existsSync(c.bin))?.bin;
  if (!bin) {
    console.error("FAIL no pi-web launcher found — build it first: cd pi-web && npm ci && npm run build");
    process.exit(2);
  }

  const cwd = path.resolve(cwdArg ?? overrideRoot ?? repoRoot);
  console.log(`smoke: launching ${bin} on ${port} (cwd probe: ${cwd})`);
  const child = spawn(process.execPath, [bin, "--port", String(port), "--no-open"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_WEB_NO_OPEN: "1" },
  });
  const output = [];
  child.stdout.on("data", (d) => output.push(d.toString()));
  child.stderr.on("data", (d) => output.push(d.toString()));

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    const ready = await waitForReady(base, Date.now() + timeoutMs);
    check("pi-web starts and /api/home responds", ready, ready ? "" : `last output: ${output.join("").slice(-500)}`);
    if (!ready) process.exit(1);

    const home = await get(`${base}/`, 10000);
    check("home page / responds 200", home.status === 200, `status ${home.status}`);
    check("home page contains app shell", home.status === 200 && /<div id="__next"|<body/.test(home.text), "");

    const sessions = await get(`${base}/api/sessions?cwd=${encodeURIComponent(cwd)}`, 15000);
    check("sessions API responds 200", sessions.status === 200, `status ${sessions.status}`);
    check("sessions API returns JSON array/object", sessions.status === 200 && sessions.text.trim().startsWith("{") || sessions.text.trim().startsWith("["), "");

    const memory = await get(`${base}/api/memory?cwd=${encodeURIComponent(cwd)}`, 30000);
    check("memory API responds 200", memory.status === 200, `status ${memory.status}`);
    check("memory API returns JSON", memory.status === 200 && memory.text.trim().startsWith("{"), "");

    const harness = await get(`${base}/api/harness?cwd=${encodeURIComponent(cwd)}`, 15000);
    check("harness API responds 200", harness.status === 200, `status ${harness.status}`);

    const skills = await get(`${base}/api/skills?cwd=${encodeURIComponent(cwd)}`, 15000);
    check("skills API responds 200", skills.status === 200, `status ${skills.status}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => {
      child.once("exit", r);
      setTimeout(r, 3000);
    });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nsmoke: ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`smoke: unexpected error: ${err?.stack ?? err}`);
  process.exit(1);
});
