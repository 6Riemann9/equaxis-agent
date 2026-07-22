import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function inpriorOpenAIProvider(pi: ExtensionAPI): void {
  pi.registerProvider("openai-inprior", {
    baseUrl: "https://api.inprior.com",
    apiKey: "!node scripts/read-provider-key.mjs",
    api: "openai-responses",
    authHeader: true,
    models: [
      {
        id: "gpt-5.5",
        name: "GPT-5.5 via InPrior",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 100_000,
        thinkingLevelMap: {
          "xhigh": "xhigh"
        },
        compat: {
          supportsStore: false,
          supportsReasoningEffort: true
        },
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0
        }
      },
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol via InPrior",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 272_000,
        maxTokens: 128_000,
        thinkingLevelMap: {
          "xhigh": "xhigh",
          "max": "max"
        },
        compat: {
          supportsStore: false,
          supportsReasoningEffort: true
        },
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0
        }
      }
    ]
  });
}
