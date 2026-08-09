import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { inspectAst, renameAst } from "../src/ast-tools.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-ast-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "sample.ts");
  fs.writeFileSync(file, "const value = 1;\nconsole.log(value);\n", "utf8");
  return { root, file: "sample.ts" };
}

test("inspects a TypeScript symbol and reports rename capability", (t) => {
  const { root, file } = fixture(t);
  const result = inspectAst({ path: file, line: 0, character: 7 }, { cwd: root });
  assert.equal(result.canRename, true);
  assert.match(result.symbol, /value/);
  assert.equal(result.definitions.length, 1);
});

test("previews and applies a hash-checked AST rename", (t) => {
  const { root, file } = fixture(t);
  const preview = renameAst({ path: file, line: 0, character: 7, newName: "renamed" }, { cwd: root });
  assert.equal(preview.applied, false);
  assert.equal(preview.editCount, 2);
  const applied = renameAst({ path: file, line: 0, character: 7, newName: "renamed", apply: true, expectedHash: preview.expectedHash }, { cwd: root });
  assert.equal(applied.applied, true);
  assert.match(fs.readFileSync(path.join(root, file), "utf8"), /const renamed = 1;[\s\S]*renamed/);
});

test("rejects stale AST rename applications and invalid identifiers", (t) => {
  const { root, file } = fixture(t);
  const preview = renameAst({ path: file, line: 0, character: 7, newName: "renamed" }, { cwd: root });
  fs.appendFileSync(path.join(root, file), "\n", "utf8");
  assert.throws(() => renameAst({ path: file, line: 0, character: 7, newName: "renamed", apply: true, expectedHash: preview.expectedHash }, { cwd: root }), /changed since preview/);
  assert.throws(() => renameAst({ path: file, line: 0, character: 7, newName: "not-valid" }, { cwd: root }), /valid JavaScript identifier/);
});