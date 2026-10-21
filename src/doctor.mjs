import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ownPackageRoot, resolveRuntimeRoot } from "./runtime-root.mjs";
import { loadConfig } from "./config.mjs";
import { checkExtensionContracts } from "./extension-compat.mjs";
import { loadEquaxisConfig } from "./equaxis-config.mjs";
import { loadMemoryConfig } from "./memory-config.mjs";
import { describeProcessCleanup } from "./process-cleanup.mjs";
import { describeRuntimeIsolation } from "./runtime-isolation.mjs";
import { isRuntimeProfile, profileExtensionSelection } from "./runtime-profiles.mjs";
import { describeSubagentPersistence } from "./subagent-state-store.mjs";
import { discoverProtocolAdapters, summarizeProtocolAdapters } from "./protocol-adapters.mjs";

const REQUIRED_EXTENSIONS = [
  "provider.ts",
  "reliability-harness.ts",
  "memory.ts",
  "skills.ts",
  "subagent-engine.ts",
  "web-crawler.ts",
  "tool-catalog.ts",
  "tool-scheduler.ts",
  "protocol-tools.ts",
  "ast-tools.ts"
];

function check(name, status, detail) {
  return { name, status, detail };
}

function piAuthRoots(env) {
  const roots = [];
  if (env.PI_CODING_AGENT_DIR?.trim()) roots.push(env.PI_CODING_AGENT_DIR.trim());
  // Respect the injected env's home so diagnostics stay deterministic under test.
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  roots.push(path.join(home, ".pi", "agent"));
  // Dedupe by realpath: the agent dir may symlink auth/models files into the
  // home root, and scanning both would double-report the same provider.
  const seen = new Set();
  return roots.filter((root) => {
    let key = root;
    try { key = fs.realpathSync.native(root); } catch { /* keep literal */ }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Read pi's auth.json / models.json and report configured providers without
 * leaking secrets. Local-proxy providers (loopback baseUrl) count as
 * configured even with a placeholder key. */
function piConfiguredProviders(env) {
  const found = new Map();
  // The agent dir may symlink auth/models files into another root; track the
  // real file already scanned so one provider is never reported twice.
  const scannedFiles = new Set();
  const readJsonOnce = (file) => {
    try {
      const real = fs.realpathSync.native(file);
      if (scannedFiles.has(real)) return undefined;
      scannedFiles.add(real);
      return JSON.parse(fs.readFileSync(real, "utf8"));
    } catch { return undefined; }
  };
  for (const root of piAuthRoots(env)) {
    const auth = readJsonOnce(path.join(root, "auth.json"));
    for (const [provider, entry] of Object.entries(auth ?? {})) {
      if (entry && typeof entry === "object" && String(entry.key ?? entry.token ?? "").trim()) found.set(provider, "auth.json");
    }
    const models = readJsonOnce(path.join(root, "models.json"));
    for (const [provider, def] of Object.entries(models?.providers ?? {})) {
      const key = String(def?.apiKey ?? "").trim();
      const loopback = /^https?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[?::1\]?)(?::\d+)?\b/i.test(String(def?.baseUrl ?? ""));
      if (key || loopback) found.set(provider, found.has(provider) ? `${found.get(provider)}+models.json` : "models.json");
    }
  }
  return found;
}

function hasCredential(projectRoot, cwd, env) {
  if (env.OPENAI_API_KEY?.trim()) return "OPENAI_API_KEY";
  const candidates = [cwd, projectRoot].map((root) => path.join(root, ".equaxis", "credentials", "openai.key"));
  const keyFile = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).size > 0);
  if (keyFile) return keyFile;
  const providers = piConfiguredProviders(env);
  if (providers.size > 0) {
    const summary = [...providers.entries()].map(([id, source]) => `${id} (${source})`).join(", ");
    return `pi providers: ${summary}`;
  }
  return undefined;
}

function checkNodeVersion(checks, nodeVersion) {
  const [nodeMajor, nodeMinor] = String(nodeVersion).split(".").map(Number);
  const supportedNode = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 19);
  checks.push(check("Node.js", supportedNode, supportedNode ? `v${nodeVersion}` : `v${nodeVersion}; requires >=22.19.0`));
}

function checkRuntimeFiles(checks, projectRoot) {
  const missingExtensions = REQUIRED_EXTENSIONS.filter((name) => !fs.existsSync(path.join(projectRoot, ".pi", "extensions", name)));
  checks.push(check("Runtime files", missingExtensions.length === 0, missingExtensions.length ? `missing: ${missingExtensions.join(", ")}` : "all extensions present"));
}

function checkMemoryStore(checks, cwd, memoryConfig) {
  // The runtime resolves memory.rootDir against the session cwd (see the
  // memory extension), so the doctor must probe the same location.
  const rootDir = memoryConfig?.rootDir ?? ".equaxis/memory";
  const backend = memoryConfig?.backend ?? "native";
  const memoryRoot = path.resolve(cwd, rootDir);
  if (!fs.existsSync(memoryRoot)) {
    checks.push(check("Memory store", true, `not initialized yet (${memoryRoot} absent)`));
    return;
  }
  const historyPath = path.join(memoryRoot, "history", "history.jsonl");
  const cursorPath = path.join(memoryRoot, "history", ".cursor");
  let historyOk = false;
  let historyDetail = "history missing";
  if (fs.existsSync(historyPath)) {
    try {
      const lines = fs.readFileSync(historyPath, "utf8").split(/\r?\n/).filter(Boolean);
      if (lines.length > 0) JSON.parse(lines[lines.length - 1]);
      historyOk = true;
      historyDetail = `${lines.length} entries`;
    } catch {
      historyDetail = "history unreadable or corrupt";
    }
  }
  let cursorOk = !fs.existsSync(cursorPath) || historyOk === false;
  let cursorDetail = "cursor missing";
  if (fs.existsSync(cursorPath)) {
    try {
      const raw = fs.readFileSync(cursorPath, "utf8").trim();
      const parsed = Number(raw);
      cursorOk = Number.isInteger(parsed) && parsed >= 0;
      cursorDetail = cursorOk ? `cursor ${parsed}` : `corrupt cursor (${JSON.stringify(raw)})`;
    } catch {
      cursorOk = false;
      cursorDetail = "cursor unreadable";
    }
  }
  // "palace" is the legacy Python backend layout; the native backend stores
  // drawers.json (+ knowledge_graph.sqlite3 on first graph write).
  const storeReady = backend === "native"
    ? fs.existsSync(path.join(memoryRoot, "long_term", "drawers.json"))
    : fs.existsSync(path.join(memoryRoot, "long_term", "palace"));
  let storeDetail = storeReady ? " · store present" : " · store not initialized (first write creates it)";
  if (!storeReady && backend === "native") storeDetail += "; first embedding downloads all-MiniLM-L6-v2";
  checks.push(check(
    "Memory store",
    historyOk && cursorOk,
    `${historyDetail} · ${cursorDetail} · backend=${backend}${storeDetail}`
  ));
}

function checkExtensionContractsAtRoot(checks, projectRoot, unifiedConfig) {
  const extensionContracts = checkExtensionContracts({
    projectRoot,
    manifestPath: path.resolve(projectRoot, unifiedConfig.extensions.manifest)
  });
  const contractDetail = extensionContracts.ok
    ? `Pi ${extensionContracts.piVersion ?? "unknown"}; ${extensionContracts.contracts.length} contracts${extensionContracts.warnings.length ? `; ${extensionContracts.warnings.length} warnings` : ""}`
    : extensionContracts.errors.map((item) => item.message).join("; ");
  checks.push(check("Extension contracts", extensionContracts.ok, contractDetail));
  return extensionContracts;
}

function checkPiDependency(checks, projectRoot, piEntryOverride) {
  // For global npm installs the pi entry resolves through the package's own
  // dependency graph, not <projectRoot>/node_modules.
  const piEntry = piEntryOverride ?? path.join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  checks.push(check("Pi dependency", fs.existsSync(piEntry), fs.existsSync(piEntry) ? "installed" : "run npm install"));
}

function checkWorkspaceAccess(checks, cwd) {
  try {
    fs.accessSync(cwd, fs.constants.R_OK | fs.constants.W_OK);
    checks.push(check("Workspace access", true, cwd));
  } catch (error) {
    checks.push(check("Workspace access", false, String(error.message ?? error)));
  }
}

/**
 * Informational only: equaxis's tool-catalog.ts registers `tool_search`, which
 * makes Pi's replaceable built-in `tool-search` stand down with a startup
 * warning (see docs/UNIFIED_RUNTIME.md). Neither state is a failure; this check
 * records which one is active so the warning is not mistaken for a problem.
 */
function checkBuiltinToolSearchOverlap(checks, env, runtimeRoot) {
  if (!fs.existsSync(path.join(runtimeRoot, ".pi", "extensions", "tool-catalog.ts"))) return;
  const agentDir = piAuthRoots(env)[0];
  let disabled = false;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    disabled = Array.isArray(settings.extensions) && settings.extensions.includes("-builtin:tool-search");
  } catch {
    // No settings file: the built-in stays enabled, which is the default.
  }
  checks.push(check(
    "Builtin tool-search",
    true,
    disabled
      ? "builtin:tool-search disabled; equaxis tool_search is the only provider (no startup warning)"
      : "equaxis tool_search supersedes builtin:tool-search (expected Pi warning; no action needed)"
  ));
}

function checkRuntimeProfile(checks, unifiedConfig) {
  const profile = unifiedConfig?.runtime?.profile;
  if (!isRuntimeProfile(profile)) {
    checks.push(check("Runtime profile", false, `unknown profile: ${String(profile)}`));
    return;
  }
  const selection = profileExtensionSelection(profile, unifiedConfig?.extensions ?? {});
  const detail = selection === null
    ? `${profile} (no Equaxis extensions loaded)`
    : `${profile} (${selection.enabled.length ? selection.enabled.join(", ") : "all manifest extensions"})`;
  checks.push(check("Runtime profile", true, detail));
}

function checkProtocolTools(checks, extensionContracts, unifiedConfig) {
  if (!extensionContracts?.ok) {
    checks.push(check("Protocol tools", false, "skipped because extension contracts failed"));
    return;
  }
  const capabilities = new Set((extensionContracts.contracts ?? []).flatMap((contract) => contract.provides ?? []));
  const required = ["tool:advisor_consult", "tool:lsp_probe", "tool:dap_probe"];
  const missing = required.filter((capability) => !capabilities.has(capability));
  const adapterDetail = ["lsp", "dap"].map((kind) => {
    const adapter = unifiedConfig?.protocols?.[kind];
    const configured = adapter?.command ? "configured" : "unconfigured";
    const override = adapter?.allowCommandOverride ? "override-allowed" : "locked";
    return `${kind}=${configured},${override}`;
  }).join("; ");
  const detail = missing.length ? `missing: ${missing.join(", ")}` : `advisor/lsp/dap tools declared; ${adapterDetail}`;
  checks.push(check("Protocol tools", missing.length === 0, detail));
}

export function runStartupPreflight(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  // Data-only project roots (a workspace with just .pi/equaxis.json, e.g. the
  // user's home) borrow the runtime (extensions/scripts/vendor) from the
  // installed package; repo checkouts carry it themselves.
  const runtimeRoot = options.runtimeRoot
    ? path.resolve(options.runtimeRoot)
    : resolveRuntimeRoot(projectRoot, ownPackageRoot(import.meta.url));
  const checks = [];
  let unifiedConfig;
  let extensionContracts;

  checkNodeVersion(checks, options.nodeVersion ?? process.versions.node);
  checkRuntimeFiles(checks, runtimeRoot);

  try {
    unifiedConfig = loadEquaxisConfig(projectRoot);
    checks.push(check("Unified config", true, `schema=${unifiedConfig.schemaVersion}; profile=${unifiedConfig.runtime.profile}`));
    checkRuntimeProfile(checks, unifiedConfig);
    extensionContracts = checkExtensionContractsAtRoot(checks, runtimeRoot, unifiedConfig);
  } catch (error) {
    checks.push(check("Unified config", false, String(error.message ?? error)));
    checks.push(check("Extension contracts", false, "skipped because unified config failed"));
  }

  checkMemoryStore(checks, cwd, unifiedConfig?.memory);

  checkPiDependency(checks, runtimeRoot, options.piEntry);
  checkWorkspaceAccess(checks, cwd);

  return {
    ok: checks.every((item) => item.status),
    projectRoot,
    runtimeRoot,
    cwd,
    checks,
    unifiedConfig,
    extensionContracts
  };
}

export function runDoctor(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const run = options.spawnSyncImpl ?? spawnSync;
  const startup = runStartupPreflight({ projectRoot, cwd, env, nodeVersion: options.nodeVersion, piEntry: options.piEntry, runtimeRoot: options.runtimeRoot });
  const runtimeRoot = startup.runtimeRoot;
  const checks = [...startup.checks];
  // Diagnostic, not a startup gate: a fresh install may still need /login.
  const credentialSource = hasCredential(projectRoot, cwd, env);
  const credentialDetail = credentialSource
    ? (credentialSource.startsWith("pi providers:") ? `available via ${credentialSource}` : `available via ${path.basename(credentialSource)}`)
    : "none configured — run /login or the pi-web Models panel to pick a provider";
  checks.push(check("Provider credential", Boolean(credentialSource), credentialDetail));

  let memoryConfig;
  try {
    const config = loadConfig(projectRoot);
    checks.push(check("Reliability config", true, `${config.mode}; trace retention=${config.trace.maxFiles}`));
  } catch (error) {
    checks.push(check("Reliability config", false, String(error.message ?? error)));
  }
  try {
    memoryConfig = loadMemoryConfig(projectRoot);
    checks.push(check("Memory config", true, memoryConfig.enabled ? "enabled" : "disabled"));
    const governance = memoryConfig.governance;
    checks.push(check("Memory governance", Boolean(governance?.enabled), governance?.enabled ? `auditPath=${governance.auditPath}; cold=${governance.retentionDays.cold}d` : "disabled"));
  } catch (error) {
    checks.push(check("Memory config", false, String(error.message ?? error)));
  }
  checkProtocolTools(checks, startup.extensionContracts, startup.unifiedConfig);
  checkBuiltinToolSearchOverlap(checks, env, runtimeRoot);
  if (startup.unifiedConfig) {
    const adapters = discoverProtocolAdapters(startup.unifiedConfig, { cwd: projectRoot, env, spawnSyncImpl: run });
    checks.push(check("Protocol adapters", true, summarizeProtocolAdapters(adapters)));
  }
  const runtimeGates = startup.unifiedConfig?.runtime?.gates;
  checks.push(check("Runtime gates", Boolean(runtimeGates?.enabled), runtimeGates?.enabled ? `passRate>=${runtimeGates.minBenchmarkPassRate}; cost<=${runtimeGates.maxUnitCostUsd}; latency<=${runtimeGates.maxLatencyMs}ms` : "disabled"));
  const costBrake = startup.unifiedConfig?.reliability?.costBrake;
  checks.push(check("Cost brake", Boolean(costBrake?.enabled), costBrake?.enabled ? `maxSessionCostUsd=${costBrake.maxSessionCostUsd}; warnAt=${costBrake.warnAtFraction}` : "disabled"));
  const isolation = describeRuntimeIsolation(startup.unifiedConfig);
  checks.push(check("Runtime isolation", isolation.enabled, isolation.detail));
  const cleanup = describeProcessCleanup();
  checks.push(check("Process cleanup", true, `strategy=${cleanup.strategy}; registered=${cleanup.registered}`));
  const budgets = startup.unifiedConfig?.subagents?.budgets;
  const timeoutDetail = budgets?.timeoutMs ? `${budgets.timeoutMs}ms` : "none";
  checks.push(check("Subagent budgets", true, `timeout=${timeoutDetail}; maxRetries=${budgets?.maxRetries ?? 0}`));
  const persistence = describeSubagentPersistence(startup.unifiedConfig);
  checks.push(check("Subagent persistence", persistence.enabled, persistence.detail));
  const evaluation = startup.unifiedConfig?.evaluation;
  checks.push(check("Evaluation loop", Boolean(evaluation?.enabled), evaluation?.enabled ? `rootDir=${evaluation.rootDir}; minSamples=${evaluation.minSamples}` : "disabled"));

  if (memoryConfig?.enabled && memoryConfig.backend === "python") {
    const vendorRoot = path.join(runtimeRoot, "vendor", "agent-memory");
    const pythonPath = [vendorRoot, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    const probe = run(memoryConfig.pythonCommand, ["-c", "import memory; print('memory-ok')"], {
      cwd: runtimeRoot,
      env: { ...env, PYTHONPATH: pythonPath, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true
    });
    const detail = probe.status === 0
      ? String(probe.stdout ?? "").trim() || "memory-ok"
      : String(probe.error?.message ?? probe.stderr ?? "Python memory import failed").trim();
    checks.push(check("Python memory", probe.status === 0, detail));
  } else if (memoryConfig?.enabled) {
    checks.push(check("Python memory", true, `skipped (memory.backend=${memoryConfig.backend ?? "native"}; store health covered by Memory store)`));
  } else {
    checks.push(check("Python memory", true, "skipped because memory is disabled"));
  }

  return {
    ok: checks.every((item) => item.status),
    projectRoot,
    runtimeRoot,
    cwd,
    checks
  };
}

export function formatDoctorReport(report) {
  const runtimeRoot = report.runtimeRoot ?? report.projectRoot;
  const lines = ["Equaxis doctor", `Runtime: ${runtimeRoot}`];
  if (report.projectRoot && report.projectRoot !== runtimeRoot) lines.push(`Project: ${report.projectRoot} (data-only; runtime from package)`);
  lines.push(`Workspace: ${report.cwd}`, "");
  for (const item of report.checks) lines.push(`${item.status ? "PASS" : "FAIL"}  ${item.name}: ${item.detail}`);
  lines.push("", report.ok ? "READY" : "NOT READY");
  return lines.join("\n");
}
