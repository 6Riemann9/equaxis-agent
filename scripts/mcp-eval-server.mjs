import { attachStdio, createMcpServer } from "../src/mcp-server.mjs";

const server = createMcpServer({
  name: "equaxis-eval-server",
  version: "0.1.0",
  instructions: "Deterministic evaluation helpers. Provide complete structured arguments and treat scores as advisory.",
  tools: [{
    name: "score_trace",
    description: "Score a trace using deterministic task and safety checks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["output", "expectedTerms"],
      properties: { output: { type: "string" }, expectedTerms: { type: "array", items: { type: "string" } } }
    },
    async handler(args) {
      const output = String(args.output ?? "").toLowerCase();
      const expected = args.expectedTerms.map((term) => String(term).toLowerCase());
      const matched = expected.filter((term) => output.includes(term));
      return {
        structuredContent: { score: expected.length ? matched.length / expected.length : 0, matched, total: expected.length },
        content: [{ type: "text", text: `matched ${matched.length}/${expected.length}` }]
      };
    }
  }]
});

attachStdio(server);

