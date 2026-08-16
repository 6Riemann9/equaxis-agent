import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import {
  checkExtensionContracts,
  collectExtensionCapabilities,
  diffExtensionCapabilities,
  extensionCapabilitySnapshot,
  extensionPaths,
  inspectLoadedExtensions,
  satisfiesVersion,
  validateExtensionManifest
} from "../src/extension-compat.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

function writeExtensionRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-extension-contract-"));
  fs.mkdirSync(path.join(root, ".pi", "extensions"), { recursive: true });
  return root;
}

test("matches the supported Pi compatibility range", () => {
  assert.equal(satisfiesVersion("0.83.0", ">=0.83.0 <0.84.0"), true);
  assert.equal(satisfiesVersion("0.83.9", ">=0.83.0 <0.84.0"), true);
  assert.equal(satisfiesVersion("0.84.0", ">=0.83.0 <0.84.0"), false);
  assert.equal(satisfiesVersion("0.83.0", "^0.83.0"), true);
  assert.equal(satisfiesVersion("0.84.0", "^0.83.0"), false);
});

test("rejects missing dependencies and cycles in the extension graph", (t) => {
  const root = writeExtensionRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["a.ts", "b.ts"]) fs.writeFileSync(path.join(root, ".pi", "extensions", name), "export default () => {};\n");

  const report = validateExtensionManifest({
    schemaVersion: 1,
    piRange: "*",
    extensions: [
      { id: "a", entry: "a.ts", contractVersion: 1, piRange: "*", failureMode: "fatal", requires: ["cap:b"], provides: ["cap:a"] },
      { id: "b", entry: "b.ts", contractVersion: 1, piRange: "*", failureMode: "fatal", requires: ["cap:a"], provides: ["cap:b"] }
    ]
  }, { projectRoot: root, piVersion: "0.83.0" });

  assert.equal(report.ok, false);
  assert.ok(report.errors.some((item) => item.message.includes("dependency cycle")));
});

test("reports optional extension load failure as degradation", () => {
  const result = inspectLoadedExtensions(
    {
      extensions: [],
      errors: [{ path: "/project/.pi/extensions/optional.ts", error: "factory failed" }],
      runtime: {}
    },
    {
      errors: [],
      warnings: [],
      contracts: [{
        id: "optional",
        entry: "optional.ts",
        contractVersion: 1,
        failureMode: "degrade",
        requires: [],
        provides: ["tool:optional"]
      }]
    }
  );

  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((item) => item.message.includes("factory failed")));
});

test("treats third-party Pi extensions (no contract) as notes, not warnings", () => {
  const thirdParty = {
    path: "/project/.pi/extensions/community.ts",
    tools: new Map(),
    commands: new Map(),
    flags: new Map(),
    handlers: new Map()
  };
  const result = inspectLoadedExtensions(
    {
      extensions: [thirdParty],
      errors: [{ path: "/project/.pi/extensions/broken-community.ts", error: "factory failed" }],
      runtime: {}
    },
    {
      errors: [],
      warnings: [],
      contracts: []
    }
  );

  // With no Equaxis contracts in play, the runtime stays healthy...
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  // ...and Pi-ecosystem extensions are reported as notes, never as warnings.
  assert.deepEqual(result.warnings, []);
  assert.ok(result.notes.some((item) => item.message.includes("has no Equaxis contract")));
  assert.ok(result.notes.some((item) => item.message.includes("uncontracted extension failed to load")));
});

test("detects a loaded extension that violates its declared capabilities", () => {
  const extension = {
    path: "/project/.pi/extensions/core.ts",
    tools: new Map(),
    commands: new Map(),
    flags: new Map(),
    handlers: new Map()
  };
  const result = inspectLoadedExtensions(
    { extensions: [extension], errors: [], runtime: {} },
    {
      errors: [],
      warnings: [],
      contracts: [{
        id: "core",
        entry: "core.ts",
        contractVersion: 1,
        failureMode: "fatal",
        requires: [],
        provides: ["tool:required_tool"]
      }]
    }
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.message.includes("required_tool")));
});

test("selects extension paths from manifest and preserves fatal contracts", () => {
  const manifest = {
    extensions: [
      { id: "provider", entry: "provider.ts", failureMode: "fatal" },
      { id: "memory", entry: "memory.ts", failureMode: "degrade" },
      { id: "web", entry: "web.ts", failureMode: "degrade" }
    ]
  };
  const selected = extensionPaths("/project", manifest, { enabled: ["web"], disabled: ["memory"] })
    .map((item) => path.basename(item));
  assert.deepEqual(selected, ["provider.ts", "web.ts"]);
});

test("validates and loads the repository extension contracts against Pi", async (t) => {
  const report = checkExtensionContracts({ projectRoot });
  assert.equal(report.ok, true, report.errors.map((item) => item.message).join("; "));
  assert.equal(report.piVersion, "0.83.0");

  const loaded = await discoverAndLoadExtensions(
    extensionPaths(projectRoot, report.manifest),
    projectRoot,
    path.join(os.tmpdir(), "equaxis-contract-agent-home")
  );
  t.after(() => fs.rmSync(path.join(os.tmpdir(), "equaxis-contract-agent-home"), { recursive: true, force: true }));

  const runtimeReport = inspectLoadedExtensions(loaded, report);
  assert.equal(loaded.errors.length, 0, loaded.errors.map((item) => item.error).join("; "));
  assert.equal(runtimeReport.ok, true, runtimeReport.errors.map((item) => item.message).join("; "));
  assert.ok(runtimeReport.capabilities.includes("tool:memory_search"));
  assert.ok(runtimeReport.capabilities.includes("provider:openai-inprior"));
});

test("compares extension capability snapshots across upgrades", () => {
  const diff = diffExtensionCapabilities(
    { "example.ts": ["command:old", "tool:stable"] },
    { "example.ts": ["command:new", "tool:stable"], "new.ts": ["tool:added"] }
  );
  assert.deepEqual(diff.added, ["example.ts:command:new", "new.ts:tool:added"]);
  assert.deepEqual(diff.removed, ["example.ts:command:old"]);
  assert.equal(diff.compatible, false);
});

test("collects registered capabilities without exposing implementation details", () => {
  const capabilities = collectExtensionCapabilities({
    path: "/project/.pi/extensions/example.ts",
    tools: new Map([["example_tool", {}]]),
    commands: new Map([["example", {}]]),
    flags: new Map([["example-flag", {}]]),
    handlers: new Map([["session_start", []]])
  }, [{ name: "example-provider", extensionPath: "/project/.pi/extensions/example.ts" }]);

  assert.deepEqual(capabilities, [
    "command:example",
    "event:session_start",
    "flag:example-flag",
    "provider:example-provider",
    "tool:example_tool"
  ]);
  assert.deepEqual(extensionCapabilitySnapshot({ extensions: [{
    path: "/project/.pi/extensions/example.ts",
    tools: new Map([["example_tool", {}]]),
    commands: new Map([["example", {}]]),
    flags: new Map([["example-flag", {}]]),
    handlers: new Map([["session_start", []]])
  }], runtime: {} }, [{
    name: "example-provider",
    extensionPath: "/project/.pi/extensions/example.ts"
  }]), {
    "example.ts": capabilities
  });
});
