import path from "node:path";
import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createExtensionRuntimeServices } from "../../src/extension-runtime-services.mjs";
import { createPrefixTracker, hashPrompt, stablePrefixStats } from "../../src/prefix-stability.mjs";

function readState(filePath: string): { sample?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as { sample?: string };
  } catch {
    return null;
  }
}

function writeState(filePath: string, state: { sample: string; at: string }): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Atomic replace: concurrent writers (subagent processes share the file)
    // must never observe a half-written sample.
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(state), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Observability only.
  }
}

/**
 * Prompt prefix-stability observability (KVFlow, NeurIPS 2025).
 *
 * Provider-side prefix caches (DeepSeek context caching, OpenAI automatic
 * prefix caching) reuse KV tensors of byte-stable prompt prefixes across
 * requests — cache hits are ~10x cheaper and skip prefill. KVFlow's core
 * insight applied to the harness layer: fixed content (system prompt,
 * tool schemas, static skill blocks) must stay a STABLE PREFIX, dynamic
 * content (per-task blocks, session history) must come AFTER it.
 *
 * This extension does not rewrite prompts. It records, per agent start,
 * how much of the system prompt was a byte-stable prefix vs the previous
 * request, traces the stats, and exposes a /equaxis-prefix command so the
 * cache friendliness of Equaxis's prompt assembly is observable.
 */

interface PrefixStats {
  prevLength: number;
  currLength: number;
  commonPrefixLength: number;
  stableRatio: number;
  window: number;
  minStableRatio: number;
  avgStableRatio: number;
}

export default function equaxisPrefixStability(pi: ExtensionAPI): void {
  const services = createExtensionRuntimeServices({ cwd: process.cwd(), extensionId: "prefix-stability", pi });
  const tracker = createPrefixTracker({ windowSize: 10 });
  // Cross-session sample: persist the head of the last system prompt so the
  // first measurement of a new session can compare against the previous
  // session (provider caches persist across sessions too).
  const stateDir = path.join(services.paths.workspace, ".pi", "runtime");
  const stateFile = path.join(stateDir, "prefix-stability.json");
  const SAMPLE_CHARS = 20000;
  let lastSessionSample = readState(stateFile)?.sample ?? "";

  function trace(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}): void {
    services.trace.record(ctx, event, data);
  }

  function updateStatus(ctx: ExtensionContext, stats: PrefixStats): void {
    const pct = Math.round(stats.stableRatio * 100);
    services.status.set(ctx, "equaxis-prefix", `Prefix ${pct}% stable (${stats.commonPrefixLength}/${stats.currLength} chars)`);
  }

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const current = String(event.systemPrompt ?? "");
      const crossSession = lastSessionSample
        ? stablePrefixStats(lastSessionSample, current.slice(0, SAMPLE_CHARS))
        : null;
      const stats = tracker.snapshot(current);
      const merged = {
        ...stats,
        crossSessionRatio: crossSession ? crossSession.stableRatio : null,
        crossSessionCommon: crossSession ? crossSession.commonPrefixLength : null,
        promptSha: hashPrompt(current)
      };
      trace(ctx, "prefix_stability", merged);
      updateStatus(ctx, merged);
      lastSessionSample = current.slice(0, SAMPLE_CHARS);
      writeState(stateFile, { sample: lastSessionSample, at: new Date().toISOString() });
    } catch {
      // Observability only: never block agent start on measurement failure.
    }
  });

  pi.registerCommand("equaxis-prefix", {
    description: "Show system-prompt prefix stability (KVFlow-style cache-friendliness)",
    handler: async (_args, ctx) => {
      const history = tracker.history();
      if (!history.length) {
        ctx.ui.notify("No system-prompt measurements yet this session.");
        return;
      }
      const lines = history.map((entry, index) => {
        const pct = Math.round(entry.stableRatio * 100);
        return `${String(index + 1).padStart(2)}. ${entry.at.slice(11, 19)}  len=${String(entry.length).padStart(6)}  stable=${String(entry.commonPrefixLength).padStart(6)} (${String(pct).padStart(3)}%)`;
      });
      const last = history[history.length - 1];
      const avg = history.reduce((sum, entry) => sum + entry.stableRatio, 0) / history.length;
      const min = Math.min(...history.map((entry) => entry.stableRatio));
      const text = [
        `System prompt prefix stability (last ${history.length} requests):`,
        ...lines,
        "",
        `avg stable ratio: ${(avg * 100).toFixed(1)}%  min: ${(min * 100).toFixed(1)}%`,
        "",
        "KVFlow note: byte-stable prefixes hit provider prefix caches (cheaper + faster).",
        "If stability is low, dynamic blocks are being injected before fixed content.",
        "Fix: keep tool schemas / static instructions at the top, dynamic blocks after."
      ].join("\n");
      ctx.ui.notify(text);
    }
  });
}
