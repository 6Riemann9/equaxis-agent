import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { listRefines, recordRefine, refineLedgerPath, refineTargetPath, rollbackRefine } from "../src/refine-ledger.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-refine-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("recordRefine creates a file-backed note with before/after snapshots", (t) => {
  const root = workspace(t);
  const record = recordRefine({ projectRoot: root, kind: "note", action: "create", target: "memory-tuning.md", content: "# tuning\n\nkeep thresholds soft", evidence: ["run-42"] });
  assert.equal(record.action, "create");
  assert.equal(record.before, null);
  assert.equal(record.after, "# tuning\n\nkeep thresholds soft");
  assert.deepEqual(record.evidence, ["run-42"]);
  assert.equal(fs.readFileSync(path.join(root, ".pi", "runtime", "refine", "notes", "memory-tuning.md"), "utf8"), "# tuning\n\nkeep thresholds soft");
  assert.equal(loadLedger(root).length, 1);
});

test("update records the previous content and rollback restores it", (t) => {
  const root = workspace(t);
  recordRefine({ projectRoot: root, kind: "note", action: "create", target: "a.md", content: "v1" });
  const update = recordRefine({ projectRoot: root, kind: "note", action: "update", target: "a.md", content: "v2", evidence: ["run-43"] });
  assert.equal(update.before, "v1");
  assert.equal(update.after, "v2");

  const rolledBack = rollbackRefine(update.id, { projectRoot: root });
  assert.equal(rolledBack.rolledBackAt !== null, true);
  assert.equal(fs.readFileSync(path.join(root, ".pi", "runtime", "refine", "notes", "a.md"), "utf8"), "v1");
  // rollback marker appended
  const ledger = loadLedger(root);
  assert.equal(ledger.length, 3);
  assert.equal(ledger[2].action, "rollback");
  assert.equal(ledger[2].ref, update.id);
  // double rollback refused
  assert.throws(() => rollbackRefine(update.id, { projectRoot: root }), /already rolled back/);
});

test("rollback of a create deletes the file", (t) => {
  const root = workspace(t);
  const record = recordRefine({ projectRoot: root, kind: "prompt", action: "create", target: "review.md", content: "review prompt" });
  assert.equal(fs.existsSync(refineTargetPath(root, ".pi/runtime/refine", "prompt", "review.md")), true);
  rollbackRefine(record.id, { projectRoot: root });
  assert.equal(fs.existsSync(refineTargetPath(root, ".pi/runtime/refine", "prompt", "review.md")), false);
});

test("delete action removes the target and rollback rewrites it", (t) => {
  const root = workspace(t);
  recordRefine({ projectRoot: root, kind: "note", action: "create", target: "b.md", content: "keep me" });
  const removed = recordRefine({ projectRoot: root, kind: "note", action: "delete", target: "b.md" });
  assert.equal(fs.existsSync(refineTargetPath(root, ".pi/runtime/refine", "note", "b.md")), false);
  rollbackRefine(removed.id, { projectRoot: root });
  assert.equal(fs.readFileSync(refineTargetPath(root, ".pi/runtime/refine", "note", "b.md"), "utf8"), "keep me");
});

test("listRefines returns newest first with kind filtering", (t) => {
  const root = workspace(t);
  recordRefine({ projectRoot: root, kind: "note", action: "create", target: "one.md", content: "1" });
  recordRefine({ projectRoot: root, kind: "prompt", action: "create", target: "two.md", content: "2" });
  recordRefine({ projectRoot: root, kind: "note", action: "create", target: "three.md", content: "3" });

  const all = listRefines({ projectRoot: root });
  assert.deepEqual(all.map((record) => record.target), ["three.md", "two.md", "one.md"]);
  const notes = listRefines({ projectRoot: root, kind: "note" });
  assert.deepEqual(notes.map((record) => record.target), ["three.md", "one.md"]);
  assert.equal(listRefines({ projectRoot: root, kind: "file" }).length, 0);
});

test("guards: path confinement, invalid kinds, duplicate create, missing targets", (t) => {
  const root = workspace(t);
  assert.throws(() => recordRefine({ projectRoot: root, kind: "note", action: "create", target: "../escape.md", content: "x" }), /invalid refine target/);
  assert.throws(() => recordRefine({ projectRoot: root, kind: "hack", action: "create", target: "a.md", content: "x" }), /invalid refine kind/);
  assert.throws(() => recordRefine({ projectRoot: root, kind: "note", action: "explode", target: "a.md", content: "x" }), /invalid refine action/);
  recordRefine({ projectRoot: root, kind: "note", action: "create", target: "a.md", content: "x" });
  assert.throws(() => recordRefine({ projectRoot: root, kind: "note", action: "create", target: "a.md", content: "x" }), /already exists/);
  assert.throws(() => recordRefine({ projectRoot: root, kind: "note", action: "update", target: "missing.md", content: "x" }), /does not exist/);
  assert.throws(() => recordRefine({ projectRoot: root, kind: "note", action: "delete", target: "missing.md" }), /does not exist/);
  assert.throws(() => recordRefine({ projectRoot: root, kind: "note", action: "create", target: "empty.md", content: "" }), /requires content/);
  assert.throws(() => rollbackRefine("refine-nope", { projectRoot: root }), /no refine record/);
});

function loadLedger(root) {
  const records = [];
  const file = refineLedgerPath(root, ".pi/runtime/refine");
  if (!fs.existsSync(file)) return records;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) records.push(JSON.parse(line));
  return records;
}
