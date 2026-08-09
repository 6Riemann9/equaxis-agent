import fs from "node:fs";
import path from "node:path";

const DEFAULT_ENV_ALLOWLIST = Object.freeze([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "USERPROFILE",
  "WINDIR"
]);

const SECRET_ENV_PATTERN = /(?:API|AUTH|COOKIE|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i;

function normalizeAllowlist(names = []) {
  return new Set(names.filter((name) => typeof name === "string" && name.trim()).map((name) => name.toLowerCase()));
}

function assertInsideWorkspace(projectRoot, targetPath, field) {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, targetPath);
  const relative = path.relative(root, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
  throw new Error(`${field} must stay inside the workspace`);
}

export function createIsolatedEnv(env = process.env, options = {}) {
  const allowlist = normalizeAllowlist([...(options.allowlist ?? DEFAULT_ENV_ALLOWLIST), ...(options.extraAllowlist ?? [])]);
  const extraEnv = options.extraEnv ?? {};
  const isolated = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!allowlist.has(key.toLowerCase())) continue;
    if (SECRET_ENV_PATTERN.test(key)) continue;
    isolated[key] = value;
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (typeof key !== "string" || !key.trim() || key.includes("\0")) throw new Error("extraEnv keys must be non-empty strings");
    if (SECRET_ENV_PATTERN.test(key) && !options.allowSecretExtraEnv) throw new Error(`refusing to inject sensitive env var: ${key}`);
    isolated[key] = String(value);
  }
  return isolated;
}

export function prepareRuntimeIsolation(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const kind = options.kind ?? "runtime";
  const id = options.id ?? "run";
  const outputRoot = options.outputRoot ?? path.join(".pi", "runtime", "isolated");
  const cwd = assertInsideWorkspace(projectRoot, options.cwd ?? ".", "cwd");
  const outputDir = assertInsideWorkspace(projectRoot, path.join(outputRoot, kind, id), "outputRoot");
  if (options.ensureOutputDir !== false) fs.mkdirSync(outputDir, { recursive: true });
  const extraEnv = {
    EQUAXIS_ISOLATED_RUN: "1",
    EQUAXIS_ISOLATION_KIND: kind,
    EQUAXIS_ISOLATION_OUTPUT_DIR: outputDir,
    ...(options.extraEnv ?? {})
  };
  const env = options.scrubEnv === false
    ? { ...(options.env ?? process.env), ...extraEnv }
    : createIsolatedEnv(options.env ?? process.env, {
        extraAllowlist: options.extraEnvAllowlist,
        extraEnv,
        allowSecretExtraEnv: options.allowSecretExtraEnv
      });
  return { cwd, env, outputDir };
}

export function describeRuntimeIsolation(config = {}) {
  const isolation = config?.subagents?.isolation ?? {};
  const enabled = isolation.enabled !== false;
  const envMode = isolation.scrubEnv === false ? "inherited-env" : "scrubbed-env";
  const outputRoot = isolation.outputRoot ?? path.join(".pi", "runtime", "isolated");
  return {
    enabled,
    detail: enabled ? `${envMode}; outputRoot=${outputRoot}` : "disabled"
  };
}
