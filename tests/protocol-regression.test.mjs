import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { formatProtocolRegressionReport, runProtocolRegression } from "../src/protocol-regression.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-protocol-regression-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("runs the protocol regression test set and writes a passing trace", (t) => {
  const root = workspace(t);
  const calls = [];
  const report = runProtocolRegression({
    projectRoot: root,
    invocation: { command: "node", args: ["--test", "tests/lsp-client.test.mjs"] },
    spawnSyncImpl: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 0, stdout: "ok", stderr: "" };
    }
  });
  assert.equal(report.ok, true);
  assert.equal(report.status, 0);
  assert.equal(calls[0].cwd, root);
  assert.deepEqual(calls[0].args, ["--test", "tests/lsp-client.test.mjs"]);
  assert.match(formatProtocolRegressionReport(report), /Protocol regression passed/);

  const trace = fs.readFileSync(path.join(root, ".pi", "runtime", "protocols", "traces.jsonl"), "utf8");
  assert.match(trace, /protocol_regression_started/);
  assert.match(trace, /protocol_regression_passed/);
});

test("includes protocol adapter discovery in regression traces when config is provided", (t) => {
  const root = workspace(t);
  const report = runProtocolRegression({
    projectRoot: root,
    config: { protocols: { lsp: {}, dap: {} } },
    invocation: { command: "node", args: ["--test", "tests/lsp-client.test.mjs"] },
    spawnSyncImpl: () => ({ status: 0, stdout: "ok", stderr: "" })
  });
  assert.equal(report.adapters.lsp.status, "skipped");
  const trace = fs.readFileSync(path.join(root, ".pi", "runtime", "protocols", "traces.jsonl"), "utf8");
  assert.match(trace, /"adapters"/);
});

test("preserves redacted protocol failure diagnostics", (t) => {
  const root = workspace(t);
  const marker = "fixture" + "credential";
  const report = runProtocolRegression({
    projectRoot: root,
    invocation: { command: "node", args: ["--test", "tests/dap-client.test.mjs"] },
    spawnSyncImpl: () => ({
      status: 1,
      stdout: `adapter stdout api_${"key"}=${marker}`,
      stderr: `adapter failed with Bearer ${marker}`
    })
  });
  assert.equal(report.ok, false);
  assert.equal(report.status, 1);
  assert.match(formatProtocolRegressionReport(report), /Protocol regression failed/);
  assert.match(formatProtocolRegressionReport(report), /adapter failed/);

  const trace = fs.readFileSync(path.join(root, ".pi", "runtime", "protocols", "traces.jsonl"), "utf8");
  assert.match(trace, /protocol_regression_failed/);
  assert.match(trace, /\[REDACTED\]/);
  assert.doesNotMatch(trace, new RegExp(marker));
});
