import fs from "node:fs";
import path from "node:path";

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
const CONTRACT_FILE = path.join(".pi", "extensions", "contracts.json");
const FAILURE_MODES = new Set(["fatal", "degrade"]);
const RUNTIME_SERVICES = new Set(["config", "diagnostics", "trace", "status"]);

function parseVersion(value) {
  const match = String(value ?? "").trim().match(VERSION_PATTERN);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersions(left, right) {
  const a = typeof left === "string" ? parseVersion(left) : left;
  const b = typeof right === "string" ? parseVersion(right) : right;
  if (!a || !b) throw new Error("Cannot compare invalid semantic versions");
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function nextCaretVersion(version) {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0 };
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: version.patch + 1 };
}

function nextMinorVersion(version) {
  return { major: version.major, minor: version.minor + 1, patch: 0 };
}

function rangePredicates(range) {
  const value = String(range ?? "").trim();
  if (!value || value === "*") return [];

  const predicates = [];
  for (const token of value.split(/\s+/)) {
    if (!token) continue;
    const prefix = token[0];
    if (prefix === "^" || prefix === "~") {
      const version = parseVersion(token.slice(1));
      if (!version) return undefined;
      predicates.push({ operator: ">=", version });
      predicates.push({ operator: "<", version: prefix === "^" ? nextCaretVersion(version) : nextMinorVersion(version) });
      continue;
    }

    const match = token.match(/^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/);
    if (!match) return undefined;
    predicates.push({ operator: match[1] ?? "=", version: parseVersion(match[2]) });
  }
  return predicates;
}

export function satisfiesVersion(version, range) {
  const parsedVersion = parseVersion(version);
  const predicates = rangePredicates(range);
  if (!parsedVersion || predicates === undefined) return false;
  return predicates.every(({ operator, version: target }) => {
    const comparison = compareVersions(parsedVersion, target);
    if (operator === ">=") return comparison >= 0;
    if (operator === ">") return comparison > 0;
    if (operator === "<=") return comparison <= 0;
    if (operator === "<") return comparison < 0;
    return comparison === 0;
  });
}

function issue(severity, message, extra = {}) {
  return { severity, message, ...extra };
}

function isSafeEntry(entry) {
  return typeof entry === "string"
    && entry.length > 0
    && !path.isAbsolute(entry)
    && !entry.split(/[\\/]+/).includes("..");
}

function normalizeManifest(manifest) {
  return manifest && typeof manifest === "object" ? manifest : {};
}

export function loadExtensionContractManifest(projectRoot, manifestPath = path.join(projectRoot, CONTRACT_FILE)) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read extension contract manifest ${manifestPath}: ${error.message}`);
  }
}

export function validateExtensionManifest(manifest, options = {}) {
  const normalized = normalizeManifest(manifest);
  const errors = [];
  const warnings = [];
  const contracts = Array.isArray(normalized.extensions) ? normalized.extensions : [];
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const seenIds = new Set();
  const seenEntries = new Set();
  const providedBy = new Map();

  if (normalized.schemaVersion !== 1) {
    errors.push(issue("error", `unsupported contract schema version: ${String(normalized.schemaVersion)}`));
  }
  if (normalized.manifestVersion !== undefined && normalized.manifestVersion !== 1) {
    errors.push(issue("error", `unsupported extension manifest version: ${String(normalized.manifestVersion)}`));
  }
  if (normalized.config !== undefined) {
    if (normalized.config.schemaVersion !== 1 || typeof normalized.config.path !== "string") {
      errors.push(issue("error", "extension manifest config must point to schema version 1"));
    }
  }
  if (normalized.runtimeServices !== undefined) {
    if (normalized.runtimeServices.version !== 1 || !Array.isArray(normalized.runtimeServices.provides)) {
      errors.push(issue("error", "extension manifest runtimeServices must declare version 1 and provides"));
    } else {
      for (const service of normalized.runtimeServices.provides) {
        if (!RUNTIME_SERVICES.has(service)) errors.push(issue("error", `unknown runtime service: ${service}`));
      }
    }
  }
  if (!satisfiesVersion("0.0.0", normalized.piRange ?? "*") && !rangePredicates(normalized.piRange ?? "*")) {
    errors.push(issue("error", `invalid global Pi version range: ${String(normalized.piRange)}`));
  }
  if (!contracts.length) errors.push(issue("error", "extension contract manifest has no extensions"));

  for (const contract of contracts) {
    const id = String(contract?.id ?? "");
    const entry = String(contract?.entry ?? "");
    if (!id || seenIds.has(id)) errors.push(issue("error", `extension id is missing or duplicated: ${id || "<empty>"}`));
    if (id) seenIds.add(id);
    if (!isSafeEntry(entry)) errors.push(issue("error", `unsafe or missing extension entry for ${id || "<unknown>"}`));
    if (entry && seenEntries.has(entry)) errors.push(issue("error", `extension entry is duplicated: ${entry}`));
    if (entry) seenEntries.add(entry);

    if (!Number.isInteger(contract?.contractVersion) || contract.contractVersion < 1) {
      errors.push(issue("error", `invalid contractVersion for ${id || entry}`));
    }
    if (!FAILURE_MODES.has(contract?.failureMode)) {
      errors.push(issue("error", `invalid failureMode for ${id || entry}`));
    }
    if (contract?.piRange !== undefined && rangePredicates(contract.piRange) === undefined) {
      errors.push(issue("error", `invalid Pi version range for ${id || entry}: ${String(contract.piRange)}`));
    }
    if (contract?.services !== undefined && (!Array.isArray(contract.services) || contract.services.some((service) => !RUNTIME_SERVICES.has(service)))) {
      errors.push(issue("error", `services must contain only known runtime services for ${id || entry}`));
    }
    if (!Array.isArray(contract?.requires) || !contract.requires.every((item) => typeof item === "string")) {
      errors.push(issue("error", `requires must be an array of strings for ${id || entry}`));
    }
    if (!Array.isArray(contract?.provides) || !contract.provides.every((item) => typeof item === "string")) {
      errors.push(issue("error", `provides must be an array of strings for ${id || entry}`));
    }

    for (const capability of contract?.provides ?? []) {
      if (capability.startsWith("event:")) continue;
      if (providedBy.has(capability)) {
        errors.push(issue("error", `capability ${capability} is provided by both ${providedBy.get(capability)} and ${id}`));
      } else {
        providedBy.set(capability, id);
      }
    }

    if (entry && isSafeEntry(entry) && !fs.existsSync(path.join(projectRoot, ".pi", "extensions", entry))) {
      const target = path.join(".pi", "extensions", entry);
      const severity = contract?.failureMode === "degrade" ? "warning" : "error";
      (severity === "error" ? errors : warnings).push(issue(severity, `extension entry is missing: ${target}`, { id }));
    }
  }

  const graph = Object.fromEntries(contracts.map((contract) => [contract.id, []]));
  for (const contract of contracts) {
    for (const capability of contract.requires ?? []) {
      const provider = providedBy.get(capability);
      if (!provider) {
        errors.push(issue("error", `${contract.id} requires unavailable capability: ${capability}`));
        continue;
      }
      if (provider !== contract.id) graph[contract.id].push(provider);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id, chain = []) {
    if (visiting.has(id)) {
      errors.push(issue("error", `extension dependency cycle: ${[...chain, id].join(" -> ")}`));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph[id] ?? []) visit(dependency, [...chain, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of Object.keys(graph)) visit(id);

  const piVersion = options.piVersion;
  if (piVersion !== undefined) {
    if (!parseVersion(piVersion)) {
      errors.push(issue("error", `invalid installed Pi version: ${String(piVersion)}`));
    } else if (!satisfiesVersion(piVersion, normalized.piRange ?? "*")) {
      errors.push(issue("error", `installed Pi ${piVersion} does not satisfy ${normalized.piRange}`));
    }
    for (const contract of contracts) {
      if (contract.piRange && !satisfiesVersion(piVersion, contract.piRange)) {
        const target = `${contract.id} requires ${contract.piRange}, installed ${piVersion}`;
        if (contract.failureMode === "degrade") warnings.push(issue("warning", target, { id: contract.id }));
        else errors.push(issue("error", target, { id: contract.id }));
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    graph,
    contracts,
    manifest: normalized,
    piVersion
  };
}

export function readInstalledPiVersion(projectRoot) {
  const packagePath = path.join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
  } catch {
    return undefined;
  }
}

export function checkExtensionContracts(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const manifestPath = options.manifestPath ?? path.join(projectRoot, CONTRACT_FILE);
  let manifest;
  try {
    manifest = loadExtensionContractManifest(projectRoot, manifestPath);
  } catch (error) {
    return {
      ok: false,
      errors: [issue("error", error.message)],
      warnings: [],
      graph: {},
      contracts: [],
      manifest: undefined,
      piVersion: options.piVersion ?? readInstalledPiVersion(projectRoot)
    };
  }
  const piVersion = options.piVersion ?? readInstalledPiVersion(projectRoot);
  const report = validateExtensionManifest(manifest, { projectRoot, piVersion });
  if (!piVersion) {
    report.ok = false;
    report.errors.push(issue("error", "installed Pi version could not be read; run npm install"));
  }
  return report;
}

export function extensionPaths(projectRoot, manifest, selection = {}) {
  const enabled = new Set(selection.enabled ?? []);
  const disabled = new Set(selection.disabled ?? []);
  return (manifest.extensions ?? [])
    .filter((contract) => !disabled.has(contract.id))
    .filter((contract) => enabled.size === 0 || enabled.has(contract.id) || contract.failureMode === "fatal")
    .map((contract) => path.join(
      path.resolve(projectRoot), ".pi", "extensions", contract.entry
    ));
}

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

export function collectExtensionCapabilities(extension, providerRegistrations = []) {
  const capabilities = new Set();
  for (const name of extension.tools?.keys() ?? []) capabilities.add(`tool:${name}`);
  for (const name of extension.commands?.keys() ?? []) capabilities.add(`command:${name}`);
  for (const name of extension.flags?.keys() ?? []) capabilities.add(`flag:${name}`);
  for (const name of extension.handlers?.keys() ?? []) capabilities.add(`event:${name}`);
  for (const registration of providerRegistrations) {
    if (registration?.extensionPath && registration?.name && samePath(registration.extensionPath, extension.path)) {
      capabilities.add(`provider:${registration.name}`);
    }
  }
  return [...capabilities].sort();
}

export function extensionCapabilitySnapshot(loaded, providerRegistrations = [
  ...(loaded?.runtime?.pendingProviderRegistrations ?? []),
  ...(loaded?.runtime?.pendingNativeProviderRegistrations ?? []).map((item) => ({
    name: item.provider?.id,
    extensionPath: item.extensionPath
  }))
]) {
  return Object.fromEntries((loaded?.extensions ?? []).map((extension) => [
    path.basename(extension.path),
    collectExtensionCapabilities(extension, providerRegistrations)
  ]));
}

export function diffExtensionCapabilities(before = {}, after = {}) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const added = [];
  const removed = [];
  for (const name of names) {
    const previous = new Set(before[name] ?? []);
    const current = new Set(after[name] ?? []);
    for (const capability of current) if (!previous.has(capability)) added.push(`${name}:${capability}`);
    for (const capability of previous) if (!current.has(capability)) removed.push(`${name}:${capability}`);
  }
  return { added: added.sort(), removed: removed.sort(), compatible: removed.length === 0 };
}

export function inspectLoadedExtensions(loaded, manifestReport) {
  const errors = [...(manifestReport.errors ?? [])];
  const warnings = [...(manifestReport.warnings ?? [])];
  const contracts = manifestReport.contracts ?? [];
  const registrations = [
    ...(loaded?.runtime?.pendingProviderRegistrations ?? []),
    ...(loaded?.runtime?.pendingNativeProviderRegistrations ?? []).map((item) => ({
      name: item.provider?.id,
      extensionPath: item.extensionPath
    }))
  ];
  const loadedByEntry = new Map((loaded?.extensions ?? []).map((extension) => [path.basename(extension.path), extension]));
  const contractEntries = new Set(contracts.map((contract) => contract.entry));
  const capabilities = new Set();

  for (const contract of contracts) {
    const extension = loadedByEntry.get(contract.entry);
    if (!extension) {
      const loadError = (loaded?.errors ?? []).find((item) => path.basename(item.path) === contract.entry);
      const message = loadError?.error ?? `extension was not loaded: ${contract.entry}`;
      const target = `${contract.id}: ${message}`;
      (contract.failureMode === "degrade" ? warnings : errors).push(issue(
        contract.failureMode === "degrade" ? "warning" : "error",
        target,
        { id: contract.id }
      ));
      continue;
    }

    const actual = collectExtensionCapabilities(extension, registrations);
    for (const capability of actual) capabilities.add(capability);
    for (const expected of contract.provides ?? []) {
      if (expected.startsWith("core:")) {
        capabilities.add(expected);
        continue;
      }
      if (!actual.includes(expected)) {
        const target = `${contract.id} does not provide declared capability: ${expected}`;
        (contract.failureMode === "degrade" ? warnings : errors).push(issue(
          contract.failureMode === "degrade" ? "warning" : "error",
          target,
          { id: contract.id }
        ));
      }
    }
  }

  for (const extension of loaded?.extensions ?? []) {
    if (!contractEntries.has(path.basename(extension.path))) {
      warnings.push(issue("warning", `loaded extension has no contract: ${path.basename(extension.path)}`));
    }
  }
  for (const loadError of loaded?.errors ?? []) {
    if (!contractEntries.has(path.basename(loadError.path))) {
      warnings.push(issue("warning", `uncontracted extension failed to load: ${loadError.path}`));
    }
  }

  for (const contract of contracts) {
    for (const required of contract.requires ?? []) {
      if (!capabilities.has(required)) {
        const target = `${contract.id} dependency is not registered at runtime: ${required}`;
        (contract.failureMode === "degrade" ? warnings : errors).push(issue(
          contract.failureMode === "degrade" ? "warning" : "error",
          target,
          { id: contract.id }
        ));
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    capabilities: [...capabilities].sort(),
    snapshot: extensionCapabilitySnapshot(loaded, registrations),
    loadedExtensions: (loaded?.extensions ?? []).map((extension) => path.basename(extension.path))
  };
}

export function formatExtensionContractReport(report) {
  const lines = [`Pi: ${report.piVersion ?? "not installed"}`];
  for (const item of report.errors ?? []) lines.push(`FAIL  ${item.message}`);
  for (const item of report.warnings ?? []) lines.push(`WARN  ${item.message}`);
  if (report.ok && !(report.warnings ?? []).length) lines.push("PASS  Extension contracts are compatible");
  return lines.join("\n");
}
