import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.mjs";
import { checkExtensionContracts } from "./extension-compat.mjs";
import { loadEquaxisConfig } from "./equaxis-config.mjs";
import { loadMemoryConfig } from "./memory-config.mjs";
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

function hasCredential(projectRoot, cwd, env) {
  if (env.OPENAI_API_KEY?.trim()) return "OPENAI_API_KEY";
  const candidates = [cwd, projectRoot].map((root) => path.join(root, ".equaxis", "credentials", "openai.key"));
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).size > 0);
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

function checkMemoryStore(checks, projectRoot) {
  const memoryRoot = path.join(projectRoot, ".equaxis", "memory");
  if (!fs.existsSync(memoryRoot)) {
    checks.push(check("Memory store", true, "not initialized yet (.equaxis/memory absent)"));
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
  const embeddingsOk = fs.existsSync(path.join(memoryRoot, "long_term", "palace"));
  checks.push(check(
    "Memory store",
    historyOk && cursorOk,
    `${historyDetail} · ${cursorDetail}${embeddingsOk ? " · embeddings present" : " · embeddings not initialized (first write downloads all-MiniLM-L6-v2)"}`
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

function checkPiDependency(checks, projectRoot) {
  const piEntry = path.join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
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
  const checks = [];
  let unifiedConfig;
  let extensionContracts;

  checkNodeVersion(checks, options.nodeVersion ?? process.versions.node);
  checkRuntimeFiles(checks, projectRoot);
  checkMemoryStore(checks, projectRoot);

  try {
    unifiedConfig = loadEquaxisConfig(projectRoot);
    checks.push(check("Unified config", true, `schema=${unifiedConfig.schemaVersion}; profile=${unifiedConfig.runtime.profile}`));
    checkRuntimeProfile(checks, unifiedConfig);
    extensionContracts = checkExtensionContractsAtRoot(checks, projectRoot, unifiedConfig);
  } catch (error) {
    checks.push(check("Unified config", false, String(error.message ?? error)));
    checks.push(check("Extension contracts", false, "skipped because unified config failed"));
  }

  checkPiDependency(checks, projectRoot);
  const credentialSource = hasCredential(projectRoot, cwd, env);
  checks.push(check("Provider credential", Boolean(credentialSource), credentialSource ? `available via ${path.basename(credentialSource)}` : "OPENAI_API_KEY or local key is required"));
  checkWorkspaceAccess(checks, cwd);

  return {
    ok: checks.every((item) => item.status),
    projectRoot,
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
  const startup = runStartupPreflight({ projectRoot, cwd, env, nodeVersion: options.nodeVersion });
  const checks = [...startup.checks];

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
  if (startup.unifiedConfig) {
    const adapters = discoverProtocolAdapters(startup.unifiedConfig, { cwd: projectRoot, env, spawnSyncImpl: run });
    checks.push(check("Protocol adapters", true, summarizeProtocolAdapters(adapters)));
  }
  const runtimeGates = startup.unifiedConfig?.runtime?.gates;
  checks.push(check("Runtime gates", Boolean(runtimeGates?.enabled), runtimeGates?.enabled ? `passRate>=${runtimeGates.minBenchmarkPassRate}; cost<=${runtimeGates.maxUnitCostUsd}; latency<=${runtimeGates.maxLatencyMs}ms` : "disabled"));
  const isolation = describeRuntimeIsolation(startup.unifiedConfig);
  checks.push(check("Runtime isolation", isolation.enabled, isolation.detail));
  const budgets = startup.unifiedConfig?.subagents?.budgets;
  const timeoutDetail = budgets?.timeoutMs ? `${budgets.timeoutMs}ms` : "none";
  checks.push(check("Subagent budgets", true, `timeout=${timeoutDetail}; maxRetries=${budgets?.maxRetries ?? 0}`));
  const persistence = describeSubagentPersistence(startup.unifiedConfig);
  checks.push(check("Subagent persistence", persistence.enabled, persistence.detail));
  const evaluation = startup.unifiedConfig?.evaluation;
  checks.push(check("Evaluation loop", Boolean(evaluation?.enabled), evaluation?.enabled ? `rootDir=${evaluation.rootDir}; minSamples=${evaluation.minSamples}` : "disabled"));

  if (memoryConfig?.enabled) {
    const vendorRoot = path.join(projectRoot, "vendor", "agent-memory");
    const pythonPath = [vendorRoot, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    const probe = run(memoryConfig.pythonCommand, ["-c", "import memory; print('memory-ok')"], {
      cwd: projectRoot,
      env: { ...env, PYTHONPATH: pythonPath, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true
    });
    const detail = probe.status === 0
      ? String(probe.stdout ?? "").trim() || "memory-ok"
      : String(probe.error?.message ?? probe.stderr ?? "Python memory import failed").trim();
    checks.push(check("Python memory", probe.status === 0, detail));
  } else {
    checks.push(check("Python memory", true, "skipped because memory is disabled"));
  }

  return {
    ok: checks.every((item) => item.status),
    projectRoot,
    cwd,
    checks
  };
}

export function formatDoctorReport(report) {
  const lines = ["Equaxis doctor", `Runtime: ${report.projectRoot}`, `Workspace: ${report.cwd}`, ""];
  for (const item of report.checks) lines.push(`${item.status ? "PASS" : "FAIL"}  ${item.name}: ${item.detail}`);
  lines.push("", report.ok ? "READY" : "NOT READY");
  return lines.join("\n");
}
