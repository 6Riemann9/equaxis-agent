import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { RotatingJsonlTrace, redactTraceValue } from "../src/trace-store.mjs";

test("recursively redacts credential fields and strings", () => {
  const sanitized = redactTraceValue({
    token: "abcdefgh123456",
    nested: { error: "request failed: api_key=abcdefgh123456", auth: "Bearer abcdefgh123456" }
  });
  assert.equal(sanitized.token, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(sanitized), /abcdefgh123456/);
  assert.equal(redactTraceValue("failed sk-abcdefghijklmnopqrstuv"), "failed [REDACTED]");
});

test("rotates JSONL traces with bounded retention", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-trace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "traces.jsonl");
  const store = new RotatingJsonlTrace(file, { maxFileBytes: 80, maxFiles: 2 });
  store.append({ event: "first", value: "x".repeat(45) });
  store.append({ event: "second", value: "y".repeat(45) });
  store.append({ event: "third", value: "z".repeat(45) });
  assert.match(fs.readFileSync(file, "utf8"), /third/);
  assert.match(fs.readFileSync(path.join(root, "traces.1.jsonl"), "utf8"), /second/);
  assert.equal(fs.existsSync(path.join(root, "traces.2.jsonl")), false);
});
