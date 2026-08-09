import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { hashText } from "./stale-edit.mjs";

const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);

function readTarget(cwd, target) {
  const absolutePath = path.resolve(cwd, String(target ?? ""));
  if (!SUPPORTED_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) throw new Error("AST tools support JavaScript and TypeScript files only");
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) throw new Error(`AST target does not exist: ${target}`);
  return { absolutePath, text: fs.readFileSync(absolutePath, "utf8") };
}

function createLanguageService(filePath, text) {
  const host = {
    getScriptFileNames: () => [filePath],
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) => name === filePath ? ts.ScriptSnapshot.fromString(text) : ts.sys.fileExists(name) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(name) ?? "") : undefined,
    getCurrentDirectory: () => path.dirname(filePath),
    getCompilationSettings: () => ({ allowJs: true, allowSyntheticDefaultImports: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true }),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists
  };
  return ts.createLanguageService(host);
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

export function inspectAst(input, options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const target = readTarget(cwd, input.path);
  const service = createLanguageService(target.absolutePath, target.text);
  const offset = offsetAt(target.text, input.line, input.character);
  const quickInfo = service.getQuickInfoAtPosition(target.absolutePath, offset);
  const definitions = service.getDefinitionAtPosition(target.absolutePath, offset) ?? [];
  const rename = service.getRenameInfo(target.absolutePath, offset, { allowRenameOfImportPath: false });
  return { path: relative(cwd, target.absolutePath), position: { line: Number(input.line ?? 0), character: Number(input.character ?? 0) }, symbol: quickInfo?.displayParts ? ts.displayPartsToString(quickInfo.displayParts) : null, kind: quickInfo?.kind ?? null, canRename: Boolean(rename.canRename), renameReason: rename.canRename ? null : rename.localizedErrorMessage, triggerSpan: rename.triggerSpan ? rangeFor(target.text, rename.triggerSpan.start, rename.triggerSpan.length) : null, definitions: definitions.map((item) => locationSummary(cwd, new Map([[target.absolutePath, target.text]]), item)) };
}

export function renameAst(input, options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const target = readTarget(cwd, input.path);
  const newName = String(input.newName ?? "").trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(newName)) throw new Error("newName must be a valid JavaScript identifier");
  const service = createLanguageService(target.absolutePath, target.text);
  const offset = offsetAt(target.text, input.line, input.character);
  const rename = service.getRenameInfo(target.absolutePath, offset, { allowRenameOfImportPath: false });
  if (!rename.canRename) throw new Error(rename.localizedErrorMessage || "symbol cannot be renamed");
  const locations = service.findRenameLocations(target.absolutePath, offset, false, false, { providePrefixAndSuffixTextForRename: true }) ?? [];
  const textByFile = new Map([[target.absolutePath, target.text]]);
  if (locations.some((item) => path.resolve(item.fileName) !== target.absolutePath)) throw new Error("rename would modify files outside the selected target");
  const edits = locations.map((item) => ({ start: item.textSpan.start, length: item.textSpan.length, newText: `${item.prefixText ?? ""}${newName}${item.suffixText ?? ""}`, range: rangeFor(target.text, item.textSpan.start, item.textSpan.length) })).sort((left, right) => right.start - left.start);
  let updatedText = target.text;
  for (const edit of edits) updatedText = updatedText.slice(0, edit.start) + edit.newText + updatedText.slice(edit.start + edit.length);
  const actualHash = hashText(target.text);
  const expectedHash = String(input.expectedHash ?? "").trim().toLowerCase();
  if (input.apply === true) {
    if (!expectedHash) throw new Error("expectedHash is required when apply=true");
    if (expectedHash !== actualHash) throw new Error("AST target changed since preview; refresh expectedHash");
    const tempPath = `${target.absolutePath}.equaxis-ast-${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, updatedText, "utf8");
    try { fs.renameSync(tempPath, target.absolutePath); } catch (error) { try { fs.rmSync(tempPath, { force: true }); } catch {} throw error; }
  }
  return { path: relative(cwd, target.absolutePath), symbol: rename.displayName ?? null, newName, changed: edits.length > 0, applied: input.apply === true, expectedHash: actualHash, editCount: edits.length, edits, preview: updatedText.slice(0, 4000) };
}