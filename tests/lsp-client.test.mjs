import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { LspClient, createMemoryLspTransport } from "../src/lsp-client.mjs";

const ROOT = "/workspace";

/**
 * Wire an LspClient to a scripted in-memory server. The handler receives each
 * parsed client message plus the server endpoint so it can reply or emit
 * notifications.
 */
function connect(handler, options = {}) {
  const transport = createMemoryLspTransport();
  const client = new LspClient(transport.client, { rootPath: ROOT, requestTimeoutMs: 250, ...options });
  transport.server.onMessage((message) => handler(message, transport.server));
  return { client, transport };
}

const uriFor = (file) => pathToFileURL(file).href;

test("initialize negotiates capabilities and announces the client as initialized", async () => {
  const seen = [];
  const { client } = connect((message, server) => {
    seen.push(message);
    if (message.method === "initialize") {
      server.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { hoverProvider: true }, serverInfo: { name: "fake-ls", version: "9" } } });
    }
  });

  const result = await client.initialize();
  assert.equal(result.serverInfo.name, "fake-ls");
  assert.deepEqual(client.capabilities, { hoverProvider: true });

  const initialize = seen.find((message) => message.method === "initialize");
  assert.equal(initialize.params.rootUri, uriFor(ROOT));
  assert.equal(initialize.params.clientInfo.name, "equaxis-lsp");
  assert.ok(seen.some((message) => message.method === "initialized"), "the initialized notification is sent");
});

test("request/response correlation survives out-of-order replies", async () => {
  const { client } = connect((message, server) => {
    if (message.method === "textDocument/definition") {
      // Answer the second request before the first to prove id correlation.
      const response = { jsonrpc: "2.0", id: message.id, result: { for: message.params.position.character } };
      if (message.params.position.character === 0) setTimeout(() => server.send(response), 20);
      else server.send(response);
    }
  });

  const [first, second] = await Promise.all([
    client.definition("/workspace/a.ts", { line: 0, character: 0 }),
    client.definition("/workspace/a.ts", { line: 1, character: 5 })
  ]);
  assert.equal(first.for, 0);
  assert.equal(second.for, 5);
});

test("an LSP error response rejects the pending request", async () => {
  const { client } = connect((message, server) => {
    server.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  });
  await assert.rejects(() => client.request("textDocument/hover", {}), /method not found/);
});

test("a request that is never answered rejects on timeout", async () => {
  const { client } = connect(() => {});
  await assert.rejects(() => client.request("textDocument/hover", {}), /timed out after 250ms/);
});

test("published diagnostics are cached per document uri", () => {
  const { client, transport } = connect(() => {});
  const uri = uriFor("/workspace/a.ts");
  transport.server.send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "boom", severity: 1 }] }
  });
  assert.equal(client.getDiagnostics("/workspace/a.ts").length, 1);
  assert.equal(client.getDiagnostics(uri)[0].message, "boom");
  assert.deepEqual(client.getDiagnostics("/workspace/other.ts"), []);
});

test("diagnostics notifications are not mistaken for responses", () => {
  const { client } = connect(() => {});
  // A notification carrying an id-less payload must not resolve or reject anything.
  assert.doesNotThrow(() => client.handleMessage({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: {} }));
  assert.doesNotThrow(() => client.handleMessage({ jsonrpc: "2.0", id: 999, result: {} }));
});

test("openDocument announces the document with its language and version", () => {
  const seen = [];
  const { client } = connect((message) => seen.push(message));
  const uri = client.openDocument("/workspace/a.ts", "const x = 1;\n", "typescript", 3);
  const notification = seen.find((message) => message.method === "textDocument/didOpen");
  assert.equal(uri, uriFor("/workspace/a.ts"));
  assert.equal(notification.params.textDocument.uri, uri);
  assert.equal(notification.params.textDocument.languageId, "typescript");
  assert.equal(notification.params.textDocument.version, 3);
  assert.match(notification.params.textDocument.text, /const x = 1/);
});

test("definition sends the expected method and position", async () => {
  const seen = [];
  const { client } = connect((message, server) => {
    seen.push(message);
    if (message.method === "textDocument/definition") server.send({ jsonrpc: "2.0", id: message.id, result: [] });
  });
  await client.definition("/workspace/a.ts", { line: 4, character: 2 });
  const request = seen.find((message) => message.method === "textDocument/definition");
  assert.equal(request.params.textDocument.uri, uriFor("/workspace/a.ts"));
  assert.deepEqual(request.params.position, { line: 4, character: 2 });
});
