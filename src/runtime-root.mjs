import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runtime root vs project root.
 *
 * The PROJECT root (nearest ancestor with .pi/equaxis.json) holds config and
 * state. The RUNTIME root carries the executable surface: .pi/extensions/,
 * scripts/, bridge/, vendor/. A repo checkout is both; a global install
 * serves data-only workspaces (e.g. the user's home) whose .pi/equaxis.json
 * must NOT shadow the package's runtime — otherwise extension loading and
 * doctor checks look for code in the workspace and break.
 */

export function hasRuntimeMarkers(root) {
  if (!root) return false;
  return fs.existsSync(path.join(root, ".pi", "extensions", "contracts.json"))
    || fs.existsSync(path.join(root, "scripts", "memory-json.mjs"));
}

/** The equaxis-agent package this module belongs to (src/.. or scripts/..). */
export function ownPackageRoot(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

/** Resolve the runtime root for a project root, given the package root. */
export function resolveRuntimeRoot(projectRoot, packageRoot) {
  if (hasRuntimeMarkers(projectRoot)) return path.resolve(projectRoot);
  return path.resolve(packageRoot);
}
