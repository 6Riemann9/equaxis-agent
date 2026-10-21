#!/usr/bin/env node
/**
 * Live protocol smoke: exercise the configured LSP and DAP adapters against
 * real processes (no test fixtures needed). Prints a compact PASS/FAIL line
 * per adapter; exit code 0 when everything probed passed.
 *
 *   node scripts/test-protocols-live.mjs [--cwd <dir>]
 */

import fs from "node:fs";
import path from "node:path";
import { LspClient } from "../src/lsp-client.mjs";
import { DapClient } from "../src/dap-client.mjs";
import { spawnProtocolProcess } from "../src/protocol-transport.mjs";
import { loadEquaxisConfig } from "../src/equaxis-config.mjs";

const cwd = path.resolve(process.argv[process.argv.indexOf("--cwd") + 1] ?? process.cwd());
const config = loadEquaxisConfig(cwd);
const results = [];

async function probeLsp() {
  const adapter = config.protocols?.lsp;
  if (!adapter?.command) return results.push({ adapter: "lsp", ok: true, detail: "skipped (not configured)" });
  const workspace = fs.mkdtempSync(path.join(cwd.startsWith("/tmp") ? "/tmp/" : "/tmp/", "equaxis-lsp-probe-"));
  const docPath = path.join(workspace, "probe.ts");
  fs.writeFileSync(docPath, "const answer: number = 42;\nconsole.log(answer);\n");
  const spawned = spawnProtocolProcess(adapter.command, adapter.args ?? [], { cwd: workspace, requestTimeoutMs: adapter.requestTimeoutMs ?? 30000 });
  const client = new LspClient(spawned.transport, { rootPath: workspace, requestTimeoutMs: adapter.requestTimeoutMs ?? 30000 });
  try {
    const init = await client.initialize();
    const server = init?.serverInfo?.name ?? "unknown-server";
    client.notify("textDocument/didOpen", {
      textDocument: { uri: `file://${docPath}`, languageId: "typescript", version: 1, text: fs.readFileSync(docPath, "utf8") }
    });
    const hover = await client.request("textDocument/hover", {
      textDocument: { uri: `file://${docPath}` },
      position: { line: 0, character: 7 }
    });
    results.push({ adapter: "lsp", ok: true, detail: `${server}; hover=${hover ? "ok" : "empty"}` });
  } finally {
    try { await client.request("shutdown"); client.notify("exit"); } catch { /* closing */ }
    spawned.close?.();
  }
}

async function probeDap() {
  const adapter = config.protocols?.dap;
  if (!adapter?.command) return results.push({ adapter: "dap", ok: true, detail: "skipped (not configured)" });
  const workspace = fs.mkdtempSync("/tmp/equaxis-dap-probe-");
  const program = path.join(workspace, "probe.py");
  fs.writeFileSync(program, "value = 21 * 2\nprint(value)\n");
  const spawned = spawnProtocolProcess(adapter.command, adapter.args ?? [], { cwd: workspace, requestTimeoutMs: adapter.requestTimeoutMs ?? 30000 });
  const client = new DapClient(spawned.transport, { rootPath: workspace, requestTimeoutMs: adapter.requestTimeoutMs ?? 30000 });
  try {
    await client.initialize();
    // debugpy answers launch only after configurationDone — keep it pending.
    const launch = client.launch({ type: "python", request: "launch", name: "equaxis-probe", program, cwd: workspace, justMyCode: false, console: "internalConsole" });
    await client.configurationDone();
    await launch;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && client.exitedCode === null && !client.terminated) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const printed = client.outputs.some((entry) => String(entry?.output ?? "").includes("42"));
    results.push({ adapter: "dap", ok: printed, detail: `exit=${client.exitedCode ?? "?"}; output42=${printed}` });
  } finally {
    try { await client.request("disconnect", { terminateDebuggee: true }); } catch { /* closing */ }
    spawned.close?.();
  }
}

for (const probe of [probeLsp, probeDap]) {
  try {
    await probe();
  } catch (error) {
    results.push({ adapter: probe === probeLsp ? "lsp" : "dap", ok: false, detail: String(error?.message ?? error).slice(0, 160) });
  }
}

for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.adapter}: ${result.detail}`);
}
process.exit(results.every((result) => result.ok) ? 0 : 1);
