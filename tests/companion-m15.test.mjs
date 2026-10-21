import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const extensionPath = path.join(process.cwd(), ".pi", "extensions", "companion.ts");
const source = fs.readFileSync(extensionPath, "utf8");

/**
 * The in-session extension is the surface a user actually meets. It fell
 * behind the CLI once (five M0 tools while M1–M14 landed), so the tool set
 * and the /companion subcommands are pinned here: adding a capability
 * without exposing it should be a deliberate choice, not an oversight.
 */

function toolNames() {
  return [...source.matchAll(/pi\.registerTool\(\{\s*\n\s*name: "([a-z_]+)"/g)].map((match) => match[1]);
}

test("m15 extension: exposes every companion capability, not just M0", () => {
  const names = new Set(toolNames());
  const required = [
    // M0 data plane
    "companion_create_teammate",
    "companion_list_teammates",
    "companion_submit_task",
    "companion_send_message",
    "companion_task_status",
    // M1–M14 capabilities
    "companion_logs",
    "companion_artifacts",
    "companion_routines",
    "companion_credentials",
    "companion_approvals",
    "companion_backends",
    "companion_template"
  ];
  const missing = required.filter((name) => !names.has(name));
  assert.deepEqual(missing, [], `missing tools: ${missing.join(", ")}`);
});

test("m15 extension: every tool has a description and a schema", () => {
  const blocks = source.split("pi.registerTool({").slice(1);
  assert.ok(blocks.length >= 12, `expected at least 12 tools, found ${blocks.length}`);
  for (const block of blocks) {
    const name = block.match(/name: "([a-z_]+)"/)?.[1] ?? "(unnamed)";
    assert.match(block, /description: "/, `${name} must describe itself`);
    assert.match(block, /parameters: Type\./, `${name} must declare parameters`);
    assert.match(block, /async execute\(/, `${name} must implement execute`);
  }
});

test("m15 extension: /companion covers the new subcommands", () => {
  const command = source.match(/pi\.registerCommand\("companion",[\s\S]*?\n  \}\);/)?.[0] ?? "";
  for (const subcommand of ["logs", "files", "routines", "creds", "approvals", "backends", "export", "reset"]) {
    assert.match(command, new RegExp(`case "${subcommand}"`), `/companion must handle ${subcommand}`);
  }
});

test("m15 extension: the high-risk approval path is a real human gate", () => {
  // The tool must not approve anything silently: decisions require an id and
  // land through the same decision file the harness polls.
  assert.match(source, /writeApprovalDecision\(root, traceDir, String\(params\.requestId\)/);
  assert.match(source, /if \(!params\.requestId\)/);
});

test("m15 extension: no capability is reachable only through the CLI worker", () => {
  // Sanity: the extension imports the same modules the CLI uses, rather than
  // re-implementing behaviour with different semantics.
  for (const module of [
    "companion-store.mjs",
    "companion-templates.mjs",
    "companion-backends.mjs",
    "companion-artifacts.mjs",
    "approval-queue.mjs",
    "duration.mjs",
    "equaxis-config.mjs"
  ]) {
    assert.match(source, new RegExp(module.replace(".", "\\.")), `extension must reuse ${module}`);
  }
});
