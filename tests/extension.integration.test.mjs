import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const projectRoot = path.resolve(import.meta.dirname, "..");
const extensionPath = path.join(projectRoot, ".pi", "extensions", "reliability-harness.ts");
const extensionsDir = path.join(projectRoot, ".pi", "extensions");

function makeContext(cwd) {
  return {
    cwd,
    mode: "json",
    hasUI: false,
    ui: {
      notify() {},
      setStatus() {}
    },
    sessionManager: {
      getSessionId: () => "integration-session",
      getBranch: () => []
    }
  };
}

test("loads as a real Pi extension and blocks high-risk calls without approval UI", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  fs.mkdirSync(path.join(tempRoot, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, ".pi", "reliability.json"),
    JSON.stringify({ mode: "enforce", traceDir: ".pi/runtime", limits: { maxToolCallsPerTurn: 1 } }),
    "utf8"
  );

  const loaded = await discoverAndLoadExtensions(
    [extensionPath],
    tempRoot,
    path.join(tempRoot, "agent-home")
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);

  const extension = loaded.extensions[0];
  assert.equal(extension.flags.has("equaxis-mode"), true);
  assert.equal(extension.commands.has("equaxis-eval"), true);
  assert.equal(extension.handlers.has("tool_call"), true);

  const ctx = makeContext(tempRoot);
  for (const handler of extension.handlers.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "startup" }, ctx);
  }

  const [toolCallHandler] = extension.handlers.get("tool_call") ?? [];
  assert.ok(toolCallHandler);
  const result = await toolCallHandler(
    {
      type: "tool_call",
      toolCallId: "danger-1",
      toolName: "bash",
      input: { command: "rm -rf ./temporary-output" }
    },
    ctx
  );

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /approval UI is unavailable/);

  const retryResult = await toolCallHandler(
    {
      type: "tool_call",
      toolCallId: "retry-2",
      toolName: "read",
      input: { path: "README.md" }
    },
    ctx
  );
  assert.equal(retryResult?.block, true);
  assert.match(retryResult?.reason ?? "", /tool-call limit exceeded/);
  assert.equal(fs.existsSync(path.join(tempRoot, ".pi", "runtime", "traces.jsonl")), true);
});

test("keeps raw-secret blocking and trace redaction active in audit mode", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-audit-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tempRoot, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, ".pi", "reliability.json"),
    JSON.stringify({ mode: "audit", traceDir: ".pi/runtime" }),
    "utf8"
  );

  const loaded = await discoverAndLoadExtensions(
    [extensionPath],
    tempRoot,
    path.join(tempRoot, "agent-home")
  );
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const ctx = makeContext(tempRoot);
  for (const handler of extension.handlers.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "startup" }, ctx);
  }

  const [toolCallHandler] = extension.handlers.get("tool_call") ?? [];
  const secret = "supersecret123456";
  const result = await toolCallHandler(
    {
      type: "tool_call",
      toolCallId: "secret-1",
      toolName: "bash",
      input: { command: `deploy --token=${secret}` }
    },
    ctx
  );

  assert.equal(result?.block, true);
  const trace = fs.readFileSync(path.join(tempRoot, ".pi", "runtime", "traces.jsonl"), "utf8");
  assert.equal(trace.includes(secret), false);
  assert.match(trace, /"redacted":true/);
});

test("blocks semantically invalid arguments before tool execution", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-validation-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tempRoot, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, ".pi", "reliability.json"),
    JSON.stringify({ mode: "enforce", traceDir: ".pi/runtime" }),
    "utf8"
  );

  const loaded = await discoverAndLoadExtensions(
    [extensionPath],
    tempRoot,
    path.join(tempRoot, "agent-home")
  );
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const ctx = makeContext(tempRoot);
  for (const handler of extension.handlers.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "startup" }, ctx);
  }

  const [toolCallHandler] = extension.handlers.get("tool_call") ?? [];
  const result = await toolCallHandler(
    { type: "tool_call", toolCallId: "invalid-1", toolName: "write", input: { path: "" } },
    ctx
  );
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /MISSING_ARGUMENT/);
  const trace = fs.readFileSync(path.join(tempRoot, ".pi", "runtime", "traces.jsonl"), "utf8");
  assert.match(trace, /tool_validation_failed/);
  assert.match(trace, /"retryable":true/);
});

test("exhausts repeated repairs for the same invalid field", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-repair-limit-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tempRoot, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, ".pi", "reliability.json"),
    JSON.stringify({ mode: "enforce", traceDir: ".pi/runtime", limits: { maxRepairAttemptsPerError: 2 } }),
    "utf8"
  );
  const loaded = await discoverAndLoadExtensions([extensionPath], tempRoot, path.join(tempRoot, "agent-home"));
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const ctx = makeContext(tempRoot);
  for (const handler of extension.handlers.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "startup" }, ctx);
  }
  const [toolCallHandler] = extension.handlers.get("tool_call") ?? [];
  const event = (id) => ({ type: "tool_call", toolCallId: id, toolName: "write", input: { path: "" } });
  const first = await toolCallHandler(event("repair-1"), ctx);
  const second = await toolCallHandler(event("repair-2"), ctx);
  const third = await toolCallHandler(event("repair-3"), ctx);
  assert.match(first?.reason ?? "", /"attempt":1/);
  assert.match(second?.reason ?? "", /"attempt":2/);
  assert.match(third?.reason ?? "", /REPAIR_EXHAUSTED/);
  assert.match(third?.reason ?? "", /"retryable":false/);
});

test("loads Equaxis reliability and memory extensions together", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-extensions-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const loaded = await discoverAndLoadExtensions(
    [extensionsDir],
    tempRoot,
    path.join(tempRoot, "agent-home")
  );
  assert.deepEqual(loaded.errors, []);
  assert.ok(loaded.extensions.length >= 3);

  const tools = new Set(loaded.extensions.flatMap((extension) => [...extension.tools.keys()]));
  const commands = new Set(loaded.extensions.flatMap((extension) => [...extension.commands.keys()]));
  assert.equal(tools.has("memory_search"), true);
  assert.equal(tools.has("memory_remember"), true);
  assert.equal(tools.has("memory_add_fact"), true);
  assert.equal(commands.has("memory-search"), true);
  assert.equal(tools.has("tool_search"), true);
  assert.equal(tools.has("tool_schedule"), true);
  assert.equal(commands.has("equaxis-policy"), true);

  const provider = loaded.runtime.pendingProviderRegistrations.find(
    (registration) => registration.name === "openai-inprior"
  );
  assert.ok(provider);
  assert.equal(provider.config.baseUrl, "https://api.inprior.com");
  assert.equal(provider.config.api, "openai-responses");
  assert.equal(provider.config.models?.[0]?.id, "gpt-5.5");
  assert.equal(provider.config.models?.[0]?.contextWindow, 1_000_000);
  assert.equal(provider.config.models?.[0]?.thinkingLevelMap?.xhigh, "xhigh");
});
