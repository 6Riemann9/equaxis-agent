import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const projectRoot = path.resolve(import.meta.dirname, "..");
const extensionPath = path.join(projectRoot, ".pi", "extensions", "reliability-harness.ts");
const dashboardExtensionPath = path.join(projectRoot, ".pi", "extensions", "dashboard-command.ts");
const extensionsDir = path.join(projectRoot, ".pi", "extensions");

function makeContext(cwd) {
  return {
    cwd,
    mode: "json",
    hasUI: false,
    model: { provider: "test-provider", id: "test-model" },
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

test("dashboard slash command renders runtime status without model mediation", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dashboard-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const loaded = await discoverAndLoadExtensions(
    [dashboardExtensionPath],
    tempRoot,
    path.join(tempRoot, "agent-home")
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.equal(extension.commands.has("dashboard"), true);

  const messages = [];
  const ctx = makeContext(tempRoot);
  ctx.ui.notify = (message, level) => messages.push({ message, level });
  await extension.commands.get("dashboard").handler("", ctx);
  assert.equal(messages[0].level, "info");
  assert.match(messages[0].message, /Equaxis runtime dashboard/);
  assert.match(messages[0].message, /Health:/);
});

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

test("blocks stale edit calls before tool execution", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-stale-edit-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tempRoot, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "file.txt"), "current\n", "utf8");
  fs.writeFileSync(
    path.join(tempRoot, ".pi", "reliability.json"),
    JSON.stringify({ mode: "enforce", traceDir: ".pi/runtime" }),
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
  const result = await toolCallHandler(
    { type: "tool_call", toolCallId: "stale-1", toolName: "edit", input: { path: "file.txt", oldText: "previous", newText: "next" } },
    ctx
  );
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /STALE_EDIT_OLD_TEXT_MISSING/);
  const trace = fs.readFileSync(path.join(tempRoot, ".pi", "runtime", "traces.jsonl"), "utf8");
  assert.match(trace, /tool_validation_failed/);
  assert.match(trace, /STALE_EDIT_OLD_TEXT_MISSING/);
});

test("records runtime eval telemetry for completed tool calls", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-eval-telemetry-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tempRoot, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, ".pi", "reliability.json"),
    JSON.stringify({ mode: "enforce", traceDir: ".pi/runtime" }),
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
  const [toolResultHandler] = extension.handlers.get("tool_result") ?? [];
  const allowed = await toolCallHandler(
    { type: "tool_call", toolCallId: "read-1", toolName: "read", input: { path: "README.md" } },
    ctx
  );
  assert.equal(allowed, undefined);
  await toolResultHandler(
    { type: "tool_result", toolCallId: "read-1", toolName: "read", isError: false },
    ctx
  );

  const trace = fs.readFileSync(path.join(tempRoot, ".pi", "runtime", "traces.jsonl"), "utf8");
  assert.match(trace, /eval_outcome_recorded/);
  assert.match(trace, /repo-inspect/);
  assert.match(trace, /test-model/);
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
  assert.equal(tools.has("recall"), true);
  assert.equal(tools.has("memory_remember"), true);
  assert.equal(tools.has("retain"), true);
  assert.equal(tools.has("memory_add_fact"), true);
  assert.equal(tools.has("learn"), true);
  assert.equal(tools.has("reflect"), true);
  assert.equal(tools.has("memory_edit"), true);
  assert.equal(commands.has("memory-search"), true);
  assert.equal(tools.has("tool_search"), true);
  assert.equal(tools.has("tool_schedule"), true);
  assert.equal(tools.has("advisor_consult"), true);
  assert.equal(tools.has("lsp_probe"), true);
  assert.equal(tools.has("dap_probe"), true);
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

test("memory extension exposes deterministic reflect tool", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-memory-reflect-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const loaded = await discoverAndLoadExtensions(
    [path.join(extensionsDir, "memory.ts")],
    tempRoot,
    path.join(tempRoot, "agent-home")
  );
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((item) => item.path.endsWith("memory.ts"));
  assert.ok(extension);
  const reflected = await extension.tools.get("reflect").definition.execute("reflect-1", {
    goal: "repair",
    status: "failed",
    steps: [{ id: "s1", toolName: "read", status: "failed", errorCode: "RESULT_INCOMPLETE" }]
  });
  assert.equal(reflected.details.lessonCount, 2);
  assert.equal(reflected.details.promotable, true);
});

test("protocol tools extension exposes working advisor lsp and dap probes", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-protocol-tools-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const loaded = await discoverAndLoadExtensions(
    [path.join(extensionsDir, "protocol-tools.ts")],
    tempRoot,
    path.join(tempRoot, "agent-home")
  );
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((item) => item.path.endsWith("protocol-tools.ts"));
  assert.ok(extension);

  const advisor = await extension.tools.get("advisor_consult").definition.execute("advisor-1", {
    kind: "plan",
    steps: 5,
    evidence: "touches protocol tooling"
  });
  assert.equal(advisor.details.request.enabled, false);

  const lsp = await extension.tools.get("lsp_probe").definition.execute("lsp-1", {
    documentPath: "probe.js",
    text: "// TODO\nconst value = 1;\n",
    position: { line: 0, character: 0 }
  });
  assert.equal(lsp.details.initialized, true);
  assert.equal(lsp.details.diagnostics.length, 1);

  const dap = await extension.tools.get("dap_probe").definition.execute("dap-1", {
    source: "probe.js",
    breakpoints: [{ line: 1 }],
    expression: "1 + 1"
  });
  assert.equal(dap.details.initialized, true);
  assert.equal(dap.details.breakpoints[0].verified, true);
  assert.equal(dap.details.evaluation.result, "2");

  const attached = await extension.tools.get("dap_probe").definition.execute("dap-attach", {
    request: "attach",
    host: "127.0.0.1",
    port: 5678,
    source: "probe.py",
    breakpoints: [{ line: 1 }]
  });
  assert.equal(attached.details.request, "attach");
  assert.equal(attached.details.session.phase, "stopped");

  await assert.rejects(
    () => extension.tools.get("dap_probe").definition.execute("dap-process-missing", { mode: "process" }),
    /DAP process program is required/
  );
  await assert.rejects(
    () => extension.tools.get("lsp_probe").definition.execute("lsp-process-override", {
      mode: "process",
      command: "typescript-language-server"
    }),
    /command override is disabled/
  );
});

test("AST extension previews and applies a hash-checked rename", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-ast-extension-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tempRoot, "sample.ts"), "const value = 1;\\nconsole.log(value);\\n", "utf8");
  const loaded = await discoverAndLoadExtensions([
    path.join(extensionsDir, "ast-tools.ts")
  ], tempRoot, path.join(tempRoot, "agent-home"));
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((item) => item.path.endsWith("ast-tools.ts"));
  assert.ok(extension);
  const ctx = makeContext(tempRoot);
  for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
  const preview = await extension.tools.get("ast_rename").definition.execute("ast-preview", { path: "sample.ts", line: 0, character: 7, newName: "renamed" });
  assert.equal(preview.details.applied, false);
  const applied = await extension.tools.get("ast_rename").definition.execute("ast-apply", { path: "sample.ts", line: 0, character: 7, newName: "renamed", apply: true, expectedHash: preview.details.expectedHash });
  assert.equal(applied.details.applied, true);
  assert.match(fs.readFileSync(path.join(tempRoot, "sample.ts"), "utf8"), /renamed/);
});
