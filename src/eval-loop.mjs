import fs from "node:fs";
import path from "node:path";

function rounded(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Number(Number(value).toFixed(digits));
}

function mean(values, digits = 4) {
  const usable = values.map(Number).filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return rounded(usable.reduce((sum, value) => sum + value, 0) / usable.length, digits);
}

function wilsonInterval(successes, attempts, z = 1.96) {
  const n = Number(attempts ?? 0);
  if (!n) return { low: null, high: null };
  const p = Number(successes ?? 0) / n;
  const z2 = z ** 2;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denominator;
  return { low: rounded(Math.max(0, center - margin), 4), high: rounded(Math.min(1, center + margin), 4) };
}

function array(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function keyOf(record) {
  // JSON array serialization round-trips reliably even when a capability tag
  // or model id contains the legacy "|" separator.
  return JSON.stringify([record.model.provider, record.model.id, record.tool.name, ...record.capabilities]);
}

function groupKeyParts(key) {
  const [provider, model, tool, ...capabilities] = JSON.parse(key);
  return { provider, model, tool, capabilities };
}

function normalizeOutcome(outcome) {
  if (outcome === true || outcome === "success" || outcome?.success === true) return "success";
  if (outcome === false || outcome === "failure" || outcome?.success === false) return "failure";
  if (typeof outcome === "string" && outcome.trim()) return outcome.trim();
  return "unknown";
}

function normalizeVersion(value = {}) {
  return {
    kind: String(value.kind ?? "runtime"),
    id: String(value.id ?? value.version ?? "current"),
    sha: value.sha ? String(value.sha) : null
  };
}

function safeJsonParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function assertWorkspacePath(projectRoot, targetPath, label) {
  const relativePath = path.relative(projectRoot, targetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) throw new Error(`${label} must stay inside the workspace`);
}

function eventLogPath(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const rootDir = path.resolve(projectRoot, options.rootDir ?? ".pi/runtime/eval-loop");
  assertWorkspacePath(projectRoot, rootDir, "eval loop rootDir");
  return path.join(rootDir, "events.jsonl");
}

export function createEvalEvent(input = {}) {
  const provider = String(input.model?.provider ?? input.provider ?? "unknown");
  const modelId = String(input.model?.id ?? input.modelId ?? "unknown");
  const toolName = String(input.tool?.name ?? input.toolName ?? "unknown");
  const capabilities = [...new Set(array(input.capabilities ?? input.capabilityTags ?? input.capability ?? "unlabeled"))];
  return {
    timestamp: input.timestamp ?? new Date().toISOString(),
    taskId: input.taskId ? String(input.taskId) : null,
    cycleId: input.cycleId ? String(input.cycleId) : null,
    experimentId: input.experimentId ? String(input.experimentId) : null,
    cohort: input.cohort ? String(input.cohort) : null,
    model: { provider, id: modelId },
    tool: { name: toolName, namespace: input.tool?.namespace ? String(input.tool.namespace) : null },
    capabilities,
    outcome: normalizeOutcome(input.outcome ?? input.success),
    score: Number.isFinite(Number(input.score)) ? Number(input.score) : null,
    errorCode: input.errorCode ? String(input.errorCode) : null,
    latencyMs: input.latencyMs ?? null,
    inputTokens: Number(input.inputTokens ?? 0),
    outputTokens: Number(input.outputTokens ?? 0),
    costUsd: input.costUsd ?? null,
    traceId: input.traceId ? String(input.traceId) : null,
    version: normalizeVersion(input.version),
    provenance: input.provenance && typeof input.provenance === "object" ? { ...input.provenance } : {}
  };
}

export function createCandidateChange(input = {}) {
  const id = String(input.id ?? `candidate-${Date.now()}`);
  const version = normalizeVersion(input.version ?? { kind: input.kind ?? "prompt", id });
  return {
    id,
    hypothesis: String(input.hypothesis ?? ""),
    version,
    createdAt: input.createdAt ?? new Date().toISOString(),
    scope: array(input.scope ?? input.capability ?? "unlabeled"),
    provenance: {
      source: String(input.source ?? "eval-loop"),
      evidenceTraceIds: array(input.evidenceTraceIds ?? input.traceIds),
      parentVersion: input.parentVersion ? normalizeVersion(input.parentVersion) : null,
      changes: input.changes && typeof input.changes === "object" ? { ...input.changes } : {}
    }
  };
}

export function compareCandidate({ baseline, candidate, minSamples = 5, minSuccessRateDelta = 0.02, maxLatencyRegression = 0.1, maxCostRegression = 0.15, confidenceZ = 1.96 } = {}) {
  const baseAttempts = Number(baseline?.attempts ?? 0);
  const candidateAttempts = Number(candidate?.attempts ?? 0);
  if (baseAttempts < minSamples || candidateAttempts < minSamples) return { decision: "insufficient_data", reason: `minimum samples not met: baseline=${baseAttempts}, candidate=${candidateAttempts}` };
  const baseRate = Number(baseline.successRate ?? 0);
  const candidateRate = Number(candidate.successRate ?? 0);
  const successDelta = rounded(candidateRate - baseRate, 4);
  const baseLatency = Number(baseline.averageLatencyMs ?? 0);
  const candidateLatency = Number(candidate.averageLatencyMs ?? 0);
  const latencyDeltaRatio = baseLatency > 0 && candidateLatency > 0 ? rounded((candidateLatency - baseLatency) / baseLatency, 4) : 0;
  const baseCost = Number(baseline.averageCostUsd ?? 0);
  const candidateCost = Number(candidate.averageCostUsd ?? 0);
  const costDeltaRatio = baseCost > 0 && candidateCost > 0 ? rounded((candidateCost - baseCost) / baseCost, 4) : 0;
  const baselineConfidence = wilsonInterval(baseline.successes ?? Math.round(baseRate * baseAttempts), baseAttempts, confidenceZ);
  const candidateConfidence = wilsonInterval(candidate.successes ?? Math.round(candidateRate * candidateAttempts), candidateAttempts, confidenceZ);
  const confidence = { z: confidenceZ, baseline: baselineConfidence, candidate: candidateConfidence };
  const confidenceOverlap = baselineConfidence.high !== null && candidateConfidence.low !== null ? candidateConfidence.low <= baselineConfidence.high : true;
  if (successDelta < 0) return { decision: "reject", reason: `candidate success rate regressed by ${Math.abs(successDelta)}`, successDelta, latencyDeltaRatio, costDeltaRatio, confidence };
  if (latencyDeltaRatio > maxLatencyRegression && successDelta < minSuccessRateDelta) return { decision: "reject", reason: `candidate latency regressed by ${latencyDeltaRatio}`, successDelta, latencyDeltaRatio, costDeltaRatio, confidence };
  if (costDeltaRatio > maxCostRegression && successDelta < minSuccessRateDelta) return { decision: "reject", reason: `candidate cost regressed by ${costDeltaRatio}`, successDelta, latencyDeltaRatio, costDeltaRatio, confidence };
  if (successDelta >= minSuccessRateDelta && !confidenceOverlap) return { decision: "deploy", reason: `candidate success rate improved by ${successDelta}`, successDelta, latencyDeltaRatio, costDeltaRatio, confidence };
  if (successDelta >= minSuccessRateDelta) return { decision: "scoped", reason: "candidate improved but confidence intervals still overlap", successDelta, latencyDeltaRatio, costDeltaRatio, confidence };
  return { decision: "scoped", reason: "candidate is comparable but improvement is below deploy threshold", successDelta, latencyDeltaRatio, costDeltaRatio, confidence };
}

/**
 * 双数据集接受门 — train-set improvement + holdout (dev-set) non-regression.
 *
 * AutoDesign (arXiv 2608.13560) gates every harness change on "train-set
 * improvement AND dev-set non-regression" (their eq. 6 acceptance gate) so a
 * change that overfits its evaluation slice never ships. This composes the
 * single-set compareCandidate with a holdout comparison: the candidate must
 * pass the main gate AND keep the holdout success rate above
 * -holdoutRegressionTolerance. Holdout failures return "reject" with the
 * main decision preserved for diagnostics.
 */
export function compareCandidateWithHoldout({ baseline, candidate, holdoutBaseline, holdoutCandidate, holdoutRegressionTolerance = 0.02, minSamples = 5, ...rest } = {}) {
  const main = compareCandidate({ baseline, candidate, minSamples, ...rest });
  if (main.decision === "reject" || main.decision === "insufficient_data") return main;
  if (!holdoutBaseline || !holdoutCandidate) return { ...main, holdout: "skipped", holdoutDelta: null };
  const holdoutAttempts = Math.min(Number(holdoutBaseline.attempts ?? 0), Number(holdoutCandidate.attempts ?? 0));
  if (holdoutAttempts < minSamples) {
    return { ...main, holdout: "insufficient_data", holdoutDelta: null, holdoutAttempts };
  }
  const baseRate = Number(holdoutBaseline.successRate ?? 0);
  const candidateRate = Number(holdoutCandidate.successRate ?? 0);
  const holdoutDelta = rounded(candidateRate - baseRate, 4);
  if (holdoutDelta < -holdoutRegressionTolerance) {
    return {
      decision: "reject",
      reason: `holdout (dev-set) regression: ${holdoutDelta} below -${holdoutRegressionTolerance} tolerance`,
      holdout: "regressed",
      holdoutDelta,
      holdoutAttempts,
      mainDecision: main.decision,
      mainReason: main.reason,
      successDelta: main.successDelta,
      latencyDeltaRatio: main.latencyDeltaRatio,
      costDeltaRatio: main.costDeltaRatio,
      confidence: main.confidence
    };
  }
  // Holdout samples below the minimum: the gate cannot certify dev
  // non-regression, so the candidate must not deploy on train gain alone
  // (documented acceptance gate: train improvement AND dev non-regression).
  if (holdoutAttempts < minSamples && (main.decision === "deploy" || main.decision === "scoped")) {
    return {
      decision: "insufficient_data",
      reason: `holdout (dev-set) sample count below minimum: ${holdoutAttempts} < ${minSamples}`,
      holdout: "insufficient_data",
      holdoutDelta,
      holdoutAttempts,
      mainDecision: main.decision,
      mainReason: main.reason,
      successDelta: main.successDelta,
      latencyDeltaRatio: main.latencyDeltaRatio,
      costDeltaRatio: main.costDeltaRatio,
      confidence: main.confidence
    };
  }
  return { ...main, holdout: "pass", holdoutDelta, holdoutAttempts };
}

const EVAL_TRACE_EVENT = "eval_outcome_recorded";
const EVAL_TRACE_FIELDS = [
  "taskId", "cycleId", "experimentId", "cohort", "model", "tool", "capabilities",
  "outcome", "score", "errorCode", "latencyMs", "inputTokens", "outputTokens",
  "costUsd", "traceId", "version", "provenance"
];

/**
 * Recover eval outcomes from the reliability trace stream. The live harness
 * records every outcome into .pi/runtime/traces.jsonl as
 * `eval_outcome_recorded` (the persisted eval-loop events.jsonl only covers
 * runs after the harness gained a persisting EvalLoop), so this is the
 * authoritative full-history source for dashboards.
 */
export function collectEvalEventsFromTrace(tracePath, { limit = 10000 } = {}) {
  if (!fs.existsSync(tracePath)) return [];
  const events = [];
  for (const line of fs.readFileSync(tracePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = safeJsonParse(line);
    if (entry?.event !== EVAL_TRACE_EVENT) continue;
    const input = {};
    for (const field of EVAL_TRACE_FIELDS) {
      if (field in entry) input[field] = entry[field];
    }
    events.push(createEvalEvent(input));
    if (events.length >= limit) break;
  }
  return events;
}

/**
 * Read eval outcomes from every rotated reliability trace file under
 * traceDir (traces.jsonl plus rotated traces.N.jsonl archives), oldest
 * archives first. This is the authoritative full-history source: the
 * runtime harness writes only here (eval_outcome_recorded), never to the
 * offline eval ledger.
 */
export function collectEvalEventsFromTraceDir(projectRoot, traceDir = ".pi/runtime", { maxFiles = 3, limit = 10000 } = {}) {
  const root = path.resolve(projectRoot, traceDir);
  const paths = [];
  for (let index = Number(maxFiles) - 1; index >= 1; index -= 1) {
    paths.push(path.join(root, "traces." + index + ".jsonl"));
  }
  paths.push(path.join(root, "traces.jsonl"));
  const events = [];
  for (const tracePath of paths) {
    for (const event of collectEvalEventsFromTrace(tracePath, { limit: limit - events.length })) {
      events.push(event);
      if (events.length >= limit) break;
    }
    if (events.length >= limit) break;
  }
  return events;
}

/**
 * Build an EvalLoop whose events come from the trace stream, merged with the
 * offline eval ledger (events.jsonl: manual records, candidates, decisions).
 * Ledger eval_event rows whose traceId already exists in the trace stream are
 * dropped so legacy duplicated rows do not double-count outcomes.
 */
export function createEvalLoopFromTrace(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const traceEvents = collectEvalEventsFromTraceDir(
    projectRoot,
    options.traceDir ?? ".pi/runtime",
    { maxFiles: options.maxFiles ?? 3, limit: options.limit ?? 10000 }
  );
  const loop = new EvalLoop({
    persist: options.persist !== false,
    projectRoot,
    rootDir: options.rootDir ?? ".pi/runtime/eval-loop",
    trace: options.trace
  });
  const traceIds = new Set(traceEvents.map((event) => event.traceId).filter(Boolean));
  loop.events = loop.events.filter((event) => !event.traceId || !traceIds.has(event.traceId));
  for (const event of traceEvents) loop.events.push(event);
  return loop;
}

export class EvalLoop {
  constructor(options = {}) {
    this.events = [];
    this.candidates = [];
    this.decisions = [];
    this.trace = options.trace ?? (() => {});
    this.persist = Boolean(options.persist || options.persistence?.enabled);
    this.eventFile = this.persist ? eventLogPath({ projectRoot: options.projectRoot, rootDir: options.persistence?.rootDir ?? options.rootDir }) : null;
    if (this.persist) this.#restore();
    for (const event of options.events ?? []) this.events.push(createEvalEvent(event));
  }

  #restore() {
    if (!this.eventFile || !fs.existsSync(this.eventFile)) return;
    for (const line of fs.readFileSync(this.eventFile, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const record = safeJsonParse(line);
      if (record?.type === "eval_event") this.events.push(createEvalEvent(record.event));
      if (record?.type === "candidate_change") this.candidates.push(record.candidate);
      if (record?.type === "eval_decision") this.decisions.push(record.decision);
    }
  }

  #append(record) {
    if (!this.eventFile) return;
    fs.mkdirSync(path.dirname(this.eventFile), { recursive: true });
    fs.appendFileSync(this.eventFile, `${JSON.stringify(record)}\n`, "utf8");
  }

  record(input) {
    const event = createEvalEvent(input);
    this.events.push(event);
    this.#append({ type: "eval_event", recordedAt: new Date().toISOString(), event });
    this.trace("eval_outcome_recorded", event);
    return event;
  }

  registerCandidate(input) {
    const candidate = createCandidateChange(input);
    this.candidates.push(candidate);
    this.#append({ type: "candidate_change", recordedAt: new Date().toISOString(), candidate });
    this.trace("eval_candidate_registered", candidate);
    return candidate;
  }

  decision(input = {}) {
    const result = compareCandidate(input);
    const record = { ...result, decidedAt: new Date().toISOString(), baseline: input.baseline ?? null, candidate: input.candidate ?? null, candidateChange: input.candidateChange ?? null };
    this.decisions.push(record);
    this.#append({ type: "eval_decision", recordedAt: record.decidedAt, decision: record });
    this.trace("eval_decision_recorded", record);
    return record;
  }

  /** Aggregate a cell (tool/capability) from a filtered event list, mirroring snapshot's cell shape. */
  #statsFor(events) {
    const successes = events.filter((event) => event.outcome === "success").length;
    const failures = events.filter((event) => event.outcome === "failure").length;
    const attempts = events.length;
    return {
      attempts,
      successes,
      failures,
      unknowns: attempts - successes - failures,
      successRate: attempts ? rounded(successes / attempts) : 0,
      averageLatencyMs: mean(events.map((event) => event.latencyMs), 2),
      averageCostUsd: mean(events.map((event) => event.costUsd), 6)
    };
  }

  #eventsForCell(cohort, tool, capability) {
    return this.events.filter((event) => {
      if (cohort && event.cohort !== cohort) return false;
      if (tool && event.tool.name !== tool) return false;
      if (capability && !event.capabilities.includes(capability)) return false;
      return true;
    });
  }

  /**
   * Train/dev acceptance gate over cohort-tagged events (AutoDesign arXiv 2608.13560).
   *
   * Events in `trainCohort` form the main A/B comparison (baseline = events whose
   * version differs from `versionId`, candidate = events matching `versionId`);
   * events in `devCohort` form the holdout comparison. Deployment requires train
   * improvement AND dev non-regression (compareCandidateWithHoldout). The decision
   * is persisted with the cohort/version metadata for audit.
   */
  decisionWithHoldout(input = {}) {    const { trainCohort, devCohort, versionId, tool, capability, ...compareOpts } = input;
    if (!versionId) throw new Error("decisionWithHoldout requires versionId (the candidate version to compare)");
    const trainEvents = this.#eventsForCell(trainCohort, tool, capability);
    const devEvents = this.#eventsForCell(devCohort, tool, capability);
    const versioned = (events) => events.filter((event) => String(event.version?.id ?? "") === String(versionId ?? ""));
    const baseStats = (events) => this.#statsFor(events.filter((event) => String(event.version?.id ?? "") !== String(versionId ?? "")));
    const result = compareCandidateWithHoldout({
      baseline: baseStats(trainEvents),
      candidate: this.#statsFor(versioned(trainEvents)),
      holdoutBaseline: baseStats(devEvents),
      holdoutCandidate: this.#statsFor(versioned(devEvents)),
      ...compareOpts
    });
    const record = {
      ...result,
      decidedAt: new Date().toISOString(),
      trainCohort: trainCohort ?? null,
      devCohort: devCohort ?? null,
      versionId: versionId ?? null,
      tool: tool ?? null,
      capability: capability ?? null
    };
    this.decisions.push(record);
    this.#append({ type: "eval_decision", recordedAt: record.decidedAt, decision: record });
    this.trace("eval_decision_recorded", record);
    return record;
  }

  snapshot(filter = {}) {
    const events = this.events.filter((event) => {
      if (filter.provider && event.model.provider !== filter.provider) return false;
      if (filter.model && event.model.id !== filter.model) return false;
      if (filter.tool && event.tool.name !== filter.tool) return false;
      if (filter.capability && !event.capabilities.includes(filter.capability)) return false;
      if (filter.cohort && event.cohort !== filter.cohort) return false;
      if (filter.version && event.version.id !== filter.version) return false;
      return true;
    });
    const byKey = new Map();
    for (const event of events) {
      const key = keyOf(event);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(event);
    }
    const matrix = [...byKey.entries()].map(([key, rows]) => {
      const parts = groupKeyParts(key);
      const successes = rows.filter((row) => row.outcome === "success").length;
      const failures = rows.filter((row) => row.outcome === "failure").length;
      const errors = {};
      for (const row of rows) {
        if (!row.errorCode) continue;
        errors[row.errorCode] = (errors[row.errorCode] ?? 0) + 1;
      }
      return {
        ...parts,
        attempts: rows.length,
        successes,
        failures,
        unknowns: rows.length - successes - failures,
        successRate: rows.length ? rounded(successes / rows.length) : null,
        averageScore: mean(rows.map((row) => row.score), 4),
        averageLatencyMs: mean(rows.map((row) => row.latencyMs), 2),
        averageInputTokens: mean(rows.map((row) => row.inputTokens), 2),
        averageOutputTokens: mean(rows.map((row) => row.outputTokens), 2),
        averageCostUsd: mean(rows.map((row) => row.costUsd), 6),
        errorCodes: errors
      };
    }).sort((left, right) => left.provider.localeCompare(right.provider)
      || left.model.localeCompare(right.model)
      || left.tool.localeCompare(right.tool)
      || left.capabilities.join(",").localeCompare(right.capabilities.join(",")));
    const successes = events.filter((event) => event.outcome === "success").length;
    const failures = events.filter((event) => event.outcome === "failure").length;
    return {
      attempts: events.length,
      successes,
      failures,
      unknowns: events.length - successes - failures,
      successRate: events.length ? rounded(successes / events.length) : null,
      candidates: [...this.candidates],
      decisions: [...this.decisions],
      matrix
    };
  }

  /**
   * Capability x version delta matrix (Intern-S2 arXiv 2608.13505 harness×task
   * abstraction applied to evaluation): for every capability, compare success
   * rates between a baseline version and a candidate version. Answers "this
   * harness change improved which capabilities and regressed which" instead of
   * one blended number.
   */
  capabilityDeltaMatrix(input = {}) {
    const { baselineVersionId, candidateVersionId, ...filter } = input;
    const byCapability = new Map();
    const matches = (event) => {
      if (filter.provider && event.model.provider !== filter.provider) return false;
      if (filter.model && event.model.id !== filter.model) return false;
      if (filter.tool && event.tool.name !== filter.tool) return false;
      if (filter.cohort && event.cohort !== filter.cohort) return false;
      return true;
    };
    for (const event of this.events) {
      if (!matches(event)) continue;
      const versionId = String(event.version?.id ?? "");
      const isBaseline = versionId === String(baselineVersionId ?? "");
      const isCandidate = versionId === String(candidateVersionId ?? "");
      if (!isBaseline && !isCandidate) continue;
      for (const capability of event.capabilities) {
        if (!byCapability.has(capability)) byCapability.set(capability, { baseline: [], candidate: [] });
        (isCandidate ? byCapability.get(capability).candidate : byCapability.get(capability).baseline).push(event);
      }
    }
    const rate = (events) => {
      const attempts = events.length;
      const successes = events.filter((event) => event.outcome === "success").length;
      return { attempts, successes, successRate: attempts ? rounded(successes / attempts) : 0 };
    };
    const rows = [...byCapability.entries()]
      .map(([capability, groups]) => {
        const baseline = rate(groups.baseline);
        const candidate = rate(groups.candidate);
        return { capability, baseline, candidate, delta: rounded(candidate.successRate - baseline.successRate, 4) };
      })
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return {
      rows,
      improved: rows.filter((row) => row.delta > 0.01).map((row) => row.capability),
      regressed: rows.filter((row) => row.delta < -0.01).map((row) => row.capability),
      unchanged: rows.filter((row) => Math.abs(row.delta) <= 0.01).map((row) => row.capability)
    };
  }
}
