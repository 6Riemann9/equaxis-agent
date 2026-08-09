import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { hashText, validateEditFreshness } from "../src/stale-edit.mjs";

function workspace(t, content = "alpha\nbeta\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-stale-edit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "file.txt"), content, "utf8");
  return root;
}

test("accepts fresh exact replacements", (t) => {
  const root = workspace(t);
  const result = validateEditFreshness("edit", { path: "file.txt", oldText: "beta" }, { cwd: root });
  assert.equal(result, null);
});

test("detects stale hash mismatches before editing", (t) => {
  const root = workspace(t);
  const result = validateEditFreshness("edit", { path: "file.txt", oldText: "beta", expectedHash: hashText("old") }, { cwd: root });
  assert.equal(result.code, "STALE_EDIT_HASH_MISMATCH");
  assert.equal(result.retryable, true);
});

test("detects missing and ambiguous oldText", (t) => {
  const root = workspace(t, "same\nsame\n");
  assert.equal(validateEditFreshness("edit", { path: "file.txt", oldText: "missing" }, { cwd: root }).code, "STALE_EDIT_OLD_TEXT_MISSING");
  assert.equal(validateEditFreshness("edit", { path: "file.txt", oldText: "same" }, { cwd: root }).code, "STALE_EDIT_OLD_TEXT_AMBIGUOUS");
});

test("ignores non-edit tools", () => {
  assert.equal(validateEditFreshness("write", { path: "file.txt" }, { cwd: process.cwd() }), null);
});
