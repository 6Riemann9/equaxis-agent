import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { DapClient, createMemoryDapTransport } from "../src/dap-client.mjs";

const ROOT = "/workspace";

function connect(handler, options = {}) {
  const transport = createMemoryDapTransport();
  const client = new DapClient(transport.client, { rootPath: ROOT, requestTimeoutMs: 250, ...options });
  transport.server.onMessage((message) => handler(message, transport.server));
  return { client, transport };
}

/** Reply to every request with a success body the caller supplies. */
function autoRespond(bodyFor = () => ({})) {
  return (message, server) => {
    if (message.type !== "request") return;
    server.send({ seq: message.seq, type: "response", request_seq: message.seq, command: message.command, success: true, body: bodyFor(message) });
  };
}

// ---------------------------------------------------------------------------
// handshake / requests
// ---------------------------------------------------------------------------

test("initialize negotiates capabilities and accepts the initialized event", async () => {
  const seen = [];
  const { client, transport } = connect((message, server) => {
    seen.push(message);
    if (message.type === "request" && message.command === "initialize") {
      server.send({ seq: 1, type: "response", request_seq: message.seq, command: "initialize", success: true, body: { supportsConfigurationDoneRequest: true } });
    }
  });

  const capabilities = await client.initialize();
  assert.equal(capabilities.supportsConfigurationDoneRequest, true);
  assert.deepEqual(client.capabilities, { supportsConfigurationDoneRequest: true });

  const initialize = seen.find((message) => message.command === "initialize");
  assert.equal(initialize.arguments.adapterID, "equaxis-dap");

  transport.server.send({ seq: 2, type: "event", event: "initialized" });
  assert.equal(client.initialized, true);
  assert.equal(client.getSessionState().phase, "initialized");
});

test("launch and configurationDone round-trip their arguments", async () => {
  const seen = [];
  const { client } = connect((message, server) => {
    seen.push(message);
    autoRespond(() => ({ ok: true }))(message, server);
  });
  await client.configurationDone({ foo: 1 });
  await client.launch({ program: "/workspace/main.py" });
  const launch = seen.find((message) => message.command === "launch");
  assert.deepEqual(launch.arguments, { program: "/workspace/main.py" });
  assert.ok(seen.some((message) => message.command === "configurationDone"));
});

test("an unsuccessful response rejects with the adapter message", async () => {
  const { client } = connect((message, server) => {
    server.send({ seq: 1, type: "response", request_seq: message.seq, command: message.command, success: false, message: "no such thread" });
  });
  await assert.rejects(() => client.continue(7), /no such thread/);
});

test("an unanswered request rejects on timeout", async () => {
  const { client } = connect(() => {});
  await assert.rejects(() => client.threadsRequest(), /timed out after 250ms/);
});

// ---------------------------------------------------------------------------
// events and session state
// ---------------------------------------------------------------------------

test("thread lifecycle events update the tracked thread set", async () => {
  const { client, transport } = connect(autoRespond(() => ({})));
  transport.server.send({ seq: 1, type: "event", event: "thread", body: { reason: "started", threadId: 1, name: "main" } });
  transport.server.send({ seq: 2, type: "event", event: "thread", body: { reason: "started", threadId: 2, name: "worker" } });
  assert.equal(client.getThreads().length, 2);
  assert.equal(client.getThread(1).name, "main");

  transport.server.send({ seq: 3, type: "event", event: "thread", body: { reason: "exited", threadId: 2 } });
  assert.deepEqual(client.getThreads().map((thread) => thread.id), [1]);
  assert.equal(client.getThread(2), null);
});

test("stopped, continued, output, terminated and exited events drive session state", () => {
  const { client, transport } = connect(autoRespond(() => ({})));

  transport.server.send({ seq: 1, type: "event", event: "thread", body: { reason: "started", threadId: 1 } });
  assert.equal(client.getSessionState().phase, "running");

  transport.server.send({ seq: 2, type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1, allThreadsStopped: true } });
  assert.equal(client.getSessionState().phase, "stopped");
  assert.deepEqual(client.getStoppedEvent(), { reason: "breakpoint", threadId: 1, allThreadsStopped: true });

  transport.server.send({ seq: 3, type: "event", event: "continued", body: { threadId: 1 } });
  assert.equal(client.getStoppedEvent(), null);
  assert.equal(client.getSessionState().phase, "running");

  transport.server.send({ seq: 4, type: "event", event: "output", body: { category: "stdout", output: "hello\n" } });
  assert.deepEqual(client.getOutput(), [{ category: "stdout", output: "hello\n" }]);

  transport.server.send({ seq: 5, type: "event", event: "exited", body: { exitCode: 3 } });
  assert.equal(client.getSessionState().phase, "exited");
  assert.equal(client.getSessionState().exitedCode, 3);

  transport.server.send({ seq: 6, type: "event", event: "terminated" });
  assert.equal(client.getSessionState().phase, "terminated");
  assert.equal(client.terminated, true);
});

// ---------------------------------------------------------------------------
// caches fed by requests
// ---------------------------------------------------------------------------

test("threads, stack frames, scopes and variables are cached for later inspection", async () => {
  const { client } = connect(autoRespond((message) => {
    if (message.command === "threads") return { threads: [{ id: 1, name: "main" }] };
    if (message.command === "stackTrace") return { stackFrames: [{ id: 100, name: "main", line: 3, column: 1 }] };
    if (message.command === "scopes") return { scopes: [{ name: "Locals", variablesReference: 200 }] };
    if (message.command === "variables") return { variables: [{ name: "x", value: "1", variablesReference: 0 }] };
    return {};
  }));

  await client.threadsRequest();
  assert.equal(client.getThread(1).name, "main");

  await client.stackTrace(1);
  assert.equal(client.getStackFrames(1)[0].name, "main");

  await client.scopes(100);
  assert.equal(client.getScopes(100)[0].name, "Locals");

  await client.variables(200);
  assert.equal(client.getVariables(200)[0].value, "1");
});

test("evaluate records the last result for the caller", async () => {
  const { client } = connect(autoRespond(() => ({ result: "42", variablesReference: 0 })));
  const result = await client.evaluate("6 * 7");
  assert.equal(result.result, "42");
  assert.equal(client.lastEvaluation.result, "42");
});

test("setBreakpoints caches the adapter's resolution per source", async () => {
  const { client } = connect(autoRespond(() => ({ breakpoints: [{ verified: true, line: 5 }] })));
  await client.setBreakpoints("/workspace/main.py", [{ line: 5 }]);
  assert.deepEqual(client.getBreakpoints("/workspace/main.py"), [{ verified: true, line: 5 }]);
  assert.deepEqual(client.getBreakpoints(pathToFileURL("/workspace/main.py").href), [{ verified: true, line: 5 }]);
  assert.deepEqual(client.getBreakpoints("/workspace/other.py"), []);
});

test("setBreakpoints rejects an empty source", async () => {
  const { client } = connect(autoRespond(() => ({})));
  assert.throws(() => client.setBreakpoints("   "), /source path is required/);
});

test("events are retained in order for auditing", () => {
  const { client, transport } = connect(autoRespond(() => ({})));
  for (const event of ["initialized", "stopped", "continued"]) {
    transport.server.send({ seq: 1, type: "event", event });
  }
  assert.deepEqual(client.events.map((event) => event.event), ["initialized", "stopped", "continued"]);
  assert.equal(client.getSessionState().eventCount, 3);
});
