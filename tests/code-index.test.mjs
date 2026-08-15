import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCodeIndex,
  deadCodeReport,
  findSymbols,
  impactClosure,
  isIndexFresh,
  loadCodeIndex,
  queryCallees,
  queryCallers,
  queryExports,
  queryImporters,
  resolveRelativeImport,
  saveCodeIndex
} from "../src/code-index.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-index-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  return root;
}

function writeFixture(root) {
  fs.writeFileSync(path.join(root, "src", "a.ts"), `/**
 * Main entry.
 */
import { helper } from "./b";
import fs from "node:fs";
export function main(): number {
  return helper();
}
const x = run();
`);
  fs.writeFileSync(path.join(root, "src", "b.ts"), `/** Adds one. */
export function helper(): number {
  return 1;
}
export function run(): number {
  return 2;
}
function unused(): void {}
`);
  fs.writeFileSync(path.join(root, "src", "c.ts"), `import { main } from "./a";
export class Service {
  run(): number {
    return main();
  }
}
function run(): number {
  return 3;
}
`);
  fs.writeFileSync(path.join(root, "src", "d.ts"), `export function standalone(): void {}
`);
}

test("buildCodeIndex indexes symbols, imports, calls and external imports", (t) => {
  const root = workspace(t);
  writeFixture(root);
  const index = buildCodeIndex({ cwd: root, now: () => "2026-08-15T00:00:00.000Z" });

  assert.equal(index.schemaVersion, 1);
  assert.equal(index.stats.files, 4);
  assert.equal(index.stats.symbols, 8); // main helper run unused Service Service.run run standalone
  assert.equal(index.stats.importEdges, 2);
  assert.equal(index.stats.externalImports, 1);

  const a = index.files.find((file) => file.path === "src/a.ts");
  assert.deepEqual(a.imports, [{ target: "src/b.ts", external: false }]);
  assert.deepEqual(a.importsExternal, ["node:fs"]);
  const c = index.files.find((file) => file.path === "src/c.ts");
  assert.deepEqual(c.imports, [{ target: "src/a.ts", external: false }]);
  assert.deepEqual(c.exports, ["Service"]);

  const helper = findSymbols(index, { name: "helper" });
  assert.equal(helper.length, 1);
  assert.equal(helper[0].id, "src/b.ts::helper");
  assert.equal(helper[0].kind, "function");
  assert.equal(helper[0].exported, true);
  assert.equal(helper[0].doc, "Adds one.");

  const service = findSymbols(index, { name: "Service" });
  assert.equal(service[0].qualifiedName, "Service");
  const method = findSymbols(index, { name: "run", kind: "method" });
  assert.equal(method.length, 1);
  assert.equal(method[0].qualifiedName, "Service.run");
  assert.equal(method[0].file, "src/c.ts");

  const unused = findSymbols(index, { name: "unused" });
  assert.equal(unused[0].exported, false);
});

test("call edges resolve callees and flag ambiguity", (t) => {
  const root = workspace(t);
  writeFixture(root);
  const index = buildCodeIndex({ cwd: root });

  // main -> helper (exact)
  const callees = queryCallees(index, "src/a.ts::main");
  assert.equal(callees.length, 1);
  assert.equal(callees[0].to, "helper");
  assert.deepEqual(callees[0].resolved, ["src/b.ts::helper"]);
  assert.equal(callees[0].ambiguous, false);

  // module-level run() call is ambiguous across 3 definitions
  const moduleLevel = index.calls.filter((call) => call.from === null && call.to === "run");
  assert.equal(moduleLevel.length, 1);
  assert.equal(moduleLevel[0].ambiguous, true);
  assert.equal(moduleLevel[0].resolved.length, 3);

  // Service.run -> main
  const methodCallees = queryCallees(index, "src/c.ts::Service.run");
  assert.deepEqual(methodCallees.map((call) => call.to), ["main"]);
});

test("queryCallers returns symbol-level and module-level callers", (t) => {
  const root = workspace(t);
  writeFixture(root);
  const index = buildCodeIndex({ cwd: root });

  const callersOfHelper = queryCallers(index, "helper");
  assert.equal(callersOfHelper.length, 1);
  assert.equal(callersOfHelper[0].from, "src/a.ts::main");
  assert.equal(callersOfHelper[0].fromFile, "src/a.ts");

  const callersOfMain = queryCallers(index, "src/a.ts::main");
  assert.equal(callersOfMain.length, 1);
  assert.equal(callersOfMain[0].from, "src/c.ts::Service.run");

  // module-level callers surface with from === null
  const callersOfRun = queryCallers(index, "src/b.ts::run");
  assert.ok(callersOfRun.some((caller) => caller.from === null && caller.fromFile === "src/a.ts"));
});

test("importers and exports queries", (t) => {
  const root = workspace(t);
  writeFixture(root);
  const index = buildCodeIndex({ cwd: root });

  assert.deepEqual(queryImporters(index, "src/b.ts"), ["src/a.ts"]);
  assert.deepEqual(queryImporters(index, "src/a.ts"), ["src/c.ts"]);
  assert.deepEqual(queryImporters(index, "src/missing.ts"), []);

  assert.deepEqual(queryExports(index, "src/a.ts").map((symbol) => symbol.qualifiedName), ["main"]);
  assert.deepEqual(queryExports(index, "src/b.ts").map((symbol) => symbol.qualifiedName).sort(), ["helper", "run"]);
  assert.deepEqual(queryExports(index, "src/d.ts").map((symbol) => symbol.qualifiedName), ["standalone"]);
});

test("impactClosure walks upstream callers and file importers", (t) => {
  const root = workspace(t);
  writeFixture(root);
  const index = buildCodeIndex({ cwd: root });

  const impact = impactClosure(index, "src/b.ts::helper");
  assert.equal(impact.found, true);
  assert.deepEqual(
    impact.symbols.map((entry) => entry.id).sort(),
    ["src/a.ts::main", "src/c.ts::Service.run"]
  );
  assert.deepEqual(impact.files.map((entry) => entry.file).sort(), ["src/a.ts", "src/c.ts"]);

  const unknown = impactClosure(index, "src/z.ts::nope");
  assert.equal(unknown.found, false);

  // seed by plain name works too
  const byName = impactClosure(index, "helper");
  assert.equal(byName.found, true);
});

test("deadCodeReport finds unreachable files and unused symbols", (t) => {
  const root = workspace(t);
  writeFixture(root);
  const index = buildCodeIndex({ cwd: root });

  const report = deadCodeReport(index, { entryRoots: ["src/c.ts"] });
  assert.deepEqual(report.reachableFiles.sort(), ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.deepEqual(report.unreachableFiles.map((entry) => entry.path), ["src/d.ts"]);
  assert.deepEqual(report.unreachableSymbols.map((entry) => entry.id), ["src/b.ts::unused"]);
  assert.deepEqual(report.roots, ["src/c.ts"]);

  // without entryRoots, zero-importer files are treated as roots
  const autoRoots = deadCodeReport(index);
  assert.ok(autoRoots.roots.includes("src/d.ts"));
  assert.deepEqual(autoRoots.unreachableFiles, []);
});

test("persistence round-trips and rejects corrupt files", (t) => {
  const root = workspace(t);
  writeFixture(root);
  const index = buildCodeIndex({ cwd: root });
  const file = path.join(root, ".pi", "runtime", "code-graph", "index.json");

  saveCodeIndex(index, file);
  const restored = loadCodeIndex(file);
  assert.equal(restored.schemaVersion, 1);
  assert.deepEqual(restored.symbols, index.symbols);
  assert.deepEqual(restored.calls, index.calls);
  assert.deepEqual(restored.stats, index.stats);

  fs.writeFileSync(file, "not json");
  assert.equal(loadCodeIndex(file), null);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, files: [], symbols: [], calls: [] }));
  assert.equal(loadCodeIndex(file), null);
  assert.equal(loadCodeIndex(path.join(root, "missing.json")), null);
});

test("isIndexFresh rejects stale or malformed indexes", () => {
  assert.equal(isIndexFresh({ builtAt: new Date().toISOString() }, { now: Date.now }), true);
  assert.equal(isIndexFresh({ builtAt: "2000-01-01T00:00:00.000Z" }, { now: Date.now }), false);
  assert.equal(isIndexFresh({}, { now: Date.now }), false);
  assert.equal(isIndexFresh({ builtAt: "not-a-date" }, { now: Date.now }), false);
  assert.equal(
    isIndexFresh({ builtAt: "2026-08-15T00:00:00.000Z" }, { now: () => Date.parse("2026-08-15T02:00:00.000Z"), maxAgeMs: 3600_000 }),
    false
  );
});

test("resolveRelativeImport handles extension and index resolution", (t) => {
  const root = workspace(t);
  writeFixture(root);
  fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "lib", "index.ts"), "export const lib = 1;\n");
  fs.writeFileSync(path.join(root, "src", "raw.mjs"), "export const raw = 1;\n");

  assert.equal(resolveRelativeImport(root, path.join(root, "src", "a.ts"), "./b"), "src/b.ts");
  assert.equal(resolveRelativeImport(root, path.join(root, "src", "a.ts"), "./lib"), "src/lib/index.ts");
  assert.equal(resolveRelativeImport(root, path.join(root, "src", "a.ts"), "./raw"), "src/raw.mjs");
  assert.equal(resolveRelativeImport(root, path.join(root, "src", "a.ts"), "./missing"), null);
  assert.equal(resolveRelativeImport(root, path.join(root, "src", "a.ts"), "node:fs"), null);
});

test("empty workspace builds an empty index without throwing", (t) => {
  const root = workspace(t);
  const index = buildCodeIndex({ cwd: root });
  assert.equal(index.stats.files, 0);
  assert.equal(index.stats.symbols, 0);
  assert.deepEqual(deadCodeReport(index).reachableFiles, []);
});
