#!/usr/bin/env node

/**
 * One-shot JSON snapshot of the Equaxis harness runtime, consumed by the
 * pi-web Harness dashboard. Fast and side-effect free: reads config, runtime
 * artifacts and the trace stream; performs no model calls.
 *
 * Usage: node scripts/harness-snapshot.mjs
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEquaxisConfig } from "../src/equaxis-config.mjs";
import { buildRuntimeDashboard } from "../src/runtime-dashboard.mjs";
import { runDoctor } from "../src/doctor.mjs";
import { collectEvalEventsFromTraceDir, EvalLoop } from "../src/eval-loop.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJsonl(relativePath, maxEntries = 50000) {
  const absolute = path.resolve(projectRoot, relativePath);
  if (!fs.existsSync(absolute)) return [];
  const entries = [];
  for (const line of fs.readFileSync(absolute, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed trace lines
    }
    if (entries.length >= maxEntries) break;
  }
  return entries;
}

let config = null;
try {
  config = loadEquaxisConfig(projectRoot);
} catch (error) {
  config = { error: error instanceof Error ? error.message : String(error) };
}

/** Probe the memory backend: spawn it, ping, close. ~1s, side-effect free. */
function probeMemoryBridge() {
  const rootDir = path.resolve(projectRoot, config?.memory?.rootDir ?? ".equaxis/memory");
  const native = config?.memory?.backend !== "python";
  const command = native ? process.execPath : (config?.memory?.pythonCommand ?? "python");
  const args = native
    ? [path.join(projectRoot, "scripts", "memory-json.mjs"), "--root", rootDir]
    : ["-u", path.join(projectRoot, "bridge", "memory_bridge.py"), "--root", rootDir];
  if (native && !fs.existsSync(args[0])) return { ok: false, error: "native memory script missing" };
  if (!native && !fs.existsSync(args[1])) return { ok: false, error: "bridge script missing" };
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    input: '{"id":"snapshot","action":"ping","payload":{}}\n{"id":"snapshot","action":"close","payload":{}}\n',
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true
  });
  if (result.error) return { ok: false, error: result.error.message };
  const line = (result.stdout ?? "").split("\n").find((item) => item.startsWith("__EQUAXIS_MEMORY__"));
  try {
    const response = JSON.parse(line.slice("__EQUAXIS_MEMORY__".length));
    return response.ok ? { ok: true, ...response.result } : { ok: false, error: response.error?.message ?? "bridge error" };
  } catch {
    return { ok: false, error: (result.stderr ?? "no bridge response").trim().slice(0, 200) };
  }
}

let dashboard = null;
try {
  dashboard = buildRuntimeDashboard({ projectRoot, config, cwd: projectRoot, env: process.env });
} catch (error) {
  dashboard = { error: error instanceof Error ? error.message : String(error) };
}

let doctor = null;
try {
  doctor = runDoctor({ projectRoot, cwd: projectRoot, env: process.env });
} catch (error) {
  doctor = { ok: false, checks: [], error: error instanceof Error ? error.message : String(error) };
}

// Eval history: the authoritative full history lives in the trace stream as
// eval_outcome_recorded entries (including rotated trace archives).
let evalStats = null;
try {
  const events = collectEvalEventsFromTraceDir(projectRoot, ".pi/runtime", { maxFiles: 3 });
  evalStats = new EvalLoop({ events }).snapshot();
} catch (error) {
  evalStats = { error: error instanceof Error ? error.message : String(error) };
}

/**
 * Aggregate token/cost usage from the project's session files. Every assistant
 * message carries `usage` (input/output/totalTokens + cost breakdown); summing
 * per provider/model gives a live spend picture for the dashboard.
 */
function collectSessionCosts() {
  const sessionsRoot =
    process.env.PI_CODING_AGENT_SESSION_DIR ??
    path.join(os.homedir(), ".pi", "agent", "sessions");
  const encoded = `--${projectRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = path.join(sessionsRoot, encoded);
  if (!fs.existsSync(sessionDir)) return null;
  const byModel = {};
  const bySession = [];
  let totalTokens = 0;
  let totalCostUsd = 0;
  const files = fs
    .readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => ({ name, stat: fs.statSync(path.join(sessionDir, name)) }))
    .sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);
  for (const { name, stat } of files) {
    let sessionTokens = 0;
    let sessionCost = 0;
    for (const line of fs.readFileSync(path.join(sessionDir, name), "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const usage = entry.message?.usage;
        if (!usage || typeof usage !== "object") continue;
        const tokens = Number(usage.totalTokens) || 0;
        const cost = Number(usage.cost?.total) || 0;
        if (tokens <= 0 && cost <= 0) continue;
        const key = `${entry.message?.provider ?? "unknown"}/${entry.message?.model ?? "unknown"}`;
        const bucket = byModel[key] ?? (byModel[key] = { provider: key.split("/")[0], model: key.split("/")[1], tokens: 0, costUsd: 0, sessions: 0 });
        bucket.tokens += tokens;
        bucket.costUsd += cost;
        sessionTokens += tokens;
        sessionCost += cost;
      } catch {
        // skip malformed lines
      }
    }
    if (sessionTokens > 0 || sessionCost > 0) {
      bySession.push({ session: name.slice(0, 30), modifiedAt: stat.mtime.toISOString(), tokens: sessionTokens, costUsd: sessionCost });
    }
    totalTokens += sessionTokens;
    totalCostUsd += sessionCost;
  }
  return {
    totalTokens,
    totalCostUsd,
    byModel: Object.values(byModel).sort((a, b) => b.costUsd - a.costUsd),
    bySession: bySession.slice(-15).reverse()
  };
}

// Harbor evaluation artifacts: paired budget comparison + latest improvement cycle.
let harbor = null;
try {
  const budgetPath = path.join(projectRoot, "harbor_eval", "jobs", "budget-v2-report.json");
  const budget = fs.existsSync(budgetPath) ? JSON.parse(fs.readFileSync(budgetPath, "utf8")) : null;
  const reportsDir = path.join(projectRoot, "harbor_eval", "reports");
  let cycle = null;
  if (fs.existsSync(reportsDir)) {
    let newest = null;
    for (const name of fs.readdirSync(reportsDir)) {
      const reportPath = path.join(reportsDir, name, "cycle-report.json");
      if (!fs.existsSync(reportPath)) continue;
      const stat = fs.statSync(reportPath);
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { name, reportPath, stat };
    }
    if (newest) {
      cycle = { ...JSON.parse(fs.readFileSync(newest.reportPath, "utf8")), cycleDir: newest.name };
    }
  }
  harbor = { budget, cycle };
} catch (error) {
  harbor = { error: error instanceof Error ? error.message : String(error) };
}

const traces = readJsonl(".pi/runtime/traces.jsonl");
const byEvent = {};
let lastReliability = null;
let failureEvents = 0;
const errorDetails = [];
for (const entry of traces) {
  byEvent[entry.event] = (byEvent[entry.event] ?? 0) + 1;
  if (entry.customType === "equaxis-reliability-state") lastReliability = entry.data;
  const isFailure = /failed|error|blocked/i.test(entry.event) || entry.isError === true;
  if (isFailure) {
    failureEvents += 1;
    if (errorDetails.length < 20) {
      errorDetails.push({
        timestamp: entry.timestamp,
        event: entry.event,
        detail: entry.error ?? entry.reason ?? entry.toolName ?? null
      });
    }
  }
}
const recentEvents = traces.slice(-50).reverse().map((entry) => ({
  timestamp: entry.timestamp,
  event: entry.event,
  phase: entry.phase ?? null,
  sessionId: entry.sessionId ?? null,
  toolName: entry.toolName ?? null,
  risk: entry.risk ?? null,
  chars: entry.chars ?? null,
  error: entry.error ?? null,
  detail: entry.data ?? null
}));

/**
 * The harness persists its live state (mode/phase/counters/lastRisk) into the
 * most recent session file as `equaxis-reliability-state` entries. Find the
 * newest session file whose header cwd matches this project and return its
 * last state.
 */
function findLatestReliabilityState() {
  const sessionsRoot =
    process.env.PI_CODING_AGENT_SESSION_DIR ??
    path.join(os.homedir(), ".pi", "agent", "sessions");
  if (!fs.existsSync(sessionsRoot)) return null;
  let newest = null;
  for (const dirName of fs.readdirSync(sessionsRoot)) {
    const dir = path.join(sessionsRoot, dirName);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let newestFile = null;
    for (const fileName of fs.readdirSync(dir)) {
      if (!fileName.endsWith(".jsonl")) continue;
      const full = path.join(dir, fileName);
      const fileStat = fs.statSync(full);
      if (!newestFile || fileStat.mtimeMs > newestFile.mtimeMs) newestFile = { full, fileStat };
    }
    if (!newestFile) continue;
    let cwdMatches = false;
    try {
      const header = fs.readFileSync(newestFile.full, "utf8").split("\n", 1)[0];
      cwdMatches = JSON.parse(header).cwd === projectRoot;
    } catch {
      // unreadable header; skip this dir
    }
    if (!cwdMatches) continue;
    if (!newest || newestFile.fileStat.mtimeMs > newest.fileStat.mtimeMs) newest = newestFile;
  }
  if (!newest) return null;
  let state = null;
  for (const line of fs.readFileSync(newest.full, "utf8").split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "custom" && entry.customType === "equaxis-reliability-state") state = entry.data;
    } catch {
      // skip malformed lines
    }
  }
  return { sessionFile: newest.full, state };
}

process.stdout.write(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      projectRoot,
      config,
      dashboard,
      doctor,
      eval: evalStats,
      harbor,
      costs: collectSessionCosts(),
      memoryBridge: probeMemoryBridge(),
      reliability: findLatestReliabilityState(),
      traces: {
        total: traces.length,
        byEvent,
        failureEvents,
        errorDetails,
        lastReliability,
        recentEvents
      }
    },
    null,
    2
  )
);
