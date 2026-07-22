import test from "node:test";
import assert from "node:assert/strict";
import { CrossProtocolToolRegistry } from "../src/cross-protocol-registry.mjs";

const source = (id, protocol, names) => ({
  id, protocol, ttlMs: 1000,
  discover: async () => names.map((name) => ({ name, description: `${name} capability`, inputSchema: { type: "object", properties: { query: { type: "string" } } } })),
  invoke: async (name, args, context) => ({ name, args, context })
});

test("discovers namespaced tools across MCP, CLI and HTTP", async () => {
  const registry = new CrossProtocolToolRegistry();
  registry.registerSource(source("docs", "mcp", ["search"]));
  registry.registerSource(source("local", "cli", ["search"]));
  registry.registerSource(source("service", "http", ["create_ticket"]));
  await Promise.all([registry.refresh("docs"), registry.refresh("local"), registry.refresh("service")]);
  assert.deepEqual(registry.search("search", { limit: 10 }).map((tool) => tool.id), ["cli:local:search", "mcp:docs:search"]);
});

test("refresh atomically replaces a source generation", async () => {
  const registry = new CrossProtocolToolRegistry();
  let names = ["old_tool"];
  registry.registerSource({ ...source("dynamic", "mcp", []), discover: async () => names.map((name) => ({ name, description: `${name} capability` })) });
  await registry.refresh("dynamic");
  names = ["new_tool"];
  await registry.refresh("dynamic");
  assert.equal(registry.search("old").length, 0);
  assert.equal(registry.search("new")[0].id, "mcp:dynamic:new_tool");
});

test("evicts expired tools and invokes through the owning adapter", async () => {
  const registry = new CrossProtocolToolRegistry();
  registry.registerSource(source("api", "http", ["lookup"]));
  const [tool] = await registry.refresh("api");
  const result = await registry.invoke(tool.id, { query: "x" }, { agentId: "agent-1" });
  assert.equal(result.context.agentId, "agent-1");
  assert.equal(registry.evictExpired(tool.expiresAt).length, 1);
  await assert.rejects(() => registry.invoke(tool.id, {}), /unavailable or expired/);
});

test("publishes refresh events for automatic Agent tool injection", async () => {
  const registry = new CrossProtocolToolRegistry();
  const events = [];
  registry.subscribe((event) => events.push(event));
  registry.registerSource(source("nacos-service", "http", ["lookup"]));
  await registry.refresh("nacos-service");
  assert.equal(events[0].type, "refreshed");
  assert.equal(events[0].tools[0].id, "http:nacos-service:lookup");
  assert.equal(registry.snapshot("nacos-service").length, 1);
});
