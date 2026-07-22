import dns from "node:dns/promises";
import net from "node:net";
import { performance } from "node:perf_hooks";

const DEFAULT_USER_AGENT = "Equaxis-WebCrawler/0.1 (+https://pi.dev/)";
const DEFAULT_MAX_RESPONSE_BYTES = 1_500_000;

export const DEFAULT_WEB_CRAWL_OPTIONS = Object.freeze({
  maxPages: 1,
  maxDepth: 0,
  sameOrigin: true,
  includeLinks: false,
  maxCharsPerPage: 6000,
  timeoutMs: 10000
});

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function compactWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function decodeCodePoint(value, fallback) {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : fallback;
}

function decodeHtmlEntities(text) {
  return String(text ?? "")
    .replace(/&#(\d+);/g, (match, code) => decodeCodePoint(Number(code), match))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => decodeCodePoint(Number.parseInt(code, 16), match))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function normalizeCrawlOptions(input = {}) {
  if (!input.url) throw new Error("url is required");
  const url = new URL(String(input.url));
  return {
    url,
    maxPages: clampInteger(input.maxPages, 1, 20, DEFAULT_WEB_CRAWL_OPTIONS.maxPages),
    maxDepth: clampInteger(input.maxDepth, 0, 3, DEFAULT_WEB_CRAWL_OPTIONS.maxDepth),
    sameOrigin: input.sameOrigin ?? DEFAULT_WEB_CRAWL_OPTIONS.sameOrigin,
    includeLinks: input.includeLinks ?? DEFAULT_WEB_CRAWL_OPTIONS.includeLinks,
    maxCharsPerPage: clampInteger(input.maxCharsPerPage, 500, 20000, DEFAULT_WEB_CRAWL_OPTIONS.maxCharsPerPage),
    timeoutMs: clampInteger(input.timeoutMs, 1000, 30000, DEFAULT_WEB_CRAWL_OPTIONS.timeoutMs)
  };
}

function ipv4ToNumber(address) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((total, part) => (total << 8) + part, 0) >>> 0;
}

function isIpv4InCidr(address, base, bits) {
  const value = ipv4ToNumber(address);
  const baseValue = ipv4ToNumber(base);
  if (value === null || baseValue === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

export function isBlockedIpAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4]
    ].some(([base, bits]) => isIpv4InCidr(address, base, bits));
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isBlockedIpAddress(normalized.slice(7));
    return normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff");
  }

  return true;
}

function isBlockedHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home.arpa");
}

export async function assertUrlAllowed(url, options = {}) {
  const parsed = url instanceof URL ? url : new URL(String(url));
  const hostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http and https URLs are supported: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  if (isBlockedHostname(hostname)) {
    throw new Error(`Blocked local hostname: ${hostname}`);
  }

  const checkedHosts = options.checkedHosts ?? new Map();
  const cached = checkedHosts.get(hostname);
  if (cached) return parsed;

  const directIpVersion = net.isIP(hostname);
  const addresses = directIpVersion
    ? [{ address: hostname, family: directIpVersion }]
    : await (options.resolveHost ?? dns.lookup)(hostname, { all: true, verbatim: false });

  const blocked = addresses.find((entry) => isBlockedIpAddress(entry.address));
  if (blocked) {
    throw new Error(`Blocked private or reserved network address: ${hostname} -> ${blocked.address}`);
  }
  checkedHosts.set(hostname, true);
  return parsed;
}

function normalizeVisitUrl(rawUrl) {
  const parsed = rawUrl instanceof URL ? new URL(rawUrl.href) : new URL(String(rawUrl));
  parsed.hash = "";
  return parsed;
}

function extractLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const href = decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!href || /^(?:javascript|mailto|tel|data|blob):/i.test(href)) continue;
    try {
      const link = normalizeVisitUrl(new URL(href, baseUrl));
      if (link.protocol !== "http:" && link.protocol !== "https:") continue;
      if (link.username || link.password) continue;
      const value = link.href;
      if (seen.has(value)) continue;
      seen.add(value);
      links.push(value);
    } catch {
      // Ignore malformed links in scraped pages.
    }
  }
  return links;
}

export function extractHtmlContent(html, baseUrl) {
  const source = String(html ?? "");
  const titleMatch = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = compactWhitespace(decodeHtmlEntities(titleMatch?.[1] ?? ""));
  const links = extractLinks(source, baseUrl);
  const body = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(?:br|p|div|section|article|header|footer|main|li|tr|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = compactWhitespace(decodeHtmlEntities(body));
  return { title, text, links };
}

function getHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) ?? "";
  return headers[name.toLowerCase()] ?? headers[name] ?? "";
}

function mergeSignals(signal, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  const abort = () => controller.abort(signal?.reason ?? new Error("Request aborted"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
}

async function readResponseText(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
    chunks.push(chunk);
    total += chunk.byteLength;
    if (value.byteLength > remaining) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), truncated };
}

async function fetchPage(url, options, dependencies) {
  const { signal, cleanup } = mergeSignals(dependencies.signal, options.timeoutMs);
  try {
    let currentUrl = normalizeVisitUrl(url);
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      await assertUrlAllowed(currentUrl, {
        checkedHosts: dependencies.checkedHosts,
        resolveHost: dependencies.resolveHost
      });

      const response = await dependencies.fetchImpl(currentUrl.href, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          "accept": "text/html, text/plain;q=0.9, */*;q=0.5",
          "user-agent": DEFAULT_USER_AGENT
        }
      });

      const location = getHeader(response.headers, "location");
      if ([301, 302, 303, 307, 308].includes(Number(response.status)) && location) {
        await response.body?.cancel?.();
        currentUrl = normalizeVisitUrl(new URL(location, currentUrl));
        continue;
      }

      const contentType = getHeader(response.headers, "content-type");
      const { text, truncated } = await readResponseText(response, DEFAULT_MAX_RESPONSE_BYTES);
      return {
        finalUrl: currentUrl,
        status: response.status,
        ok: response.ok,
        contentType,
        source: text,
        responseTruncated: truncated
      };
    }
    throw new Error("Too many redirects while fetching page");
  } finally {
    cleanup();
  }
}

export async function crawlWeb(input, dependencies = {}) {
  const options = normalizeCrawlOptions(input);
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available in this Node.js runtime");

  const startedAt = performance.now();
  const checkedHosts = new Map();
  const queue = [{ url: normalizeVisitUrl(options.url), depth: 0 }];
  const visited = new Set();
  const pages = [];
  const skipped = [];

  while (queue.length && pages.length < options.maxPages) {
    const item = queue.shift();
    const url = normalizeVisitUrl(item.url);
    const visitKey = url.href;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    try {
      await assertUrlAllowed(url, {
        checkedHosts,
        resolveHost: dependencies.resolveHost
      });
    } catch (error) {
      skipped.push({ url: url.href, reason: String(error) });
      continue;
    }

    let fetched;
    try {
      fetched = await fetchPage(url, options, {
        fetchImpl,
        signal: dependencies.signal,
        checkedHosts,
        resolveHost: dependencies.resolveHost
      });
    } catch (error) {
      pages.push({
        url: url.href,
        depth: item.depth,
        ok: false,
        error: String(error),
        text: "",
        links: []
      });
      continue;
    }

    const isHtml = /\btext\/html\b/i.test(fetched.contentType) || /<html[\s>]/i.test(fetched.source);
    const extracted = isHtml
      ? extractHtmlContent(fetched.source, fetched.finalUrl.href)
      : { title: "", text: compactWhitespace(fetched.source), links: [] };
    const text = extracted.text.slice(0, options.maxCharsPerPage);
    const page = {
      url: fetched.finalUrl.href,
      requestedUrl: url.href,
      depth: item.depth,
      status: fetched.status,
      ok: fetched.ok,
      contentType: fetched.contentType,
      title: extracted.title,
      text,
      textTruncated: extracted.text.length > text.length || fetched.responseTruncated,
      links: options.includeLinks ? extracted.links : [],
      discoveredLinkCount: extracted.links.length
    };
    pages.push(page);

    if (item.depth >= options.maxDepth || pages.length >= options.maxPages) continue;
    for (const link of extracted.links) {
      if (queue.length + pages.length >= options.maxPages * 5) break;
      const next = normalizeVisitUrl(link);
      if (options.sameOrigin && next.origin !== options.url.origin) {
        skipped.push({ url: next.href, reason: "outside same origin" });
        continue;
      }
      if (!visited.has(next.href)) queue.push({ url: next, depth: item.depth + 1 });
    }
  }

  return {
    startUrl: options.url.href,
    elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
    pageCount: pages.length,
    skippedCount: skipped.length,
    pages,
    skipped: skipped.slice(0, 50)
  };
}

export function formatCrawlResult(result, options = {}) {
  const includeLinks = options.includeLinks ?? false;
  const lines = [
    `Start URL: ${result.startUrl}`,
    `Fetched pages: ${result.pageCount}`,
    `Skipped URLs: ${result.skippedCount}`,
    `Elapsed: ${result.elapsedMs}ms`
  ];

  for (const [index, page] of result.pages.entries()) {
    lines.push("", `# Page ${index + 1}`);
    lines.push(`URL: ${page.url}`);
    if (page.requestedUrl && page.requestedUrl !== page.url) lines.push(`Requested URL: ${page.requestedUrl}`);
    if (page.status) lines.push(`Status: ${page.status}`);
    if (page.contentType) lines.push(`Content-Type: ${page.contentType}`);
    if (page.title) lines.push(`Title: ${page.title}`);
    if (page.error) {
      lines.push(`Error: ${page.error}`);
      continue;
    }
    if (page.textTruncated) lines.push("Text: truncated");
    lines.push("Text:", page.text || "(no extractable text)");
    if (includeLinks && page.links?.length) {
      lines.push("Links:", ...page.links.slice(0, 50).map((link) => `- ${link}`));
    } else if (page.discoveredLinkCount) {
      lines.push(`Discovered links: ${page.discoveredLinkCount}`);
    }
  }

  if (result.skipped.length) {
    lines.push("", "Skipped:", ...result.skipped.slice(0, 20).map((item) => `- ${item.url}: ${item.reason}`));
  }

  return lines.join("\n");
}
