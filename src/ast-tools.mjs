import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { hashText } from "./stale-edit.mjs";

const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".pi", ".equaxis", "dist", "build", "coverage"]);

function defaultRunCommand(command, args, options) {
  return spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8", windowsHide: true, timeout: 60_000 });
}

function assertWorkspacePath(cwd, absolutePath, label) {
  const relativePath = path.relative(cwd, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) throw new Error(`${label} must stay inside the workspace`);
}

function readTarget(cwd, target) {
  const absolutePath = path.resolve(cwd, String(target ?? ""));
  assertWorkspacePath(cwd, absolutePath, "AST target");
  if (!SUPPORTED_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) throw new Error("AST tools support JavaScript and TypeScript files only");
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) throw new Error(`AST target does not exist: ${target}`);
  return { absolutePath, text: fs.readFileSync(absolutePath, "utf8") };
}

function collectWorkspaceFiles(cwd, targetPath) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const filePath = path.join(directory, entry.name);
      if (SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) files.push(filePath);
    }
  };
  visit(cwd);
  if (!files.includes(targetPath)) files.push(targetPath);
  return files.sort();
}

function createLanguageService(filePath, text, options = {}) {
  const cwd = path.resolve(options.cwd ?? path.dirname(filePath));
  const scope = options.scope === "workspace" ? "workspace" : "file";
  const scriptFiles = scope === "workspace" ? collectWorkspaceFiles(cwd, filePath) : [filePath];
  const textByFile = new Map(scriptFiles.map((name) => [name, name === filePath ? text : fs.readFileSync(name, "utf8")]));
  const host = {
    getScriptFileNames: () => scriptFiles,
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) => textByFile.has(name) ? ts.ScriptSnapshot.fromString(textByFile.get(name)) : ts.sys.fileExists(name) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(name) ?? "") : undefined,
    getCurrentDirectory: () => cwd,
    getCompilationSettings: () => ({ allowJs: true, allowSyntheticDefaultImports: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true }),
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    fileExists: (name) => textByFile.has(name) || ts.sys.fileExists(name),
    readFile: (name) => textByFile.get(name) ?? ts.sys.readFile(name),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists
  };
  return { service: ts.createLanguageService(host), textByFile };
}

function offsetAt(text, line, character) {
  const source = ts.createSourceFile("input.ts", text, ts.ScriptTarget.Latest, true);
  const starts = source.getLineStarts();
  const safeLine = Math.max(0, Math.min(Number(line ?? 0), starts.length - 1));
  const start = starts[safeLine] ?? 0;
  return Math.max(start, Math.min(start + Math.max(0, Number(character ?? 0)), text.length));
}

function rangeFor(text, start, length) {
  const source = ts.createSourceFile("input.ts", text, ts.ScriptTarget.Latest, true);
  const begin = source.getLineAndCharacterOfPosition(start);
  const end = source.getLineAndCharacterOfPosition(start + length);
  return { start: { line: begin.line, character: begin.character }, end: { line: end.line, character: end.character } };
}

function relative(cwd, filePath) { return path.relative(cwd, filePath).replaceAll("\\", "/") || path.basename(filePath); }

function locationSummary(cwd, textByFile, location) {
  const filePath = path.resolve(location.fileName);
  const fileText = textByFile.get(filePath) ?? (fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "");
  return { filePath: relative(cwd, filePath), start: location.textSpan.start, length: location.textSpan.length, range: rangeFor(fileText, location.textSpan.start, location.textSpan.length) };
}

function groupedEdits(cwd, textByFile, locations, newName) {
  const byFile = new Map();
  for (const item of locations) {
    const filePath = path.resolve(item.fileName);
    const fileText = textByFile.get(filePath);
    if (!fileText) continue;
    if (!byFile.has(filePath)) byFile.set(filePath, []);
    byFile.get(filePath).push({ start: item.textSpan.start, length: item.textSpan.length, newText: `${item.prefixText ?? ""}${newName}${item.suffixText ?? ""}`, range: rangeFor(fileText, item.textSpan.start, item.textSpan.length) });
  }
  return [...byFile.entries()].map(([filePath, edits]) => {
    const originalText = textByFile.get(filePath);
    const sorted = edits.sort((left, right) => right.start - left.start);
    let updatedText = originalText;
    for (const edit of sorted) updatedText = updatedText.slice(0, edit.start) + edit.newText + updatedText.slice(edit.start + edit.length);
    return { filePath, path: relative(cwd, filePath), expectedHash: hashText(originalText), editCount: edits.length, edits: sorted, updatedText };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function expectedHashFor(input, fileEdit) {
  const expectedHashes = input.expectedHashes && typeof input.expectedHashes === "object" ? input.expectedHashes : {};
  return String(expectedHashes[fileEdit.path] ?? expectedHashes[fileEdit.filePath] ?? input.expectedHash ?? "").trim().toLowerCase();
}

function writeFileAtomic(filePath, text) {
  const tempPath = `${filePath}.equaxis-ast-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, text, "utf8");
  try { fs.renameSync(tempPath, filePath); } catch (error) { try { fs.rmSync(tempPath, { force: true }); } catch {} throw error; }
}

export function inspectAst(input, options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const target = readTarget(cwd, input.path);
  const scope = input.scope === "workspace" ? "workspace" : "file";
  const { service, textByFile } = createLanguageService(target.absolutePath, target.text, { cwd, scope });
  const offset = offsetAt(target.text, input.line, input.character);
  const quickInfo = service.getQuickInfoAtPosition(target.absolutePath, offset);
  const definitions = service.getDefinitionAtPosition(target.absolutePath, offset) ?? [];
  const rename = service.getRenameInfo(target.absolutePath, offset, { allowRenameOfImportPath: false });
  return { path: relative(cwd, target.absolutePath), scope, position: { line: Number(input.line ?? 0), character: Number(input.character ?? 0) }, symbol: quickInfo?.displayParts ? ts.displayPartsToString(quickInfo.displayParts) : null, kind: quickInfo?.kind ?? null, canRename: Boolean(rename.canRename), renameReason: rename.canRename ? null : rename.localizedErrorMessage, triggerSpan: rename.triggerSpan ? rangeFor(target.text, rename.triggerSpan.start, rename.triggerSpan.length) : null, definitions: definitions.map((item) => locationSummary(cwd, textByFile, item)) };
}

export function renameAst(input, options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const target = readTarget(cwd, input.path);
  const newName = String(input.newName ?? "").trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(newName)) throw new Error("newName must be a valid JavaScript identifier");
  const scope = input.scope === "workspace" ? "workspace" : "file";
  const { service, textByFile } = createLanguageService(target.absolutePath, target.text, { cwd, scope });
  const offset = offsetAt(target.text, input.line, input.character);
  const rename = service.getRenameInfo(target.absolutePath, offset, { allowRenameOfImportPath: false });
  if (!rename.canRename) throw new Error(rename.localizedErrorMessage || "symbol cannot be renamed");
  const locations = service.findRenameLocations(target.absolutePath, offset, false, false, { providePrefixAndSuffixTextForRename: true }) ?? [];
  if (scope !== "workspace" && locations.some((item) => path.resolve(item.fileName) !== target.absolutePath)) throw new Error("rename would modify files outside the selected target; pass scope=workspace to preview all affected files");
  const files = groupedEdits(cwd, textByFile, locations, newName);
  const hashes = Object.fromEntries(files.map((file) => [file.path, file.expectedHash]));
  if (input.apply === true) {
    for (const file of files) {
      const expectedHash = expectedHashFor(input, file);
      if (!expectedHash) throw new Error(`expectedHashes[${file.path}] is required when apply=true`);
      if (expectedHash !== file.expectedHash) throw new Error(`AST target changed since preview: ${file.path}`);
    }
    for (const file of files) writeFileAtomic(file.filePath, file.updatedText);
  }
  const preview = Object.fromEntries(files.map((file) => [file.path, file.updatedText.slice(0, 4000)]));
  const result = { path: relative(cwd, target.absolutePath), scope, symbol: rename.displayName ?? null, newName, changed: files.some((file) => file.editCount > 0), applied: input.apply === true, expectedHash: hashes[relative(cwd, target.absolutePath)] ?? hashText(target.text), expectedHashes: hashes, editCount: files.reduce((sum, file) => sum + file.editCount, 0), files: files.map(({ filePath, updatedText, ...file }) => file), edits: files.find((file) => file.filePath === target.absolutePath)?.edits ?? [], preview: preview[relative(cwd, target.absolutePath)] ?? "", previews: preview };
  // Optional post-apply verification: run a type check after a workspace
  // rename so cross-file breakage surfaces immediately. Opt-in via verify.
  if (input.apply === true && input.verify === "tsc") {
    const run = options.runCommand ?? defaultRunCommand;
    const outcome = run("npx", ["tsc", "--noEmit"], { cwd });
    result.verify = { kind: "tsc", ok: outcome.status === 0, output: String(outcome.stderr || outcome.stdout || "").trim().slice(0, 2000) };
  }
  return result;
}
