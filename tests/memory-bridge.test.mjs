import test from "node:test";
import assert from "node:assert/strict";
import { MemoryBridge, buildPythonBridgeEnv } from "../src/memory-bridge.mjs";

test("forces UTF-8 stdio for the Python memory bridge", () => {
  const env = buildPythonBridgeEnv({
    KEEP_ME: "yes",
    PYTHONIOENCODING: "gbk",
    PYTHONUTF8: "0"
  });

  assert.equal(env.KEEP_ME, "yes");
  assert.equal(env.PYTHONIOENCODING, "utf-8");
  assert.equal(env.PYTHONUTF8, "1");
});

test("parses escaped Unicode responses from the Python memory bridge", async () => {
  const bridge = new MemoryBridge({ cwd: process.cwd(), pythonCommand: "python", rootDir: "." });
  const result = new Promise((resolve, reject) => {
    bridge.pending.set("1", { resolve, reject });
  });

  bridge.handleLine('__EQUAXIS_MEMORY__{"id":"1","ok":true,"result":{"content":"\\u4e2d\\u6587\\ufffd"}}');

  assert.deepEqual(await result, { content: "\u4e2d\u6587\ufffd" });
});
