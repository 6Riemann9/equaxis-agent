import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { VersionStore } from "../src/version-store.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-version-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("writes and lists versioned candidate artifacts", (t) => {
  const root = workspace(t);
  const store = new VersionStore({ projectRoot: root });
  const artifact = store.writeCandidate({
    kind: "prompt",
    id: "summarizer-v2",
    provenance: { source: "eval-loop", parentVersion: "summarizer-v1" },
    changes: [{ path: "prompts/summarizer.md", op: "edit" }]
  });
  assert.equal(artifact.kind, "prompt");
  assert.match(artifact.sha, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(artifact.path), true);
  const listed = store.list("prompt");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "summarizer-v2");
});

test("rejects version store paths outside the workspace", (t) => {
  const root = workspace(t);
  assert.throws(() => new VersionStore({ projectRoot: root, rootDir: "../outside" }), /must stay inside the workspace/);
});
