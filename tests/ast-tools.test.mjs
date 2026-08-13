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

test("previews and applies workspace-scoped AST renames across files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-ast-workspace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.ts"), "export const value = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, "b.ts"), "import { value } from './a';\nconsole.log(value);\n", "utf8");

  const singleFilePreview = renameAst({ path: "a.ts", line: 0, character: 13, newName: "renamed" }, { cwd: root });
  assert.deepEqual(Object.keys(singleFilePreview.expectedHashes), ["a.ts"]);
  const preview = renameAst({ path: "a.ts", line: 0, character: 13, newName: "renamed", scope: "workspace" }, { cwd: root });
  assert.ok(preview.editCount >= 3);
  assert.deepEqual(Object.keys(preview.expectedHashes).sort(), ["a.ts", "b.ts"]);
  assert.match(preview.previews["b.ts"], /renamed/);

  const applied = renameAst({ path: "a.ts", line: 0, character: 13, newName: "renamed", scope: "workspace", apply: true, expectedHashes: preview.expectedHashes }, { cwd: root });
  assert.equal(applied.applied, true);
  assert.match(fs.readFileSync(path.join(root, "a.ts"), "utf8"), /export const renamed/);
  const consumerText = fs.readFileSync(path.join(root, "b.ts"), "utf8");
  assert.match(consumerText, /renamed/);
  assert.doesNotMatch(consumerText, /\bvalue\b/);
  assert.match(consumerText, /console\.log\(renamed\)/);
});

test("rejects workspace AST apply when any affected file changed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-ast-stale-workspace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.ts"), "export const value = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, "b.ts"), "import { value } from './a';\nconsole.log(value);\n", "utf8");
  const preview = renameAst({ path: "a.ts", line: 0, character: 13, newName: "renamed", scope: "workspace" }, { cwd: root });
  fs.appendFileSync(path.join(root, "b.ts"), "\n", "utf8");
  assert.throws(() => renameAst({ path: "a.ts", line: 0, character: 13, newName: "renamed", scope: "workspace", apply: true, expectedHashes: preview.expectedHashes }, { cwd: root }), /b\.ts|changed since preview/);
});
test("workspace apply can verify with tsc after applying", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-ast-verify-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.ts"), "export const value = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, "b.ts"), "import { value } from './a';\nconsole.log(value);\n", "utf8");
  const preview = renameAst({ path: "a.ts", line: 0, character: 13, newName: "renamed", scope: "workspace" }, { cwd: root });
  const applied = renameAst({
    path: "a.ts", line: 0, character: 13, newName: "renamed", scope: "workspace",
    apply: true, expectedHashes: preview.expectedHashes, verify: "tsc"
  }, {
    cwd: root,
    runCommand: () => ({ status: 0, stdout: "", stderr: "" })
  });
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.verify, { kind: "tsc", ok: true, output: "" });
});

test("verify reports a failing type check without blocking the apply", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-ast-verify-fail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.ts"), "export const value = 1;\n", "utf8");
  const preview = renameAst({ path: "a.ts", line: 0, character: 13, newName: "renamed" }, { cwd: root });
  const applied = renameAst({ path: "a.ts", line: 0, character: 13, newName: "renamed", apply: true, expectedHash: preview.expectedHash, verify: "tsc" }, {
    cwd: root,
    runCommand: () => ({ status: 1, stdout: "", stderr: "error TS2304: cannot find name 'renamed'" })
  });
  assert.equal(applied.applied, true, "apply still lands");
  assert.equal(applied.verify.ok, false);
  assert.match(applied.verify.output, /TS2304/);
});
