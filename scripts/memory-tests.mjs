#!/usr/bin/env node

/**
 * Run the Python memory tests through a project virtualenv when one exists.
 *
 * `python bridge/run_memory_tests.py` needs pytest (and the vendored
 * agent-memory dependencies) importable by the interpreter. On PEP 668
 * "externally managed" distributions a bare `pip install` is refused, so the
 * supported setup is a repo-local `.venv` created by `npm run setup:python`.
 * This wrapper prefers that interpreter and reports an actionable message
 * instead of a bare ModuleNotFoundError when it is absent.
 *
 * Note: the first test that touches the long-term store makes chromadb download
 * its default `all-MiniLM-L6-v2` ONNX embedding model from HuggingFace. On a
 * host that cannot reach that CDN the suite will block in that test even though
 * the environment itself is correctly set up.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const venvPython = path.join(root, ".venv", isWindows ? "Scripts" : "bin", isWindows ? "python.exe" : "python");

let command = "python";
let usingVenv = false;
if (fs.existsSync(venvPython)) {
  command = venvPython;
  usingVenv = true;
} else if (isWindows) {
  command = "python";
}

function probe(interpreter, moduleName) {
  const result = spawnSync(interpreter, ["-c", `import ${moduleName}`], { cwd: root, encoding: "utf8" });
  return result.status === 0;
}

if (!probe(command, "pytest")) {
  console.error(
    [
      `test:memory requires pytest, but "${command}" cannot import it.`,
      "",
      "Set it up once with:",
      "  npm run setup:python",
      "",
      "(creates .venv, installs pytest + pytest-asyncio and the vendored agent-memory package)"
    ].join("\n")
  );
  process.exit(1);
}

const result = spawnSync(command, [path.join("bridge", "run_memory_tests.py")], { cwd: root, stdio: "inherit" });
if (result.error) {
  console.error(`test:memory failed to start ${command}: ${result.error.message}`);
  process.exit(1);
}
if (usingVenv) console.error(`test:memory: using ${path.relative(root, venvPython)}`);
process.exit(result.status ?? 1);
