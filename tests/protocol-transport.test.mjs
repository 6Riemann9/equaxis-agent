import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawnProtocolProcess, createStdioTransport } from "../src/protocol-transport.mjs";

function frame(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

test("parses partial and concatenated Content-Length frames", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  const transport = createStdioTransport({ input, output, error });
  const messages = [];
  transport.onMessage((message) => messages.push(message));

  const bytes = Buffer.from(frame({ id: 1, ok: true }) + frame({ id: 2, ok: "yes" }));
  output.write(bytes.subarray(0, 11));
  assert.deepEqual(messages, []);
  output.write(bytes.subarray(11, 29));
  assert.deepEqual(messages, []);
  output.write(bytes.subarray(29));

  assert.deepEqual(messages, [{ id: 1, ok: true }, { id: 2, ok: "yes" }]);
  assert.equal(transport.bufferedBytes, 0);
  transport.close();
});

test("reports malformed frames and stderr without throwing", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  const transport = createStdioTransport({ input, output, error });
  const errors = [];
  transport.onError((value) => errors.push(value.message));

  output.write("Content-Length: nope\r\n\r\n{}");
  error.write("language server warning\n");

  assert.match(errors[0], /valid Content-Length/);
  assert.equal(errors[1], "language server warning");
  transport.close();
});

test("spawns a real stdio protocol process and closes it", async () => {
  const childScript = [
    "let data = Buffer.alloc(0);",
    "process.stdin.on('data', chunk => {",
    "  data = Buffer.concat([data, chunk]);",
    "  const marker = data.indexOf(Buffer.from('\\r\\n\\r\\n'));",
    "  if (marker < 0) return;",
    "  const headers = data.subarray(0, marker).toString();",
    "  const length = Number(headers.match(/Content-Length: (\\d+)/i)[1]);",
    "  const start = marker + 4;",
    "  if (data.length < start + length) return;",
    "  const request = JSON.parse(data.subarray(start, start + length).toString());",
    "  const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } });",
    "  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);",
    "  data = data.subarray(start + length);",
    "});"
  ].join("\n");
  const handle = spawnProtocolProcess(process.execPath, ["-e", childScript]);
  const response = new Promise((resolve, reject) => {
    handle.transport.onMessage(resolve);
    handle.transport.onError(reject);
  });

  handle.transport.send(frame({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} }));
  const message = await Promise.race([
    response,
    new Promise((_, reject) => setTimeout(() => reject(new Error("protocol process timed out")), 5000))
  ]);
  assert.deepEqual(message, { jsonrpc: "2.0", id: 7, result: { ok: true } });
  handle.close();
  assert.equal(handle.process.killed, true);
});
