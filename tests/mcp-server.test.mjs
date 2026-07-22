import test from "node:test";
import assert from "node:assert/strict";
import { createMcpServer } from "../src/mcp-server.mjs";

const server = () => createMcpServer({
  name: "test-server", version: "1.0.0",
  tools: [{
    name: "echo", description: "Echo input", inputSchema: { type: "object" },
    handler: async (args) => ({ structuredContent: { echo: args.value }, content: [{ type: "text", text: String(args.value) }] })
  }, {
    name: "fail", description: "Fail deliberately", inputSchema: { type: "object" },
    handler: async () => { throw new Error("boom"); }
  }]
});

test("implements MCP initialize and tools/list", async () => {
  const instance = server();
  const init = await instance.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  assert.equal(init.result.serverInfo.name, "test-server");
  const list = await instance.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["echo", "fail"]);
});

test("executes tools with structured content and isolates tool errors", async () => {
  const instance = server();
  await instance.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const result = await instance.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { value: "hi" } } });
  assert.equal(result.result.structuredContent.echo, "hi");
  const failed = await instance.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fail", arguments: {} } });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /boom/);
});

test("rejects calls before initialization and unknown tools", async () => {
  const instance = server();
  assert.equal((await instance.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).error.code, -32002);
  await instance.handle({ jsonrpc: "2.0", id: 2, method: "initialize" });
  assert.equal((await instance.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "missing" } })).error.code, -32602);
});

