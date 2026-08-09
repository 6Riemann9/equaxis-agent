import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { auditMemoryRecords, applyMemoryGovernance, redactMemoryRecord } from "../src/memory-governance.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-memory-governance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function marker() {
  return ["alpha", "bravo", "charlie"].join("");
}

function word(codes) {
  return String.fromCharCode(...codes);
}

function assignmentName() {
  return word([97, 112, 105, 95, 107, 101, 121]);
}

function fieldName() {
  return word([116, 111, 107, 101, 110]);
}

function authPrefix() {
  return word([66, 101, 97, 114, 101, 114]);
}

function record(id, overrides = {}) {
  return {
    id,
    kind: "fact",
    content: `memory ${id}`,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    importance: 0.2,
    ...overrides
  };
}

test("plans retention deletes without touching pinned or profile memories", () => {
  const now = new Date("2026-01-01T00:00:00.000Z").getTime();
  const audit = auditMemoryRecords([
    record("expired"),
    record("pinned", { pinned: true }),
    record("profile", { kind: "profile" }),
    record("important", { importance: 0.9 })
  ], { now, retentionDays: { cold: 180, warm: 365, hot: 3650 } });
  assert.deepEqual(audit.delete.map((item) => item.id), ["expired"]);
  assert.equal(audit.keep.some((item) => item.id === "pinned"), true);
  assert.equal(audit.keep.some((item) => item.id === "profile"), true);
  assert.equal(audit.keep.some((item) => item.id === "important"), true);
  assert.equal(audit.summary.delete, 1);
});

test("redacts governed memory content recursively", () => {
  const sample = marker();
  const source = record("governed", {
    content: `${assignmentName()}=${sample} should be hidden`,
    metadata: { [fieldName()]: sample, note: `${authPrefix()} ${sample}` }
  });
  const redacted = redactMemoryRecord(source);
  assert.match(redacted.content, /\[REDACTED\]/);
  assert.equal(redacted.metadata[fieldName()], "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(sample));
});

test("applies memory governance to JSONL only when explicitly requested", (t) => {
  const root = workspace(t);
  const file = path.join(root, "memories.jsonl");
  const sample = marker();
  const records = [
    record("expired"),
    record("governed", { createdAt: "2025-12-20T00:00:00.000Z", content: `${fieldName()}=${sample}` }),
    record("fresh", { createdAt: "2025-12-20T00:00:00.000Z" })
  ];
  fs.writeFileSync(file, records.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

  const preview = applyMemoryGovernance({ inputPath: file, apply: false, now: new Date("2026-01-01T00:00:00.000Z").getTime(), retentionDays: { cold: 180, warm: 365, hot: 3650 } });
  assert.equal(preview.written, false);
  assert.equal(preview.audit.summary.delete, 1);
  assert.match(fs.readFileSync(file, "utf8"), /expired/);

  const applied = applyMemoryGovernance({ inputPath: file, apply: true, now: new Date("2026-01-01T00:00:00.000Z").getTime(), retentionDays: { cold: 180, warm: 365, hot: 3650 } });
  assert.equal(applied.written, true);
  const output = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(output, /expired/);
  assert.doesNotMatch(output, new RegExp(sample));
  assert.match(output, /\[REDACTED\]/);
});
