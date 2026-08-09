import fs from "node:fs";
import path from "node:path";
import { parseResourceUri } from "./resource-uri.mjs";

function asList(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function normalizeProviderResult(value) {
  if (typeof value === "string") return { text: value, metadata: {} };
  if (!value || typeof value !== "object") return { text: String(value ?? ""), metadata: {} };
  return {
    text: String(value.text ?? value.content ?? ""),
    data: value.data,
    metadata: value.metadata && typeof value.metadata === "object" ? value.metadata : {}
  };
}

function mapLookup(resources, normalized) {
  if (!resources) return null;
  if (resources instanceof Map) return resources.get(normalized) ?? null;
  if (typeof resources === "object") return resources[normalized] ?? null;
  return null;
}

const RUNTIME_ARTIFACTS = new Map([
  ["release/manifest", ".pi/runtime/release-manifest.json"],
  ["protocols/traces", ".pi/runtime/protocols/traces.jsonl"],
  ["eval/events", ".pi/runtime/eval-loop/events.jsonl"],
  ["eval/harbor-manifest", ".pi/runtime/eval-loop/harbor/harbor-manifest.json"],
  ["subagents/events", ".pi/runtime/subagents/events.jsonl"],
  ["memory/governance", ".pi/runtime/memory-governance/memories.jsonl"]
]);

function workspacePath(root, target, label) {
  const base = path.resolve(root);
  const absolute = path.resolve(base, target);
  const relative = path.relative(base, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay inside artifact root: ${target}`);
  return absolute;
}

export class ResourceProviderRegistry {
  constructor(options = {}) {
    this.providers = new Map();
    this.trace = options.trace ?? (() => {});
  }

  register(scheme, provider, permissions = {}) {
    const normalizedScheme = String(scheme ?? "").toLowerCase();
    if (!normalizedScheme) throw new Error("resource provider scheme is required");
    if (!provider || typeof provider.read !== "function") throw new Error(`resource provider ${normalizedScheme} must expose read(resource, context)`);
    this.providers.set(normalizedScheme, {
      provider,
      permissions: {
        authorities: asList(permissions.authorities),
        enabled: permissions.enabled !== false
      }
    });
  }

  #authorize(resource, entry) {
    if (!entry.permissions.enabled) throw new Error(`resource provider disabled: ${resource.scheme}`);
    const authorities = entry.permissions.authorities;
    if (authorities.length && !authorities.includes(resource.authority)) {
      throw new Error(`resource authority not allowed: ${resource.authority || "<empty>"}`);
    }
  }

  async read(uri, context = {}) {
    const resource = parseResourceUri(uri);
    if (!resource.ok) throw new Error(`invalid resource URI: ${resource.reason}`);
    const entry = this.providers.get(resource.scheme);
    if (!entry) throw new Error(`no provider registered for resource scheme: ${resource.scheme}`);
    this.#authorize(resource, entry);
    const startedAt = new Date().toISOString();
    const value = await entry.provider.read(resource, context);
    const normalized = normalizeProviderResult(value);
    const result = {
      uri: resource.normalized,
      scheme: resource.scheme,
      authority: resource.authority,
      text: normalized.text,
      data: normalized.data,
      metadata: normalized.metadata,
      evidence: [{ uri: resource.normalized, scheme: resource.scheme, authority: resource.authority, provider: resource.scheme }]
    };
    this.trace("resource_read", { uri: resource.normalized, scheme: resource.scheme, authority: resource.authority, startedAt, bytes: Buffer.byteLength(result.text, "utf8") });
    return result;
  }
}

export function createDefaultResourceProviderRegistry(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const artifactRoot = path.resolve(projectRoot, options.artifactRoot ?? ".pi/runtime/artifacts");
  const registry = new ResourceProviderRegistry({ trace: options.trace });

  registry.register("agent", {
    read: async (resource) => {
      const value = mapLookup(options.agentResources, resource.normalized);
      if (value === null) throw new Error(`agent resource not found: ${resource.normalized}`);
      return normalizeProviderResult(value);
    }
  }, { authorities: options.agentAuthorities ?? [] });

  registry.register("history", {
    read: async (resource) => {
      const value = mapLookup(options.historyResources, resource.normalized);
      if (value === null) throw new Error(`history resource not found: ${resource.normalized}`);
      return normalizeProviderResult(value);
    }
  }, { authorities: options.historyAuthorities ?? [] });

  registry.register("artifact", {
    read: async (resource) => {
      const key = [resource.authority, ...resource.segments].filter(Boolean).join("/");
      const mapped = RUNTIME_ARTIFACTS.get(key);
      const absolute = mapped
        ? workspacePath(projectRoot, mapped, "runtime artifact")
        : workspacePath(artifactRoot, key.split("/").join(path.sep), "artifact resource");
      const text = fs.readFileSync(absolute, "utf8");
      const stat = fs.statSync(absolute);
      return { text, metadata: { path: path.relative(projectRoot, absolute).replaceAll("\\", "/"), bytes: stat.size, modifiedAt: stat.mtime.toISOString() } };
    }
  }, { authorities: options.artifactAuthorities ?? [] });

  return registry;
}
