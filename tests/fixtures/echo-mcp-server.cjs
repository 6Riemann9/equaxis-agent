#!/usr/bin/env node
/**
 * Minimal stdio MCP echo server for testing skill-embedded MCP.
 * Implements initialize / tools/list / tools/call (one "echo" tool) over
 * newline-delimited JSON-RPC (streamable-stdio style, simplest form).
 */
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (raw) => {
  if (!raw.trim()) return;
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    return;
  }
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "equaxis-echo-test", version: "1.0.0" }
      }
    });
    return;
  }
  if (request.method === "notifications/initialized") return;
  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo back the given text.",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
          }
        ]
      }
    });
    return;
  }
  if (request.method === "tools/call") {
    const text = request.params?.arguments?.text ?? "no text";
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: `echo: ${text}` }] }
    });
    return;
  }
  if (request.id !== undefined) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `unknown method: ${request.method}` } });
  }
});
