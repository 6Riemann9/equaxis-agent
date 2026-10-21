#!/usr/bin/env node

/**
 * Type-check the extension tree.
 *
 * `tsc --noEmit` alone finds no tsconfig.json at the package root and exits 0,
 * which made `npm run verify` (check && test) pass without type-checking
 * anything. This wrapper points tsc at the real project file.
 *
 * The published package ships neither `tsconfig.extensions.json` nor the 65MB
 * `pi-versions/` .d.ts stubs, so an installed copy reports an explicit skip
 * instead of a silent success.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = path.join(root, "tsconfig.extensions.json");

if (!fs.existsSync(config)) {
  console.log("check: types skipped — tsconfig.extensions.json is not part of this install (run from a repo checkout to type-check extensions)");
  process.exit(0);
}

const localTsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const command = fs.existsSync(localTsc) ? localTsc : "tsc";
const result = spawnSync(command, ["-p", "tsconfig.extensions.json", "--noEmit"], { cwd: root, stdio: "inherit" });

if (result.error) {
  console.error(`check: failed to run tsc (${result.error.message})`);
  process.exit(1);
}
process.exit(result.status ?? 1);
