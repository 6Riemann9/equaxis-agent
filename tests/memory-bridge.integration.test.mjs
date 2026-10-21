import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryBridge } from "../src/memory-bridge.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

// The vendored bridge needs the Python deps. The rest of the memory suite runs
// against the project venv (scripts/memory-tests.mjs does the same), so use it
// when present and fall back to the system interpreter otherwise.
const venvPython = path.join(projectRoot, ".venv", "bin", "python");
const pythonCommand = fs.existsSync(venvPython) ? venvPython : "python";

/**
 * The bridge's `remember` needs the chromadb ONNX embedding model. It is
 * fetched from the HuggingFace CDN on first use, and on a host without that
 * access chromadb leaves a truncated `onnx.tar.gz` behind and every embed
 * hangs until the request times out. That is an environment limitation, not a
 * product failure, so the suite says so explicitly instead of failing — or
 * worse, passing silently.
 */
function embeddingModelStatus() {
  const cacheDir = path.join(os.homedir(), ".cache", "chroma", "onnx_models", "all-MiniLM-L6-v2");
  const archive = path.join(cacheDir, "onnx.tar.gz");
  const MIN_PLAUSIBLE_BYTES = 5 * 1024 * 1024;
  if (!fs.existsSync(archive)) return { ok: false, reason: "embedding model is not cached" };
  const size = fs.statSync(archive).size;
  if (size < MIN_PLAUSIBLE_BYTES) {
    return { ok: false, reason: `embedding model download is truncated (${size} bytes at ${archive})` };
  }
  return { ok: true };
}

test("runs the vendored Python memory core through the persistent bridge", async (t) => {
  const model = embeddingModelStatus();
  if (!model.ok) {
    t.skip(`requires the chromadb embedding model: ${model.reason}. Fetch it once with network access (see docs/MEMORY.md).`);
    return;
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-memory-"));
  const diagnostics = [];
  const bridge = new MemoryBridge({
    cwd: projectRoot,
    pythonCommand,
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

  const updated = await bridge.request("update_memory", {
    drawer_id: drawerId,
    content: "Updated memory content.",
    room: "integration-edit",
    hall: "hall_preferences",
    source_file: "pi-web-test"
  });
  assert.equal(updated.record.drawer_id, drawerId);
  assert.equal(updated.record.content, "Updated memory content.");
  assert.equal(updated.record.room, "integration-edit");
  assert.equal(updated.record.hall, "hall_preferences");
  assert.equal(updated.record.source_file, "pi-web-test");

  const visualize = await bridge.request("visualize", { limit: 500 });
  const found = visualize.drawers.find((drawer) => drawer.id === drawerId);
  assert.ok(found, "updated drawer appears in visualize snapshot");
  assert.equal(found.content, "Updated memory content.");
  assert.equal(found.room, "integration-edit");

  await assert.rejects(
    bridge.request("update_memory", { drawer_id: "drawer_does_not_exist" }),
    /Unknown drawer/
  );

  const deleted = await bridge.request("delete_memory", { drawer_id: drawerId });
  assert.deepEqual(deleted, { deleted: true, drawer_id: drawerId });

  const status = await bridge.request("status");
  assert.equal(status.config.history_entries, 2);
  assert.equal(Array.isArray(status.wings), false);
  assert.equal(diagnostics.some((line) => line.includes("Traceback")), false);
});
