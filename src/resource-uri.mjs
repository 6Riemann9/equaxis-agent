import path from "node:path";
import { pathToFileURL } from "node:url";

export const RESOURCE_URI_SCHEMES = Object.freeze([
  "file",
  "http",
  "https",
  "memory",
  "tool",
  "mcp",
  "agent",
  "skill",
  "pr",
  "issue",
  "trace",
  "eval"
]);

const SUPPORTED = new Set(RESOURCE_URI_SCHEMES);

function failure(input, reason) {
  return { ok: false, input: String(input ?? ""), reason };
}

function queryObject(searchParams) {
  const result = {};
  for (const [key, value] of [...searchParams.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    result[key] = value;
  }
  return result;
}

function encodeSegment(segment) {
  return encodeURIComponent(String(segment)).replace(/%2F/gi, "%252F");
}

function decodeSegments(pathname) {
  return pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
}

function kindForScheme(scheme) {
  if (scheme === "http" || scheme === "https") return "web";
  return scheme;
}

export function createResourceUri(input = {}) {
  const scheme = String(input.scheme ?? "").toLowerCase();
  if (!SUPPORTED.has(scheme)) throw new Error(`unsupported resource URI scheme: ${scheme || "<empty>"}`);
  const authority = input.authority === undefined || input.authority === null ? "" : String(input.authority);
  const segments = Array.isArray(input.segments) ? input.segments : [];
  const query = input.query && typeof input.query === "object" ? input.query : {};
  const fragment = input.fragment === undefined || input.fragment === null ? "" : String(input.fragment);
  const pathname = segments.length ? `/${segments.map(encodeSegment).join("/")}` : "";
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const queryText = params.toString();
  return `${scheme}://${authority}${pathname}${queryText ? `?${queryText}` : ""}${fragment ? `#${encodeURIComponent(fragment)}` : ""}`;
}

export function parseResourceUri(value) {
  const input = String(value ?? "").trim();
  if (!input) return failure(value, "empty URI");
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return failure(value, "invalid URI");
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (!SUPPORTED.has(scheme)) return failure(value, `unsupported scheme: ${scheme || "<empty>"}`);
  const segments = decodeSegments(parsed.pathname);
  const query = queryObject(parsed.searchParams);
  const fragment = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : "";
  const normalized = scheme === "file"
    ? parsed.href
    : createResourceUri({ scheme, authority: parsed.host, segments, query, fragment });
  return {
    ok: true,
    input,
    normalized,
    scheme,
    kind: kindForScheme(scheme),
    authority: parsed.host,
    segments,
    query,
    fragment
  };
}

export function normalizeResourceUri(value, options = {}) {
  const parsed = parseResourceUri(value);
  if (parsed.ok) return parsed;
  if (!options.workspace) return parsed;
  const raw = String(value ?? "").trim();
  if (!raw || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return parsed;
  const absolute = path.resolve(options.workspace, raw);
  return parseResourceUri(pathToFileURL(absolute).href);
}
