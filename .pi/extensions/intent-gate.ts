import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createExtensionRuntimeServices } from "../../src/extension-runtime-services.mjs";

/**
 * IntentGate — lightweight regex keyword → mode-instruction injection
 * (oh-my-opencode inspiration: IntentGate injects mode directives on
 * keyword hits; non-semantic, zero model cost).
 *
 * When the user's prompt matches a configured regex, the matching mode
 * instruction is appended to the system prompt for that agent run.
 * Purely declarative: patterns are regexes, injections are plain text.
 * A miss is harmless; a hit only adds context.
 */

interface IntentPattern {
  regex: string;
  inject: string;
  description?: string;
}

interface IntentGateConfig {
  enabled: boolean;
  patterns: IntentPattern[];
}

const DEFAULT_PATTERNS: IntentPattern[] = [
  {
    regex: "\\b(ultrawork|ulw)\\b",
    inject: "Mode: ULTRAWORK. Work autonomously through the full task before reporting; batch related steps; do not stop for confirmation on low-risk steps.",
    description: "Autonomous deep-work mode"
  },
  {
    regex: "\\b(quick|fast|brief)\\b",
    inject: "Mode: QUICK. Prefer the smallest correct change; skip elaborate planning and verbose reporting.",
    description: "Brevity mode"
  }
];

export default function equaxisIntentGate(pi: ExtensionAPI): void {
  const services = createExtensionRuntimeServices({ cwd: process.cwd(), extensionId: "intent-gate", pi });
  const config = services.config.intentGate as IntentGateConfig | undefined;
  const compiled = (config?.patterns ?? DEFAULT_PATTERNS)
    .filter((pattern) => config?.enabled !== false && pattern?.regex && pattern?.inject)
    // Bounded: regex length cap plus prompt-length cap keep pathological
    // user patterns (catastrophic backtracking) from stalling a turn.
    .filter((pattern) => pattern.regex.length <= 512 && pattern.inject.length <= 2000)
    .map((pattern) => {
      try {
        return { regex: new RegExp(pattern.regex, "i"), inject: pattern.inject };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { regex: RegExp; inject: string } => entry !== null);

  function trace(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}): void {
    services.trace.record(ctx, event, data);
  }

  pi.on("before_agent_start", async (event, ctx) => {
    if (!compiled.length) return;
    const prompt = String(event.prompt ?? "").slice(0, 20000); // bound regex work
    const hits = compiled.filter(({ regex }) => regex.test(prompt));
    if (!hits.length) return;
    const blocks = hits.map(({ inject }) => inject).join("\n");
    trace(ctx, "intent_gate_injected", { hits: hits.length, promptChars: prompt.length });
    return { systemPrompt: `${event.systemPrompt}\n\n${blocks}` };
  });
}
