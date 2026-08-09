import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { EvalLoop } from "../src/eval-loop.mjs";
import { exportEvalLoopForHarbor } from "../src/eval-harbor-bridge.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-harbor-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("exports EvalLoop events as Harbor-compatible EvaluationRecord JSONL", (t) => {
  const root = workspace(t);
  const loop = new EvalLoop({ persist: true, projectRoot: root });
  loop.record({ taskId: "t1", outcome: "success", tool: { name: "bash" }, cohort: "baseline", capabilities: ["shell"], traceId: "tr1", latencyMs: 10 });
  loop.record({ taskId: "t2", outcome: "failure", errorCode: "ERR", tool: { name: "bash" }, cohort: "candidate", capabilities: ["shell"], traceId: "tr2" });

  const exported = exportEvalLoopForHarbor({ projectRoot: root, cycleId: "cycle-1" });
  assert.deepEqual(exported.counts, { records: 2, baseline: 1, candidates: 1 });
  const records = fs.readFileSync(exported.recordsPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(records[0].variant, "baseline");
  assert.equal(records[1].failureCode, "ERR");
  assert.equal(records[1].trace.traceId, "tr2");
  const manifest = JSON.parse(fs.readFileSync(exported.manifestPath, "utf8"));
  assert.equal(manifest.cycleId, "cycle-1");
  assert.equal(manifest.baseline.count, 1);
  assert.equal(manifest.experiments[0].count, 1);
});
