// Real adapter regression: talks to actual debugpy (DAP) and, when
// available, typescript-language-server (LSP) through the stdio transport.
// LSP is skipped (not failed) when the binary is not installed.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { killProcessTree } from "../src/process-cleanup.mjs";
import { connectProtocolSocket, spawnProtocolProcess } from "../src/protocol-transport.mjs";

function waitForPort(port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error("adapter port never opened"));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function frame(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function nextSeq() { return ++seq; }
let seq = 0;

function request(transport, command, arguments_) {
  return new Promise((resolve, reject) => {
    const id = nextSeq();
    const timer = setTimeout(() => reject(new Error(`DAP ${command} timed out`)), 15000);
    const onMessage = (frame) => {
      if (frame.type === "response" && frame.request_seq === id) {
        clearTimeout(timer);
        transport.removeMessageListener?.(onMessage);
        resolve(frame);
      }
    };
    transport.onMessage(onMessage);
    transport.send(frame({ seq: id, type: "request", command, arguments: arguments_ ?? {} }));
  });
}

function lspRequest(transport, method, params) {
  return new Promise((resolve, reject) => {
    const id = nextSeq();
    const timer = setTimeout(() => reject(new Error(`LSP ${method} timed out`)), 15000);
    const onMessage = (frame) => {
      if (frame.id === id && (frame.result !== undefined || frame.error !== undefined)) {
        clearTimeout(timer);
        resolve(frame);
      }
    };
    transport.onMessage(onMessage);
    transport.send(frame({ jsonrpc: "2.0", id, method, params: params ?? null }));
  });
}

function dapAvailable() {
  const probe = spawnSync("python", ["-m", "debugpy.adapter", "--version"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  return probe.error === undefined;
}

test("real debugpy adapter (TCP) initializes and launches a fixture", { skip: dapAvailable() ? false : "debugpy not installed" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-dap-real-"));
  const program = path.join(root, "fixture.py");
  fs.writeFileSync(program, "print(42)\n", "utf8");
  const port = 42000 + Math.floor(Math.random() * 10000);
  // debugpy.adapter is a TCP server, not a stdio process; the equaxis
  // protocol transport connects to it over a socket.
  const adapter = spawn("python", ["-m", "debugpy.adapter", "--port", String(port), "--host", "127.0.0.1"], { stdio: "ignore", detached: true });
  let handle = null;
  t.after(() => {
    handle?.close();
    try { killProcessTree(adapter.pid); } catch {}
    // let the debuggee exit and release the directory before cleanup
    return new Promise((resolve) => setTimeout(() => {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
      resolve();
    }, 500));
  });
  // Give the adapter a moment to bind; probing with a throwaway connection
  // makes debugpy treat it as the session client and reset the real one.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  try {
    handle = connectProtocolSocket("127.0.0.1", port);
    const init = await request(handle.transport, "initialize", {
      adapterID: "python", clientID: "equaxis-test", clientName: "equaxis-test",
      pathFormat: "path", linesStartAt1: true, columnsStartAt1: true
    });
    assert.equal(init.success, true, "initialize should succeed");
    assert.ok(init.body?.supportsConfigurationDoneRequest !== undefined);
    const launch = await request(handle.transport, "launch", { program, cwd: root, console: "internalConsole", noDebug: true });
    assert.equal(launch.success, true, "launch should succeed for a runnable fixture");
    assert.equal(launch.command, "launch");
  } catch (error) {
    handle?.close();
    try { adapter.kill(); } catch {}
    throw error;
  }
});

import { fileURLToPath, pathToFileURL } from "node:url";
const lspCli = fileURLToPath(new URL("../node_modules/typescript-language-server/lib/cli.mjs", import.meta.url));
const lspProbe = spawnSync(process.execPath, [lspCli, "--version"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
const lspAvailable = lspProbe.error === undefined;

test("real typescript-language-server initializes and opens a document", { skip: lspAvailable ? false : "typescript-language-server not installed (npm i -g typescript-language-server)" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-lsp-real-"));
  const file = path.join(root, "sample.ts");
  fs.writeFileSync(file, "export const value = 1;\n", "utf8");
  const handle = spawnProtocolProcess(process.execPath, [lspCli, "--stdio"], { cwd: root });
  t.after(() => {
    try { handle.close(); } catch {}
    if (handle.process?.pid) { try { killProcessTree(handle.process.pid); } catch {} }
    return new Promise((resolve) => setTimeout(() => {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
      resolve();
    }, 300));
  });

  const init = await lspRequest(handle.transport, "initialize", { rootUri: pathToFileURL(root).href, capabilities: {}, processId: null });
  assert.equal(init.error, undefined, "LSP initialize should succeed");
  assert.ok(init.result?.capabilities?.textDocumentSync !== undefined);
  handle.transport.send(frame({ jsonrpc: "2.0", method: "initialized", params: {} }));

  // didOpen is a notification; prove the server is alive by sending it and
  // then a real request (shutdown) that must be answered.
  handle.transport.send(frame({
    jsonrpc: "2.0", method: "textDocument/didOpen",
    params: { textDocument: { uri: pathToFileURL(file).href, languageId: "typescript", version: 1, text: fs.readFileSync(file, "utf8") } }
  }));
  const shutdown = await lspRequest(handle.transport, "shutdown", null);
  assert.equal(shutdown.error, undefined, "LSP shutdown should succeed after didOpen");
});