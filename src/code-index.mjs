/**
 * CodeGraph — persistent code knowledge index (TencentDB-Agent-Memory
 * CodeGraph asset + vitali87/code-graph-rag, minimal slice).
 *
 * Builds a deterministic JSON index of workspace symbols, imports and
 * call edges using the TypeScript compiler API (already a dependency used
 * by ast-tools.mjs). No graph database required: queries are pure
 * reachability walks over the JSON.
 *
 * Schema (v1):
 *   files[]    { path, imports[{target, external}], exports[] }
 *   symbols[]  { id: "<file>::<qualifiedName>", name, kind, qualifiedName,
 *                file, startLine, endLine, doc, exported }
 *   calls[]    { from, to, resolved[], line, ambiguous, fromFile }
 *
 * `calls.resolved` lists every symbol id whose name matches the callee at
 * build time; `ambiguous` is set when more than one candidate exists
 * (static approximation — the dynamic-call overlay pattern of code-graph-rag
 * would refine this with runtime traces).
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { listCheckpoints } from "./checkpoint-store.mjs";

export const CODE_INDEX_SCHEMA_VERSION = 1;

const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const IGNORED_DIRECTORIES = new Set([
  ".git", "node_modules", ".pi", ".equaxis", "dist", "build", "coverage",
  ".pytest_cache", "__pycache__", "vendor", "pi-web"
]);
const DEFAULT_INCLUDE_DIRS = ["src"];
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_SYMBOLS = 20000;
const DEFAULT_MAX_CALLS = 50000;
const INDEX_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_FILENAMES = INDEX_EXTENSIONS.map((ext) => `index${ext}`);
const EXTERNAL_MODULE_RE = /^(node:|[a-zA-Z@][^./])/;

function relative(cwd, filePath) {
  const rel = path.relative(cwd, filePath).replaceAll("\\", "/");
  return rel || path.basename(filePath);
}

function isDirectory(filePath) {
  try { return fs.statSync(filePath).isDirectory(); } catch { return false; }
}

function isFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

/**
 * Collect source files under `includeDirs` (default ["src"]), sorted,
 * deduplicated, capped at `maxFiles`. Mirrors ast-tools.mjs collection.
 */
export function collectIndexFiles(cwd, { includeDirs = DEFAULT_INCLUDE_DIRS, maxFiles = DEFAULT_MAX_FILES } = {}) {
  const roots = includeDirs.length ? includeDirs.map((dir) => path.resolve(cwd, dir)) : [cwd];
  const files = [];
  const visit = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) files.push(filePath);
    }
  };
  for (const root of roots) if (fs.existsSync(root)) visit(root);
  return [...new Set(files)].sort().slice(0, maxFiles);
}

/** Resolve a relative import specifier to a workspace-relative path, or null. */
export function resolveRelativeImport(cwd, fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, ...INDEX_EXTENSIONS.map((ext) => base + ext), ...INDEX_FILENAMES.map((name) => path.join(base, name))];
  for (const candidate of candidates) {
    if (isFile(candidate)) return relative(cwd, candidate);
  }
  return null;
}

function isExternalModule(specifier) {
  return EXTERNAL_MODULE_RE.test(specifier);
}

function isExported(node) {
  if (!node.modifiers) return false;
  return node.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function isDefaultExport(node) {
  if (!node.modifiers) return false;
  return node.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

function lineOf(node, sourceFile) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function endLineOf(node, sourceFile) {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function jsDocFor(node) {
  try {
    const docs = ts.getJSDocCommentsAndTags(node);
    if (!docs || !docs.length) return "";
    const jsdoc = docs.find((doc) => doc.kind === ts.SyntaxKind.JSDoc);
    if (!jsdoc) return "";
    const comment = jsdoc.comment;
    if (typeof comment === "string") return comment.trim();
    if (Array.isArray(comment)) return comment.map((part) => part.text ?? "").join("").trim();
    return "";
  } catch {
    return "";
  }
}

/**
 * Build a fresh code index over the workspace.
 *
 * @param {object} options
 * @param {string} options.cwd project root
 * @param {string[]} [options.includeDirs] directories to index
 * @param {number} [options.maxFiles] file cap
 * @param {() => string} [options.now] ISO timestamp supplier (injectable for tests)
 */
export function buildCodeIndex({ cwd = process.cwd(), includeDirs = DEFAULT_INCLUDE_DIRS, maxFiles = DEFAULT_MAX_FILES, now = () => new Date().toISOString() } = {}) {
  const projectRoot = path.resolve(cwd);
  const scriptFiles = collectIndexFiles(projectRoot, { includeDirs, maxFiles });
  const files = [];
  const symbols = [];
  const calls = [];
  const nameIndex = new Map(); // symbol name -> symbol ids
  const symbolByFile = new Map(); // relative path -> symbol ids
  let symbolCount = 0;
  let callCount = 0;

  const addSymbol = (entry) => {
    if (symbolCount >= DEFAULT_MAX_SYMBOLS) return;
    const id = `${entry.file}::${entry.qualifiedName}`;
    symbols.push({ id, name: entry.name, kind: entry.kind, qualifiedName: entry.qualifiedName, file: entry.file, startLine: entry.startLine, endLine: entry.endLine, doc: entry.doc, exported: entry.exported });
    symbolCount += 1;
    const ids = nameIndex.get(entry.name) ?? [];
    ids.push(id);
    nameIndex.set(entry.name, ids);
    const fileIds = symbolByFile.get(entry.file) ?? [];
    fileIds.push(id);
    symbolByFile.set(entry.file, fileIds);
  };

  const addCall = (from, toName, line, fromFile) => {
    if (callCount >= DEFAULT_MAX_CALLS) return;
    // Resolution is deferred to a post-pass so the name index is complete
    // (call collection happens while files are still being walked).
    calls.push({ from, to: toName, line, fromFile });
    callCount += 1;
  };

  for (const filePath of scriptFiles) {
    const fileRel = relative(projectRoot, filePath);
    let text;
    try { text = fs.readFileSync(filePath, "utf8"); } catch { continue; }
    const sourceFile = ts.createSourceFile(fileRel, text, ts.ScriptTarget.Latest, true, filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const imports = [];
    const externalImports = [];
    const exports = [];
    const moduleLevelCalls = [];

    const visit = (node) => {
      // imports
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (isExternalModule(specifier)) {
          externalImports.push(specifier);
        } else {
          const target = resolveRelativeImport(projectRoot, filePath, specifier);
          if (target) imports.push({ target, external: false });
          else imports.push({ target: specifier, external: false, unresolved: true });
        }
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (isExternalModule(specifier)) {
          externalImports.push(specifier);
        } else {
          const target = resolveRelativeImport(projectRoot, filePath, specifier);
          if (target) imports.push({ target, external: false });
          else imports.push({ target: specifier, external: false, unresolved: true });
        }
      }

      // symbols
      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        addSymbol({ name: className, kind: "class", qualifiedName: className, file: fileRel, startLine: lineOf(node, sourceFile), endLine: endLineOf(node, sourceFile), doc: jsDocFor(node), exported: isExported(node) || isDefaultExport(node) });
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) {
            const methodName = member.name.text;
            addSymbol({ name: methodName, kind: "method", qualifiedName: `${className}.${methodName}`, file: fileRel, startLine: lineOf(member, sourceFile), endLine: endLineOf(member, sourceFile), doc: jsDocFor(member), exported: isExported(member) });
            const methodId = `${fileRel}::${className}.${methodName}`;
            collectBodyCalls(member, methodId, fileRel, sourceFile);
          }
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        addSymbol({ name, kind: "function", qualifiedName: name, file: fileRel, startLine: lineOf(node, sourceFile), endLine: endLineOf(node, sourceFile), doc: jsDocFor(node), exported: isExported(node) || isDefaultExport(node) });
        collectBodyCalls(node, `${fileRel}::${name}`, fileRel, sourceFile);
      }
      if (ts.isInterfaceDeclaration(node) && node.name) {
        addSymbol({ name: node.name.text, kind: "interface", qualifiedName: node.name.text, file: fileRel, startLine: lineOf(node, sourceFile), endLine: endLineOf(node, sourceFile), doc: jsDocFor(node), exported: isExported(node) || isDefaultExport(node) });
      }
      if (ts.isEnumDeclaration(node) && node.name) {
        addSymbol({ name: node.name.text, kind: "enum", qualifiedName: node.name.text, file: fileRel, startLine: lineOf(node, sourceFile), endLine: endLineOf(node, sourceFile), doc: jsDocFor(node), exported: isExported(node) || isDefaultExport(node) });
      }
      if (ts.isTypeAliasDeclaration(node) && node.name) {
        addSymbol({ name: node.name.text, kind: "type", qualifiedName: node.name.text, file: fileRel, startLine: lineOf(node, sourceFile), endLine: endLineOf(node, sourceFile), doc: jsDocFor(node), exported: isExported(node) || isDefaultExport(node) });
      }
      if (ts.isVariableStatement(node)) {
        const exported = isExported(node);
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && exported) {
            addSymbol({ name: decl.name.text, kind: "variable", qualifiedName: decl.name.text, file: fileRel, startLine: lineOf(decl, sourceFile), endLine: endLineOf(decl, sourceFile), doc: jsDocFor(decl), exported: true });
          }
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    // module-level calls (calls made at file top level, not inside any symbol)
    const moduleLevel = collectModuleLevelCalls(sourceFile, fileRel);
    for (const call of moduleLevel) {
      if (callCount >= DEFAULT_MAX_CALLS) break;
      calls.push({ from: null, to: call.name, line: call.line, fromFile: fileRel });
      callCount += 1;
    }

    const fileRecord = {
      path: fileRel,
      imports,
      importsExternal: [...new Set(externalImports)].sort(),
      exports: [...new Set(exports)].sort()
    };
    files.push(fileRecord);
  }

  // Post-pass: resolve every call against the complete name index so results
  // do not depend on file walk order. Ambiguity is flagged, not guessed.
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    const resolved = nameIndex.get(call.to) ?? [];
    call.resolved = resolved;
    call.ambiguous = resolved.length > 1;
  }

  // exports per file (symbols declared exported in that file)
  for (const fileRecord of files) {
    const fileIds = symbolByFile.get(fileRecord.path) ?? [];
    fileRecord.exports = fileIds
      .map((id) => symbols.find((symbol) => symbol.id === id))
      .filter((symbol) => symbol?.exported)
      .map((symbol) => symbol.qualifiedName)
      .sort();
  }

  const importEdges = files.reduce((sum, file) => sum + file.imports.length, 0);

  return {
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    cwd: projectRoot,
    builtAt: now(),
    includeDirs: [...includeDirs],
    files,
    symbols,
    calls,
    stats: {
      files: files.length,
      symbols: symbols.length,
      importEdges,
      callEdges: calls.length,
      externalImports: files.reduce((sum, file) => sum + file.importsExternal.length, 0)
    }
  };

  function collectBodyCalls(container, fromId, fromFile, source) {
    if (callCount >= DEFAULT_MAX_CALLS) return;
    const visitBody = (node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = calleeName(node, source);
        if (name) addCall(fromId, name, lineOf(node, source), fromFile, source);
      }
      ts.forEachChild(node, visitBody);
    };
    ts.forEachChild(container, visitBody);
  }

  function collectModuleLevelCalls(source, fromFile) {
    const found = [];
    const walk = (node, inFunction) => {
      if (!inFunction && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
        const name = calleeName(node, source);
        if (name) found.push({ name, line: lineOf(node, source) });
      }
      const nextInFunction = inFunction || ts.isFunctionLike(node);
      ts.forEachChild(node, (child) => walk(child, nextInFunction));
    };
    walk(source, false);
    return found;
  }

  function calleeName(node, source) {
    const expression = node.expression;
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) {
      const name = expression.name;
      return ts.isIdentifier(name) ? name.text : name.getText(source);
    }
    if (ts.isElementAccessExpression(expression)) {
      const arg = expression.argumentExpression;
      if (arg && (ts.isStringLiteral(arg) || ts.isNumericLiteral(arg))) return arg.text;
    }
    return null;
  }
}

/** Symbol lookup by exact name / kind / file (all optional filters). */
export function findSymbols(index, { name, kind, file } = {}) {
  return index.symbols.filter((symbol) => {
    if (name !== undefined && symbol.name !== name) return false;
    if (kind !== undefined && symbol.kind !== kind) return false;
    if (file !== undefined && symbol.file !== file) return false;
    return true;
  });
}

function symbolIdsFor(index, target) {
  // target is either a full symbol id ("file::name") or a plain name
  const exact = index.symbols.find((symbol) => symbol.id === target);
  if (exact) return [exact.id];
  return index.symbols.filter((symbol) => symbol.name === target).map((symbol) => symbol.id);
}

/** Every caller edge of a symbol id or name (symbol-level and module-level). */
export function queryCallers(index, target) {
  const ids = new Set(symbolIdsFor(index, target));
  if (!ids.size) return [];
  return index.calls
    .filter((call) => call.resolved.some((id) => ids.has(id)))
    .map((call) => ({
      from: call.from,
      fromFile: call.fromFile,
      line: call.line,
      ambiguous: call.ambiguous,
      fromSymbol: call.from ? index.symbols.find((symbol) => symbol.id === call.from) : null
    }));
}

/** Every callee edge of a symbol id. */
export function queryCallees(index, symbolId) {
  return index.calls
    .filter((call) => call.from === symbolId)
    .map((call) => ({
      to: call.to,
      resolved: call.resolved,
      line: call.line,
      ambiguous: call.ambiguous
    }));
}

/** Files that import the given workspace-relative file path. */
export function queryImporters(index, filePath) {
  return index.files
    .filter((file) => file.imports.some((imp) => imp.target === filePath && !imp.external))
    .map((file) => file.path);
}

/** Exported symbols declared in a file (workspace-relative path). */
export function queryExports(index, filePath) {
  return index.symbols.filter((symbol) => symbol.file === filePath && symbol.exported);
}

/**
 * Change-impact closure: every symbol that transitively calls `seed`
 * (upstream) plus every file that transitively imports its file, so a
 * refactor of `seed` knows what to re-test. Returns a BFS depth per hit.
 */
export function impactClosure(index, seed, { maxDepth = 12 } = {}) {
  const seedIds = new Set(symbolIdsFor(index, seed));
  if (!seedIds.size) return { found: false, symbols: [], files: [], depth: 0 };

  const seedFile = seedIds.size ? index.symbols.find((symbol) => symbol.id === [...seedIds][0])?.file : null;
  const symbolDepth = new Map();
  const fileDepth = new Map();
  const queue = [];

  for (const id of seedIds) {
    symbolDepth.set(id, 0);
    queue.push({ type: "symbol", id, depth: 0 });
  }
  if (seedFile) {
    fileDepth.set(seedFile, 0);
    queue.push({ type: "file", path: seedFile, depth: 0 });
  }

  while (queue.length) {
    const item = queue.shift();
    if (item.depth >= maxDepth) continue;
    if (item.type === "symbol") {
      const callers = queryCallers(index, item.id);
      for (const caller of callers) {
        if (!caller.from) {
          // module-level caller: mark its file as impacted
          if (caller.fromFile && !fileDepth.has(caller.fromFile)) {
            fileDepth.set(caller.fromFile, item.depth + 1);
            queue.push({ type: "file", path: caller.fromFile, depth: item.depth + 1 });
          }
          continue;
        }
        if (!symbolDepth.has(caller.from)) {
          symbolDepth.set(caller.from, item.depth + 1);
          queue.push({ type: "symbol", id: caller.from, depth: item.depth + 1 });
        }
      }
    } else {
      const importers = queryImporters(index, item.path);
      for (const importer of importers) {
        if (!fileDepth.has(importer)) {
          fileDepth.set(importer, item.depth + 1);
          queue.push({ type: "file", path: importer, depth: item.depth + 1 });
        }
      }
    }
  }

  return {
    found: true,
    symbols: [...symbolDepth.entries()]
      .filter(([id]) => !seedIds.has(id))
      .map(([id, depth]) => ({ id, depth })),
    files: [...fileDepth.entries()]
      .filter(([file]) => file !== seedFile)
      .map(([file, depth]) => ({ file, depth })),
    depth: Math.max(0, ...symbolDepth.values(), ...fileDepth.values())
  };
}

/**
 * Dead-code report: files unreachable from entry roots via import edges,
 * and symbols neither exported nor targeted by any call edge.
 * With no entryRoots, files nothing imports are treated as roots.
 *
 * @param {object} index
 * @param {{entryRoots?: string[]}} [options]
 */
export function deadCodeReport(index, { entryRoots = [] } = {}) {
  const fileSet = new Set(index.files.map((file) => file.path));
  const roots = entryRoots.length
    ? entryRoots.filter((file) => fileSet.has(file))
    : index.files.filter((file) => !index.files.some((other) => other.imports.some((imp) => imp.target === file.path))).map((file) => file.path);

  const reachable = new Set();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.shift();
    if (reachable.has(file)) continue;
    reachable.add(file);
    const record = index.files.find((entry) => entry.path === file);
    for (const imp of record?.imports ?? []) {
      if (!imp.external && fileSet.has(imp.target)) queue.push(imp.target);
    }
  }

  const unreachableFiles = index.files
    .filter((file) => !reachable.has(file.path))
    .map((file) => ({ path: file.path, symbols: index.symbols.filter((symbol) => symbol.file === file.path).map((symbol) => symbol.id) }));

  const targeted = new Set(index.calls.flatMap((call) => call.resolved));
  const unreachableSymbols = index.symbols
    .filter((symbol) => !symbol.exported && !targeted.has(symbol.id))
    .map((symbol) => ({ id: symbol.id, name: symbol.name, kind: symbol.kind, file: symbol.file }));

  return { roots: [...roots], reachableFiles: [...reachable].sort(), unreachableFiles, unreachableSymbols };
}

export function saveCodeIndex(index, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index), "utf8");
  fs.renameSync(tmp, filePath);
  return filePath;
}

export function loadCodeIndex(filePath) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  if (!record || record.schemaVersion !== CODE_INDEX_SCHEMA_VERSION || !Array.isArray(record.files) || !Array.isArray(record.symbols) || !Array.isArray(record.calls)) {
    return null;
  }
  return record;
}

export function codeIndexPath(projectRoot, rootDir) {
  return path.join(path.resolve(projectRoot), rootDir, "index.json");
}

/** Whether a persisted index is still fresh enough to reuse. */
export function isIndexFresh(index, { maxAgeMs = 6 * 3600 * 1000, now = Date.now() } = {}) {
  if (!index?.builtAt) return false;
  const built = Date.parse(index.builtAt);
  if (!Number.isFinite(built)) return false;
  return now() - built <= maxAgeMs;
}

/**
 * Dynamic-edit overlay (code-graph-rag "cgr trace" minimal slice): merge
 * files edited by recent runs into the static index and flag edited symbols
 * that no static caller (and no file importer) references — the analog of
 * cgr's static_missed flag for dynamically-dispatched callsites. A freshly
 * edited symbol with zero static references is the highest-risk edit: either
 * dead code, or a break the static graph cannot see.
 *
 * @param {object} index
 * @param {Array<{file: string, at?: string|null}>} edits workspace-relative
 *   edited file paths (newest first)
 */
export function overlayTraceEdits(index, edits = []) {
  const fileSet = new Set(index.files.map((file) => file.path));
  const touched = [];
  const editedWithoutCallers = [];
  const editedFileUnreferenced = [];
  const seenFiles = new Set();
  for (const edit of edits) {
    const file = String(edit.file ?? "").replaceAll("\\", "/");
    if (!fileSet.has(file) || seenFiles.has(file)) continue;
    seenFiles.add(file);
    const symbols = index.symbols.filter((symbol) => symbol.file === file);
    for (const symbol of symbols) {
      const hasCallers = index.calls.some((call) => call.resolved.includes(symbol.id));
      if (!hasCallers) {
        editedWithoutCallers.push({ id: symbol.id, name: symbol.name, kind: symbol.kind, file });
      }
    }
    const fileImported = index.files.some((entry) => entry.imports.some((imp) => imp.target === file && !imp.external));
    if (!fileImported) {
      editedFileUnreferenced.push({ file });
    }
    touched.push({ file, at: edit.at ?? null, symbols: symbols.map((symbol) => symbol.id) });
  }
  const dynamicEdges = touched.flatMap((entry) => entry.symbols.map((id) => ({ file: entry.file, symbol: id })));
  return { touched, editedWithoutCallers, editedFileUnreferenced, dynamicEdges };
}

/**
 * Collect files edited by recent write/edit runs from the tool-level
 * checkpoint store (newest first, deduplicated). Checkpoints snapshot the
 * targets of every mutating tool call, so they are a deterministic,
 * trace-schema-free record of "what the agent has been touching".
 */
export function collectEditedFilesFromCheckpoints(projectRoot, { traceDir = ".pi/runtime", limit = 20 } = {}) {
  const checkpoints = listCheckpoints(path.resolve(projectRoot), traceDir, limit);
  const edits = [];
  const seen = new Set();
  for (const checkpoint of checkpoints) {
    for (const file of checkpoint.files ?? []) {
      const normalized = String(file).replaceAll("\\", "/");
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      edits.push({ file: normalized, at: checkpoint.createdAt ?? null, checkpointId: checkpoint.id });
    }
  }
  return edits;
}
