import fs from "node:fs";
import path from "node:path";
import { createEvalEvent } from "./eval-loop.mjs";

function parseJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const records = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // skip malformed lines instead of aborting the whole export
    }
  }
  return records;
}

function eventRecords(inputPath) {
  return parseJsonl(inputPath)
    .filter((record) => record.type === "eval_event" || record.event)
    .map((record) => createEvalEvent(record.event ?? record));
}

function relativeOrAbsolute(base, target) {
  const relative = path.relative(base, target).replaceAll("\\", "/");
  return relative.startsWith("..") ? target : relative;
}

export function evalEventToHarborRecord(event, options = {}) {
  const success = event.outcome === "success";
  return {
    taskId: event.taskId ?? `${event.tool.name}:${event.capabilities.join(",")}`,
    trialId: event.traceId ?? event.taskId ?? null,
    attempt: options.attempt ?? 1,
    variant: event.cohort ?? event.version.id ?? "baseline",
    taskArea: event.tool.name,
    capabilityTags: event.capabilities,
    expectedSuccessRate: options.expectedSuccessRate ?? 0.8,
    success,
    score: event.score ?? (success ? 1 : 0),
    failureCode: success ? null : event.errorCode ?? "EVAL_LOOP_FAILURE",
    safetyViolation: false,
    safetyEvaluated: false,
    latencyMs: event.latencyMs,
    costUsd: event.costUsd,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    totalTokens: event.inputTokens + event.outputTokens,
    trace: { traceId: event.traceId, version: event.version, provenance: event.provenance },
    resultPath: ""
  };
}

export function exportEvalLoopForHarbor(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const inputPath = path.resolve(projectRoot, options.input ?? ".pi/runtime/eval-loop/events.jsonl");
  const outputDir = path.resolve(projectRoot, options.outputDir ?? ".pi/runtime/eval-loop/harbor");
  const cycleId = options.cycleId ?? `eval-loop-${new Date().toISOString().replaceAll(":", "-")}`;
  // Number attempts per logical task so retries surface as attempt 2, 3, …
  // instead of every row being attempt 1 (which broke pass@N accounting).
  const attemptsByTask = new Map();
  const records = eventRecords(inputPath).map((event) => {
    const taskId = event.taskId ?? `${event.tool.name}:${event.capabilities.join(",")}`;
    const attempt = (attemptsByTask.get(taskId) ?? 0) + 1;
    attemptsByTask.set(taskId, attempt);
    return evalEventToHarborRecord(event, { ...options, attempt });
  });
  const baseline = records.filter((record) => record.variant === "baseline" || record.variant === "current");
  const candidates = records.filter((record) => !baseline.includes(record));
  fs.mkdirSync(outputDir, { recursive: true });
  const recordsPath = path.join(outputDir, "records.jsonl");
  const baselinePath = path.join(outputDir, "baseline-records.jsonl");
  const candidatePath = path.join(outputDir, "candidate-records.jsonl");
  fs.writeFileSync(recordsPath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "utf8");
  fs.writeFileSync(baselinePath, baseline.map((record) => JSON.stringify(record)).join("\n") + (baseline.length ? "\n" : ""), "utf8");
  fs.writeFileSync(candidatePath, candidates.map((record) => JSON.stringify(record)).join("\n") + (candidates.length ? "\n" : ""), "utf8");
  const manifest = {
    cycleId,
    source: relativeOrAbsolute(projectRoot, inputPath),
    records: relativeOrAbsolute(outputDir, recordsPath),
    baseline: { name: "baseline", records: relativeOrAbsolute(outputDir, baselinePath), count: baseline.length },
    experiments: candidates.length ? [{ name: "candidate", hypothesisId: options.hypothesisId ?? "eval-loop-candidate", records: relativeOrAbsolute(outputDir, candidatePath), count: candidates.length }] : []
  };
  const manifestPath = path.join(outputDir, "harbor-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { inputPath, outputDir, recordsPath, baselinePath, candidatePath, manifestPath, cycleId, counts: { records: records.length, baseline: baseline.length, candidates: candidates.length } };
}
