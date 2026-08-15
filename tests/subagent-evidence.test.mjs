import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createFileEvidenceVerifier } from "../src/subagent-evidence.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("verifier confirms existing artifact paths", async (t) => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, "build"), { recursive: true });
  fs.writeFileSync(path.join(root, "build", "report.md"), "ok", "utf8");
  const verify = createFileEvidenceVerifier({ projectRoot: root });

  const ok = await verify({ id: "t1" }, { ok: true, artifact: "build/report.md" });
  assert.deepEqual(ok, { ok: true, issues: [], verified: ["build/report.md"] });

  const absolute = await verify({ id: "t2" }, { filePath: path.join(root, "build", "report.md") });
  assert.equal(absolute.ok, true);

  // no artifact fields -> vacuously verified
  const none = await verify({ id: "t3" }, { ok: true, note: "nothing to check" });
  assert.deepEqual(none, { ok: true, issues: [] });
});

test("verifier flags missing artifacts and skips non-path values", async (t) => {
  const root = workspace(t);
  const verify = createFileEvidenceVerifier({ projectRoot: root });

  const missing = await verify({ id: "t1" }, { ok: true, artifact: "build/missing.md", file: "nope.txt" });
  assert.equal(missing.ok, false);
  assert.equal(missing.issues.length, 2);

  // URLs and inline content are not filesystem claims
  const skipped = await verify({ id: "t2" }, { ok: true, url: "https://example.com/x", artifact: "data:image/png;base64,AA==" });
  assert.equal(skipped.ok, true);

  // nested collection fields are scanned
  fs.writeFileSync(path.join(root, "exists.txt"), "ok", "utf8");
  const nested = await verify({ id: "t3" }, { ok: true, files: ["exists.txt"], artifacts: ["missing.txt"] });
  assert.equal(nested.ok, false);
  assert.deepEqual(nested.issues, ["claimed artifact not found: missing.txt"]);
});

test("verifier treats relative paths against workspace root", async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "root.txt"), "ok", "utf8");
  const verify = createFileEvidenceVerifier({ projectRoot: root });
  const result = await verify({ id: "t1" }, { ok: true, path: "root.txt" });
  assert.equal(result.ok, true);
  // path traversal outside the root still resolves (existence check only, audit not gate)
  const outside = await verify({ id: "t2" }, { ok: true, path: "../outside.txt" });
  assert.equal(outside.ok, false);
});
