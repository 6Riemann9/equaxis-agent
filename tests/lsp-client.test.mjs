import test from "node:test";
import assert from "node:assert/strict";
import { LspClient, createMemoryLspTransport } from "../src/lsp-client.mjs";

test("initializes an LSP server and sends initialized notification", async () => {
  const received = [];
  const transport = createMemoryLspTransport();
  transport.server.onMessage((message) => {
    received.push(message.method);
    if (message.method === "initialize") {
      transport.server.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { definitionProvider: true } } });
    }
  });
  const client = new LspClient(transport.client, { rootPath: "/repo" });
  const result = await client.initialize({ processId: 123 });
  assert.equal(result.capabilities.definitionProvider, true);
  assert.deepEqual(received, ["initialize", "initialized"]);
});

test("requests definitions and caches diagnostics", async () => {
  const transport = createMemoryLspTransport();
  transport.server.onMessage((message) => {
    if (message.method === "textDocument/definition") {
      transport.server.send({
        jsonrpc: "2.0",
        id: message.id,
        result: [{ uri: message.params.textDocument.uri, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } }]
      });
    }
  });
  const client = new LspClient(transport.client, { rootPath: "/repo" });
  const uri = client.openDocument("/repo/src/app.ts", "const value = 1;", "typescript");
  transport.server.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [{ severity: 1, message: "boom" }] } });
  const definition = await client.definition("/repo/src/app.ts", { line: 0, character: 6 });
  assert.equal(definition[0].uri, uri);
  assert.deepEqual(client.getDiagnostics(uri), [{ severity: 1, message: "boom" }]);
});

test("rejects failed LSP requests", async () => {
  const transport = createMemoryLspTransport();
  transport.server.onMessage((message) => {
    transport.server.send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "server failed" } });
  });
  const client = new LspClient(transport.client, { rootPath: "/repo" });
  await assert.rejects(() => client.definition("/repo/a.ts", { line: 0, character: 0 }), /server failed/);
});

test("times out an unresponsive LSP request", async () => {
  const transport = createMemoryLspTransport();
  transport.server.onMessage(() => {});
  const client = new LspClient(transport.client, { rootPath: "/repo", requestTimeoutMs: 10 });
  await assert.rejects(() => client.definition("/repo/a.ts", { line: 0, character: 0 }), /LSP request timed out.*definition/);
  assert.equal(client.pending.size, 0);
});
