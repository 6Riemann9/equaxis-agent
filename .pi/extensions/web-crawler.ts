import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { crawlWeb, formatCrawlResult } from "../../src/web-crawler.mjs";

const WEB_CRAWL_PARAMS = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS URL to fetch" }),
  maxPages: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 1, description: "Maximum pages to fetch" })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, default: 0, description: "Link-following depth" })),
  sameOrigin: Type.Optional(Type.Boolean({ default: true, description: "Only follow links on the start URL origin" })),
  includeLinks: Type.Optional(Type.Boolean({ default: false, description: "Include extracted links in the result" })),
  maxCharsPerPage: Type.Optional(Type.Integer({ minimum: 500, maximum: 20000, default: 6000, description: "Maximum extracted text characters per page" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 30000, default: 10000, description: "Per-page timeout in milliseconds" }))
});

export default function webCrawlerExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_crawl",
    label: "Web Crawl",
    description: "Fetch an HTTP/HTTPS webpage, extract readable text, and optionally follow same-origin links.",
    promptSnippet: "Fetch webpages and return title, readable text, and optional links",
    promptGuidelines: [
      "Use web_crawl when the user asks to inspect, summarize, or extract content from a public webpage URL.",
      "Do not use web_crawl for localhost, private-network, credential-bearing, non-HTTP, or unknown-sensitive URLs."
    ],
    parameters: WEB_CRAWL_PARAMS,
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url}` }], details: undefined });
      const result = await crawlWeb(params, { signal });
      return {
        content: [{ type: "text", text: formatCrawlResult(result, { includeLinks: params.includeLinks }) }],
        details: result
      };
    }
  });

  pi.registerCommand("web-fetch", {
    description: "Fetch one public webpage: /web-fetch <url>",
    handler: async (args, ctx) => {
      const url = args.trim();
      if (!url) {
        ctx.ui.notify("Usage: /web-fetch <url>", "warning");
        return;
      }
      try {
        const result = await crawlWeb({
          url,
          maxPages: 1,
          maxDepth: 0,
          includeLinks: true,
          maxCharsPerPage: 3000,
          timeoutMs: 10000
        });
        ctx.ui.notify(formatCrawlResult(result, { includeLinks: true }).slice(0, 12000), "info");
      } catch (error) {
        ctx.ui.notify(`Web fetch failed: ${String(error)}`, "error");
      }
    }
  });
}
