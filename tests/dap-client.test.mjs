import test from "node:test";
import assert from "node:assert/strict";
import { DapClient, createMemoryDapTransport } from "../src/dap-client.mjs";

function respond(transport, request, body = {}) {
  transport.server.send({
    seq: 1000 + request.seq,
    type: "response",
    request_seq: request.seq,
    command: request.command,
    success: true,
    body
  });
}

test("initializes a debug adapter and tracks initialized events", async () => {
  const received = [];
  const transport = createMemoryDapTransport();
  transport.server.onMessage((message) => {
    received.push(message.command);
    assert.equal(message.type, "request");
    if (message.command === "initialize") {
      assert.equal(message.arguments.clientID, "equaxis-dap");
      respond(transport, message, { supportsConfigurationDoneRequest: true });
      transport.server.send({ seq: 2000, type: "event", event: "initialized", body: {} });
    }
  });

  const client = new DapClient(transport.client, { rootPath: "/repo" });
  const capabilities = await client.initialize();
  assert.deepEqual(received, ["initialize"]);
  assert.equal(capabilities.supportsConfigurationDoneRequest, true);
  assert.equal(client.initialized, true);
});

test("sets breakpoints and caches returned adapter breakpoints", async () => {
  const transport = createMemoryDapTransport();
  transport.server.onMessage((message) => {
    assert.equal(message.command, "setBreakpoints");
    assert.deepEqual(message.arguments.source, { path: "/repo/app.js" });
    assert.deepEqual(message.arguments.breakpoints, [{ line: 3 }]);
    respond(transport, message, { breakpoints: [{ verified: true, line: 3, id: 1 }] });
  });

  const client = new DapClient(transport.client);
  const result = await client.setBreakpoints("/repo/app.js", [{ line: 3 }]);
  assert.deepEqual(result.breakpoints, [{ verified: true, line: 3, id: 1 }]);
  assert.deepEqual(client.getBreakpoints("/repo/app.js"), [{ verified: true, line: 3, id: 1 }]);
});

test("requests threads, stack frames, scopes, variables and evaluation", async () => {
  const transport = createMemoryDapTransport();
  transport.server.onMessage((message) => {
    if (message.command === "threads") respond(transport, message, { threads: [{ id: 7, name: "main" }] });
    else if (message.command === "stackTrace") respond(transport, message, { stackFrames: [{ id: 9, name: "fn", line: 1, column: 1 }], totalFrames: 1 });
    else if (message.command === "scopes") respond(transport, message, { scopes: [{ name: "locals", variablesReference: 11 }] });
    else if (message.command === "variables") respond(transport, message, { variables: [{ name: "x", value: "1", variablesReference: 0 }] });
    else if (message.command === "evaluate") respond(transport, message, { result: "2", variablesReference: 0 });
  });

  const client = new DapClient(transport.client);
  await client.threadsRequest();
  await client.stackTrace(7);
  await client.scopes(9);
  await client.variables(11);
  const evaluation = await client.evaluate("1 + 1", { frameId: 9 });

  assert.deepEqual(client.getThreads(), [{ id: 7, name: "main" }]);
  assert.deepEqual(client.getStackFrames(7), [{ id: 9, name: "fn", line: 1, column: 1 }]);
  assert.deepEqual(client.getScopes(9), [{ name: "locals", variablesReference: 11 }]);
  assert.deepEqual(client.getVariables(11), [{ name: "x", value: "1", variablesReference: 0 }]);
  assert.deepEqual(evaluation, { result: "2", variablesReference: 0 });
  assert.deepEqual(client.lastEvaluation, { result: "2", variablesReference: 0 });
});

test("tracks stopped output thread termination and exit events", () => {
  const transport = createMemoryDapTransport();
  const client = new DapClient(transport.client);
  transport.server.send({ seq: 1, type: "event", event: "thread", body: { reason: "started", threadId: 5 } });
  transport.server.send({ seq: 2, type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 5, allThreadsStopped: true } });
  transport.server.send({ seq: 3, type: "event", event: "output", body: { category: "stdout", output: "hello\n" } });
  transport.server.send({ seq: 4, type: "event", event: "continued", body: { threadId: 5 } });
  transport.server.send({ seq: 5, type: "event", event: "thread", body: { reason: "exited", threadId: 5 } });
  transport.server.send({ seq: 6, type: "event", event: "exited", body: { exitCode: 2 } });
  transport.server.send({ seq: 7, type: "event", event: "terminated", body: {} });

  assert.deepEqual(client.getThreads(), []);
  assert.deepEqual(client.getOutput(), [{ category: "stdout", output: "hello\n" }]);
  assert.equal(client.getStoppedEvent(), null);
  assert.equal(client.exitedCode, 2);
  assert.equal(client.terminated, true);
});

test("rejects failed DAP responses", async () => {
  const transport = createMemoryDapTransport();
  transport.server.onMessage((message) => {
    transport.server.send({
      seq: 99,
      type: "response",
      request_seq: message.seq,
      command: message.command,
      success: false,
      message: "adapter failed"
    });
  });
  const client = new DapClient(transport.client);
  await assert.rejects(() => client.launch({ program: "app.js" }), /adapter failed/);
});

test("times out an unresponsive DAP request", async () => {
  const transport = createMemoryDapTransport();
  transport.server.onMessage(() => {});
  const client = new DapClient(transport.client, { requestTimeoutMs: 10 });
  await assert.rejects(() => client.threadsRequest(), /DAP request timed out.*threads/);
  assert.equal(client.pending.size, 0);
});

test("reports a structured session state", () => {
  const transport = createMemoryDapTransport();
  const client = new DapClient(transport.client);
  assert.equal(client.getSessionState().phase, "created");
  transport.server.send({ seq: 1, type: "event", event: "initialized", body: {} });
  assert.equal(client.getSessionState().phase, "initialized");
  transport.server.send({ seq: 2, type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1 } });
  assert.equal(client.getSessionState().phase, "stopped");
  transport.server.send({ seq: 3, type: "event", event: "terminated", body: {} });
  assert.equal(client.getSessionState().phase, "terminated");
});
