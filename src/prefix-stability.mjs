/**
 * Prompt prefix-stability observability (KVFlow, arXiv 2608.13560 → actually
 * NeurIPS 2025 KVFlow: prefix caching reuses KV tensors of fixed prompt
 * prefixes across requests; provider-side caches (DeepSeek/OpenAI) price
 * cache hits ~10x cheaper and skip prefill. Stable prefixes = cache hits.
 *
 * This module measures, per request, how much of the system prompt is a
 * byte-stable prefix versus a varying suffix. It is observability only —
 * it never rewrites prompts. Data drives decisions (e.g. moving dynamic
 * blocks after fixed blocks), and SimGates-style caution applies: thresholds
 * here are for reporting, not gating.
 */

import { createHash } from "node:crypto";

/** Character-level longest common prefix length between two strings. */
export function longestCommonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

/**
 * Content fingerprint (sha256, 16 hex chars) of a system prompt.
 * Lets offline tooling compare prompts across sessions without storing
 * full text — identical fingerprints mean a byte-stable prefix (provider
 * cache hit territory).
 */
export function hashPrompt(prompt) {
  return createHash("sha256").update(String(prompt ?? "")).digest("hex").slice(0, 16);
}

/**
 * Compare the current system prompt against the previous one.
 * Returns { prevLength, currLength, commonPrefixLength, stableRatio }
 * where stableRatio = commonPrefixLength / currLength (0..1).
 */
export function stablePrefixStats(prev, curr) {
  const prevLength = prev?.length ?? 0;
  const currLength = curr?.length ?? 0;
  const commonPrefixLength = currLength ? longestCommonPrefixLength(prev ?? "", curr) : 0;
  return {
    prevLength,
    currLength,
    commonPrefixLength,
    stableRatio: currLength ? Math.round((commonPrefixLength / currLength) * 10000) / 10000 : 0
  };
}

/**
 * Ring-buffer tracker over recent system prompts.
 * snapshot(prompt) records the prompt and returns stats vs the previous one
 * plus window-level aggregates: minStableRatio (worst request in window),
 * avgStableRatio, and the window size used.
 */
export function createPrefixTracker({ windowSize = 10 } = {}) {
  const size = Math.max(1, Math.floor(windowSize));
  const ring = [];
  let lastPrompt = "";

  function snapshot(prompt) {
    const current = String(prompt ?? "");
    const stats = stablePrefixStats(lastPrompt, current);
    lastPrompt = current;
    ring.push({ at: new Date().toISOString(), length: current.length, commonPrefixLength: stats.commonPrefixLength, stableRatio: stats.stableRatio });
    if (ring.length > size) ring.shift();
    const ratios = ring.map((entry) => entry.stableRatio);
    return {
      ...stats,
      window: ring.length,
      minStableRatio: ratios.length ? Math.min(...ratios) : 0,
      avgStableRatio: ratios.length ? ratios.reduce((sum, value) => sum + value, 0) / ratios.length : 0
    };
  }

  function history() {
    return [...ring];
  }

  return { snapshot, history, size };
}
