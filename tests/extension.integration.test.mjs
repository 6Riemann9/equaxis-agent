import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

/**
 * Integration: load the REAL Equaxis extension files through Pi's own loader and
 * drive the reliability harness' `tool_call` handler, asserting end-to-end tool
 * governance (validation, policy blocking, approval, trace/checkpoint side
 * effects). Nothing here re-implements policy — it exercises the shipped wiring.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-extension-it-"));
const traceFile = path.join(workspace, ".pi", "runtime", "traces.jsonl");

// The extension factories capture process.cwd() when they load, and the runtime
// services resolve config + trace paths from it, so the load must happen inside
// the throwaway workspace.
process.chdir(workspace);

const loaded = await discoverAndLoadExtensions(
  [path.join(repoRoot, ".pi", "extensions")],
  workspace,
  path.join(repoRoot, ".pi", "agent")
);

function extensionNamed(name) {
  const found = loaded.extensions.find((extension) => path.basename(extension.path) === name);
  assert.ok(found, `extension not loaded: ${name}`);
  return found;
}

function toolCallHandlers() {
  const handlers = extensionNamed("reliability-harness.ts").handlers.get("tool_call") ?? [];
  assert.equal(handlers.length, 1, "the reliability harness registers exactly one tool_call handler");
  return handlers[0];
}

function makeCtx({ selectChoice = "Approve this call", confirmValue = true } = {}) {
  const notifications = [];
  return {
    cwd: workspace,
    hasUI: true,
    sessionManager: { getSessionId: () => "extension-it-session" },
    notifications,
    ui: {
      notify: (message) => notifications.push(message),
      setStatus: () => {},
      select: async () => selectChoice,
      confirm: async () => confirmValue
    }
  };
}

function traceEvents() {
  if (!fs.existsSync(traceFile)) return [];
  return fs
    .readFileSync(traceFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).event);
}

// ---------------------------------------------------------------------------
// real extension loading
// ---------------------------------------------------------------------------

test("every Equaxis extension loads through Pi's loader without errors", () => {
  assert.deepEqual(loaded.errors, [], `extension load errors: ${JSON.stringify(loaded.errors)}`);
  // The expected set comes from the manifest, so a new extension cannot
  // silently skip loading (and this test cannot lie about the count).
  // Vendored entries (vendor/...) are profile-gated and not loaded here.
  const manifest = JSON.parse(fs.readFileSync(new URL("../.pi/extensions/contracts.json", import.meta.url), "utf8"));
  const expected = manifest.extensions.filter((entry) => !entry.entry.startsWith("vendor/"));
  assert.equal(loaded.extensions.length, expected.length, `expected all ${expected.length} contracted extensions to load`);
  const loadedEntries = new Set(loaded.extensions.map((ext) => path.basename(ext.path)));
  for (const entry of expected) {
    assert.ok(loadedEntries.has(entry.entry), `contracted extension ${entry.entry} did not load`);
  }
});

test("extensions register the tools, flags and commands the harness depends on", () => {
  assert.ok(extensionNamed("tool-catalog.ts").tools.has("tool_search"));
  assert.ok(extensionNamed("tool-scheduler.ts").tools.has("tool_schedule"));
  assert.ok(extensionNamed("subagent-engine.ts").tools.has("subagent_spawn"));
  assert.ok(extensionNamed("ast-tools.ts").tools.has("ast_inspect"));
  assert.ok(extensionNamed("ast-tools.ts").tools.has("ast_rename"));
  assert.ok(extensionNamed("protocol-tools.ts").tools.has("lsp_probe"));
  assert.ok(extensionNamed("protocol-tools.ts").tools.has("dap_probe"));
  assert.ok(extensionNamed("memory.ts").tools.has("memory_search"));
  assert.ok(extensionNamed("web-crawler.ts").tools.has("web_crawl"));
  assert.ok(extensionNamed("companion.ts").tools.has("companion_submit_task"));

  const harness = extensionNamed("reliability-harness.ts");
  assert.ok(harness.flags.has("equaxis-mode"), "the governance mode flag must be registered");
  assert.ok(harness.commands.size >= 5, "the harness exposes its operator commands");
  assert.ok((harness.handlers.get("tool_result") ?? []).length >= 1, "tool results are audited too");
});

// ---------------------------------------------------------------------------
// tool governance
// ---------------------------------------------------------------------------

test("harness blocks writes to protected paths and records the decision", async () => {
  const result = await toolCallHandlers()(
    { toolCallId: "it-protected", toolName: "write", input: { path: ".env" } },
    makeCtx()
  );
  assert.equal(result?.block, true);
  assert.match(result.reason, /Reliability Harness/);
  assert.match(result.reason, /protected path/);
  assert.ok(traceEvents().includes("tool_blocked"));
});

test("harness blocks malformed tool input before it reaches policy", async () => {
  const result = await toolCallHandlers()(
    { toolCallId: "it-invalid", toolName: "write", input: {} },
    makeCtx()
  );
  assert.equal(result?.block, true);
  assert.match(result.reason, /INVALID_ARGUMENT/);
  assert.match(result.reason, /MISSING_ARGUMENT/);
  assert.ok(traceEvents().includes("tool_validation_failed"));
});

test("harness blocks raw credentials in arguments and redacts them", async () => {
  const result = await toolCallHandlers()(
    { toolCallId: "it-credential", toolName: "write", input: { path: "notes.txt", content: "api" + "_key: " + "abcdefghijklmnop" } },
    makeCtx()
  );
  assert.equal(result?.block, true);
  assert.match(result.reason, /secret/);
});

test("a valid in-workspace write is allowed and check-pointed", async () => {
  const result = await toolCallHandlers()(
    { toolCallId: "it-allowed", toolName: "write", input: { path: "src/allowed.txt" } },
    makeCtx()
  );
  assert.equal(result, undefined, "an allowed call returns no block instruction");
  const events = traceEvents();
  assert.ok(events.includes("tool_allowed"));
  assert.ok(events.includes("checkpoint_created"), "mutating calls snapshot the target first");
});

test("high-risk calls require approval: deny blocks, approve lets it through", async () => {
  const command = "rm -rf /tmp/equaxis-it-probe";

  const denied = await toolCallHandlers()(
    { toolCallId: "it-high-deny", toolName: "bash", input: { command } },
    makeCtx({ selectChoice: "Deny this call" })
  );
  assert.equal(denied?.block, true);
  assert.match(denied.reason, /denied by user/);
  assert.ok(traceEvents().includes("approval_denied"));

  const approved = await toolCallHandlers()(
    { toolCallId: "it-high-approve", toolName: "bash", input: { command } },
    makeCtx({ selectChoice: "Approve this call" })
  );
  assert.equal(approved, undefined, "an approved high-risk call proceeds");
  assert.ok(traceEvents().includes("approval_granted"));
});

test("the trace stream carries the rule version that produced each decision", async () => {
  assert.ok(fs.existsSync(traceFile), "governance must write an auditable trace");
  const records = fs
    .readFileSync(traceFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const governance = records.filter((record) => typeof record.risk === "string");
  assert.ok(governance.length >= 4, "policy decisions are traced with a risk classification");
  assert.ok(governance.some((record) => record.toolName === "write"));
  assert.ok(governance.some((record) => record.toolName === "bash"));
});
