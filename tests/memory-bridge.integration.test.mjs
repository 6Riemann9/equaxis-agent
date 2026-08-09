import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryBridge } from "../src/memory-bridge.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("runs the vendored Python memory core through the persistent bridge", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-memory-"));
  const diagnostics = [];
  const bridge = new MemoryBridge({
    cwd: projectRoot,
    pythonCommand: "python",
    rootDir: tempRoot,
    requestTimeoutMs: 30000,
    onDiagnostic: (message) => diagnostics.push(message)
  });

  t.after(async () => {
    await bridge.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await bridge.start();
  const ping = await bridge.request("ping");
  assert.equal(ping.version, "0.1.0");

  await bridge.request("record_user", {
    session_id: "bridge-test",
    content: "My preferred language is TypeScript."
  });
  await bridge.request("record_assistant", {
    session_id: "bridge-test",
    content: "Preference recorded."
  });

  const context = await bridge.request("context", {
    session_id: "bridge-test",
    query: "Which language do I prefer?"
  });
  assert.match(context.context, /preferred language is TypeScript/);

  const remember = await bridge.request("remember", {
    wing: "equaxis",
    room: "integration",
    hall: "hall_general",
    content: "Temporary memory for delete test."
  });
  const drawerId = remember.record.drawer_id;
  assert.ok(drawerId);
  const deleted = await bridge.request("delete_memory", { drawer_id: drawerId });
  assert.deepEqual(deleted, { deleted: true, drawer_id: drawerId });

  const status = await bridge.request("status");
  assert.equal(status.config.history_entries, 2);
  assert.equal(Array.isArray(status.wings), false);
  assert.equal(diagnostics.some((line) => line.includes("Traceback")), false);
});
