#!/usr/bin/env node
/**
 * Local benchmark runner: executes the deterministic Harbor-style tasks
 * against the installed Equaxis (full runtime) and raw Pi (control) using
 * the local gateway, then writes harbor_eval/jobs/budget-v2-report.json in
 * the shape the Harness dashboard expects.
 *
 * No Docker / harbor CLI required: each task workspace is a copy of the
 * task's environment/app, the verifier runs with /app paths rewritten to the
 * workspace, and sessions run headless (--mode json).
 *
 * Usage:
 *   node scripts/benchmark-local.mjs [--tasks 3] [--task atomic-write] [--arms equaxis,pi-control]
 *   --tasks N   run the first N tasks (pilot)
 *   --task NAME run a single named task
 *   --arms ...  comma-separated arms (default both)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const datasetDir = path.join(packageRoot, "harbor_eval", "benchmark-dataset", "tasks");
const jobsDir = path.join(packageRoot, "harbor_eval", "jobs");
const EQUAXIS_ENTRY = path.join(packageRoot, "scripts", "equaxis.mjs");
// Raw Pi control: no extensions, same kernel.
const PI_ENTRY = (() => {
  try {
    return new URL(import.meta.resolve("@earendil-works/pi-coding-agent/dist/cli.js")).pathname;
  } catch {
    return path.join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  }
})();

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : undefined;
};
const tasksArg = valueOf("--tasks");
const taskName = valueOf("--task");
const armsArg = valueOf("--arms") ?? "equaxis,pi-control";
const arms = armsArg.split(",").map((item) => item.trim().replaceAll("-", "_")).filter(Boolean);

function listTasks() {
  if (!fs.existsSync(datasetDir)) throw new Error(`task dataset missing: ${datasetDir}`);
  return fs.readdirSync(datasetDir).filter((name) => fs.statSync(path.join(datasetDir, name)).isDirectory()).sort();
}

const selectedTasks = taskName ? [taskName] : listTasks().slice(0, Number(tasksArg) || listTasks().length);
if (!selectedTasks.length) throw new Error("no tasks selected");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function runJson(command, entry, argsList, cwd, rawLogPath) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, [entry, ...argsList], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 420_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      let inputTokens = 0;
      let outputTokens = 0;
      let lastModel = "";
      const errorMessages = [];
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message?.usage) {
            // Count the full billable surface: cache reads are billed at a
            // discount but are real consumption; skipping them understates
            // the arm's cost by up to an order of magnitude on cache-friendly
            // harnesses.
            const usage = event.message.usage;
            inputTokens += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
            outputTokens += usage.output ?? 0;
            lastModel = event.message.model ?? lastModel;
          }
          if (event.type === "message_end" && event.message?.stopReason === "error") {
            errorMessages.push(String(event.message.content ?? "").slice(0, 300));
          }
          if (event.type === "error" || event.type === "agent_error") {
            errorMessages.push(JSON.stringify(event).slice(0, 300));
          }
        } catch { /* skip */ }
      }
      if (rawLogPath) {
        try {
          fs.mkdirSync(path.dirname(rawLogPath), { recursive: true });
          fs.writeFileSync(rawLogPath, `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`, "utf8");
        } catch { /* best-effort forensic log */ }
      }
      resolve({
        exitCode: code,
        durationMs: Date.now() - started,
        inputTokens,
        outputTokens,
        lastModel,
        errorMessages: errorMessages.slice(0, 3),
        stdoutTail: stdout.trim().slice(-600),
        stderrTail: stderr.trim().slice(-400)
      });
    });
  });
}

function rewriteAppPaths(verifyText, workspace) {
  return verifyText
    .replaceAll("/app/", `${workspace}/`)
    .replaceAll("'/app'", `'${workspace}'`)
    .replaceAll('"/app"', `"${workspace}"`);
}

async function runVerifier(taskDir, workspace) {
  const testsDir = path.join(taskDir, "tests");
  const verifyPath = path.join(testsDir, "verify.mjs");
  if (fs.existsSync(verifyPath)) {
    const adapted = rewriteAppPaths(fs.readFileSync(verifyPath, "utf8"), workspace);
    const tmpVerify = path.join(workspace, ".verify.mjs");
    fs.writeFileSync(tmpVerify, adapted, "utf8");
    const result = spawn("node", [tmpVerify], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    return await new Promise((resolve) => {
      let stderr = "";
      result.stderr.setEncoding("utf8");
      result.stderr.on("data", (chunk) => { stderr += chunk; });
      result.on("close", (code) => resolve({ ok: code === 0, detail: stderr.trim().slice(-200) }));
    });
  }
  const testSh = path.join(testsDir, "test.sh");
  if (fs.existsSync(testSh)) {
    const adapted = rewriteAppPaths(fs.readFileSync(testSh, "utf8"), workspace);
    const tmpSh = path.join(workspace, ".test.sh");
    fs.writeFileSync(tmpSh, adapted, "utf8");
    const result = spawn("sh", [tmpSh], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    return await new Promise((resolve) => {
      let stderr = "";
      result.stderr.setEncoding("utf8");
      result.stderr.on("data", (chunk) => { stderr += chunk; });
      result.on("close", (code) => resolve({ ok: code === 0, detail: stderr.trim().slice(-200) }));
    });
  }
  return { ok: false, detail: "no verifier found" };
}

function reportLine(arm, task, result, verifier) {
  const pass = verifier.ok;
  const mark = pass ? "PASS" : "FAIL";
  console.log(`${mark}  ${arm.padEnd(10)} ${task.padEnd(18)} ${String(result.durationMs).padStart(6)}ms ${String(result.inputTokens + result.outputTokens).padStart(8)}tok ${result.lastModel}`);
  return { task, pass, durationMs: result.durationMs, tokens: result.inputTokens + result.outputTokens, model: result.lastModel };
}

const summary = { equaxis: [], pi_control: [] };
const rawDir = path.join(jobsDir, "raw");
const resultsFile = path.join(jobsDir, "local-results.json");
const COOLDOWN_MS = Number(valueOf("--cooldown-ms") ?? 4000);

// Resumable per-(arm,task) store: completed runs survive across invocations so
// a throttled or interrupted batch can be re-run without paying again.
function loadResults() {
  try {
    const parsed = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
const stored = loadResults();
function rememberResult(arm, task, entry) {
  stored[`${arm}|${task}`] = entry;
  fs.writeFileSync(resultsFile, JSON.stringify(stored, null, 2) + "\n", "utf8");
}

for (const task of selectedTasks) {
  const taskDir = path.join(datasetDir, task);
  const instruction = fs.readFileSync(path.join(taskDir, "instruction.md"), "utf8").trim();
  const appSrc = path.join(taskDir, "environment", "app");
  for (const arm of arms) {
    const cached = stored[`${arm}|${task}`];
    if (cached) {
      console.log(`SKIP ${arm} ${task} (already recorded: ${cached.pass ? "PASS" : "FAIL"})`);
      summary[arm].push(cached);
      continue;
    }
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `harbor-local-${task}-`));
    if (fs.existsSync(appSrc)) copyDir(appSrc, workspace);
    console.log(`RUN ${arm} ${task} — ${instruction.slice(0, 60)}...`);
    const rawLogPath = path.join(rawDir, `${arm}-${task}.log`);
    const result = arm === "equaxis"
      ? await runJson(process.execPath, EQUAXIS_ENTRY, ["--mode", "json", "-p", instruction], workspace, rawLogPath)
      : await runJson(process.execPath, PI_ENTRY, ["--mode", "json", "-p", instruction], workspace, rawLogPath);
    if (result.exitCode !== 0) {
      console.log(`ERR ${arm} ${task}: exit ${result.exitCode} ${result.stderrTail}`);
      const entry = { task, pass: false, durationMs: result.durationMs, tokens: result.inputTokens + result.outputTokens, model: result.lastModel, error: result.stderrTail, errorMessages: result.errorMessages };
      summary[arm].push(entry);
      // Do not persist exit-code errors: they are likely transient and worth retrying.
      if (COOLDOWN_MS) await new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS));
      continue;
    }
    const verifier = await runVerifier(taskDir, workspace);
    const entry = reportLine(arm, task, result, verifier);
    if (!verifier.ok) {
      entry.error = verifier.detail;
      entry.diagnostic = { stdoutTail: result.stdoutTail, stderrTail: result.stderrTail, errorMessages: result.errorMessages };
      console.log(`  diag stdout: ${result.stdoutTail}`);
      console.log(`  diag stderr: ${result.stderrTail}`);
    }
    // A 0-token run means no model call happened: that is a harness/provider
    // hiccup, not a task failure. Leave it unpersisted so a re-run retries it.
    if (result.inputTokens + result.outputTokens > 0) rememberResult(arm, task, entry);
    else console.log(`  note: 0-token run, not persisted (will retry on next invocation)`);
    summary[arm].push(entry);
    fs.rmSync(workspace, { recursive: true, force: true });
    if (COOLDOWN_MS) await new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS));
  }
}

function aggregate(rows) {
  const valid = rows.filter((row) => row.tokens > 0);
  const passes = valid.filter((row) => row.pass).length;
  return {
    passAt1: valid.length ? passes / valid.length : 0,
    tasksAttempted: rows.length,
    tasksEvaluated: valid.length,
    tasksPassed: passes,
    avgLatencyMs: valid.length ? Math.round(valid.reduce((sum, row) => sum + row.durationMs, 0) / valid.length) : 0,
    totalTokens: valid.reduce((sum, row) => sum + row.tokens, 0),
    failures: valid.filter((row) => !row.pass).map((row) => row.task),
    throttled: rows.filter((row) => row.tokens === 0).map((row) => row.task)
  };
}

fs.mkdirSync(jobsDir, { recursive: true });
// Build the report from the persistent store (all arms, all recorded tasks)
// so a later single-arm invocation cannot zero out the other arm's results.
const reportEquaxis = Object.entries(stored).filter(([key]) => key.startsWith("equaxis|")).map(([, value]) => value);
const reportControl = Object.entries(stored).filter(([key]) => key.startsWith("pi_control|")).map(([, value]) => value);
const equaxisStats = aggregate(reportEquaxis.length ? reportEquaxis : summary.equaxis);
const controlStats = aggregate(reportControl.length ? reportControl : summary.pi_control);
const report = {
  generatedAt: new Date().toISOString(),
  runner: "scripts/benchmark-local.mjs",
  tasks: selectedTasks,
  arms,
  equaxis: equaxisStats,
  pi_control: controlStats,
  gain: {
    passAt1Delta: equaxisStats.passAt1 - controlStats.passAt1,
    latencyRatio: controlStats.avgLatencyMs ? Math.round((equaxisStats.avgLatencyMs / controlStats.avgLatencyMs) * 100) / 100 : null,
    tokenRatio: controlStats.totalTokens ? Math.round((equaxisStats.totalTokens / controlStats.totalTokens) * 100) / 100 : null
  }
};
const reportPath = path.join(jobsDir, "budget-v2-report.json");
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(`\nWrote ${reportPath}`);
console.log(`equaxis   pass@1=${equaxisStats.passAt1} avg=${equaxisStats.avgLatencyMs}ms tok=${equaxisStats.totalTokens}`);
console.log(`pi_control pass@1=${controlStats.passAt1} avg=${controlStats.avgLatencyMs}ms tok=${controlStats.totalTokens}`);
