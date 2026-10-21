import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectAst, renameAst } from "../src/ast-tools.mjs";

function makeWorkspace(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-ast-"));
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(cwd, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
  }
  return cwd;
}

const GREETER = [
  "export function greet(name: string) {",
  "  return `hi ${name}`;",
  "}",
  "export const caller = greet(\"world\");",
  ""
].join("\n");

// ---------------------------------------------------------------------------
// inspectAst
// ---------------------------------------------------------------------------

test("inspectAst reports the symbol under the cursor and its definitions", () => {
  const cwd = makeWorkspace({ "a.ts": GREETER });
  const report = inspectAst({ path: "a.ts", line: 0, character: 17 }, { cwd });
  assert.equal(report.path, "a.ts");
  assert.equal(report.scope, "file");
  assert.match(report.symbol, /greet/);
  assert.equal(report.canRename, true);
  assert.equal(report.renameReason, null);
  assert.ok(report.definitions.length >= 1, "hovering a declaration resolves to itself");
  assert.equal(report.definitions[0].filePath, "a.ts");
  assert.ok(report.definitions[0].range.start.line >= 0);
});

test("inspectAst searches the workspace when scope=workspace", () => {
  const cwd = makeWorkspace({
    "types.d.ts": "declare const sharedFlag: boolean;\n",
    "b.ts": "const v = sharedFlag;\n"
  });
  const report = inspectAst({ path: "b.ts", line: 0, character: 10, scope: "workspace" }, { cwd });
  assert.equal(report.scope, "workspace");
  assert.match(report.symbol, /sharedFlag/);
  assert.ok(report.definitions.some((definition) => definition.filePath === "types.d.ts"), "the declaration is found across files");
});

// ---------------------------------------------------------------------------
// guards
// ---------------------------------------------------------------------------

test("ast tools refuse targets outside the workspace", () => {
  const cwd = makeWorkspace({ "a.ts": GREETER });
  assert.throws(() => inspectAst({ path: "../escape.ts", line: 0, character: 0 }, { cwd }), /inside the workspace/);
});

test("ast tools refuse unsupported and missing targets", () => {
  const cwd = makeWorkspace({ "notes.txt": "hello\n" });
  assert.throws(() => inspectAst({ path: "notes.txt", line: 0, character: 0 }, { cwd }), /JavaScript and TypeScript files only/);
  assert.throws(() => inspectAst({ path: "missing.ts", line: 0, character: 0 }, { cwd }), /does not exist/);
});

test("renameAst validates the new identifier name", () => {
  const cwd = makeWorkspace({ "a.ts": GREETER });
  assert.throws(() => renameAst({ path: "a.ts", line: 0, character: 17, newName: "1nope" }, { cwd }), /valid JavaScript identifier/);
});

// ---------------------------------------------------------------------------
// renameAst — preview
// ---------------------------------------------------------------------------

test("renameAst previews edits without touching the file", () => {
  const cwd = makeWorkspace({ "a.ts": GREETER });
  const before = fs.readFileSync(path.join(cwd, "a.ts"), "utf8");
  const report = renameAst({ path: "a.ts", line: 0, character: 17, newName: "salute" }, { cwd });

  assert.equal(report.applied, false);
  assert.equal(report.changed, true);
  assert.ok(report.editCount >= 2, "declaration plus its call site");
  assert.match(report.preview, /salute/);
  assert.match(report.expectedHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(report.expectedHashes), ["a.ts"]);
  assert.equal(fs.readFileSync(path.join(cwd, "a.ts"), "utf8"), before, "preview must not write");
});

test("workspace-scope rename previews every affected file", () => {
  const cwd = makeWorkspace({
    "types.d.ts": "declare const sharedFlag: boolean;\n",
    "b.ts": "const v = sharedFlag;\n"
  });
  const report = renameAst({ path: "b.ts", line: 0, character: 10, scope: "workspace", newName: "renamedFlag" }, { cwd });
  assert.equal(report.scope, "workspace");
  assert.deepEqual(Object.keys(report.expectedHashes).sort(), ["b.ts", "types.d.ts"]);
  assert.ok(report.previews["types.d.ts"].includes("renamedFlag"));
  assert.equal(fs.readFileSync(path.join(cwd, "types.d.ts"), "utf8"), "declare const sharedFlag: boolean;\n");
});

// ---------------------------------------------------------------------------
// renameAst — apply
// ---------------------------------------------------------------------------

test("renameAst requires a fresh hash before applying", () => {
  const cwd = makeWorkspace({ "a.ts": GREETER });
  assert.throws(
    () => renameAst({ path: "a.ts", line: 0, character: 17, newName: "salute", apply: true }, { cwd }),
    /expectedHashes\[a\.ts\] is required/
  );
  assert.throws(
    () => renameAst({ path: "a.ts", line: 0, character: 17, newName: "salute", apply: true, expectedHash: "0".repeat(64) }, { cwd }),
    /changed since preview/
  );
  assert.equal(fs.readFileSync(path.join(cwd, "a.ts"), "utf8"), GREETER, "a rejected apply must not write");
});

test("renameAst applies when the hash is fresh", () => {
  const cwd = makeWorkspace({ "a.ts": GREETER });
  const preview = renameAst({ path: "a.ts", line: 0, character: 17, newName: "salute" }, { cwd });
  const applied = renameAst(
    { path: "a.ts", line: 0, character: 17, newName: "salute", apply: true, expectedHashes: preview.expectedHashes },
    { cwd }
  );
  assert.equal(applied.applied, true);
  const written = fs.readFileSync(path.join(cwd, "a.ts"), "utf8");
  assert.match(written, /function salute\(/);
  assert.match(written, /salute\("world"\)/);
  assert.doesNotMatch(written, /\bgreet\b/);
});

test("renameAst applies a workspace rename across files", () => {
  const cwd = makeWorkspace({
    "types.d.ts": "declare const sharedFlag: boolean;\n",
    "b.ts": "const v = sharedFlag;\n"
  });
  const preview = renameAst({ path: "b.ts", line: 0, character: 10, scope: "workspace", newName: "renamedFlag" }, { cwd });
  renameAst(
    { path: "b.ts", line: 0, character: 10, scope: "workspace", newName: "renamedFlag", apply: true, expectedHashes: preview.expectedHashes },
    { cwd }
  );
  assert.match(fs.readFileSync(path.join(cwd, "types.d.ts"), "utf8"), /renamedFlag/);
  assert.match(fs.readFileSync(path.join(cwd, "b.ts"), "utf8"), /renamedFlag/);
});

test("renameAst can run an injected post-apply type check", () => {
  const cwd = makeWorkspace({ "a.ts": GREETER });
  const preview = renameAst({ path: "a.ts", line: 0, character: 17, newName: "salute" }, { cwd });
  const calls = [];
  const ok = renameAst(
    { path: "a.ts", line: 0, character: 17, newName: "salute", apply: true, expectedHashes: preview.expectedHashes, verify: "tsc" },
    { cwd, runCommand: (command, args) => { calls.push([command, ...args].join(" ")); return { status: 0, stdout: "", stderr: "" }; } }
  );
  assert.equal(ok.verify.ok, true);
  assert.equal(ok.verify.kind, "tsc");
  assert.deepEqual(calls, ["npx tsc --noEmit"]);

  const preview2 = renameAst({ path: "a.ts", line: 0, character: 17, newName: "hail" }, { cwd });
  const failed = renameAst(
    { path: "a.ts", line: 0, character: 17, newName: "hail", apply: true, expectedHashes: preview2.expectedHashes, verify: "tsc" },
    { cwd, runCommand: () => ({ status: 2, stdout: "", stderr: "TS2322: boom" }) }
  );
  assert.equal(failed.verify.ok, false);
  assert.match(failed.verify.output, /TS2322/);
});
