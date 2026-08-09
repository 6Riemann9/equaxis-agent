import test from "node:test";
import assert from "node:assert/strict";
import { discoverProtocolAdapters, summarizeProtocolAdapters } from "../src/protocol-adapters.mjs";

test("reports unconfigured protocol adapters as skipped", () => {
  const result = discoverProtocolAdapters({ protocols: { lsp: {}, dap: {} } });
  assert.equal(result.lsp.status, "skipped");
  assert.equal(result.dap.status, "skipped");
  assert.match(summarizeProtocolAdapters(result), /lsp=skipped/);
});

test("discovers configured adapters without making them mandatory", () => {
  const calls = [];
  const result = discoverProtocolAdapters({
    protocols: {
      lsp: { command: "typescript-language-server", args: ["--stdio"] },
      dap: { command: "python", args: ["-m", "debugpy.adapter"] }
    }
  }, {
    spawnSyncImpl: (command, args) => {
      calls.push([command, args]);
      return { status: command === "python" ? 1 : 0, stdout: command === "python" ? "" : command, stderr: "missing debugpy" };
    }
  });
  assert.equal(result.lsp.status, "available");
  assert.equal(result.dap.status, "unavailable");
  assert.equal(result.dap.available, false);
  assert.equal(calls.length, 2);
});
