import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createIsolatedEnv, describeRuntimeIsolation, prepareRuntimeIsolation } from "../src/runtime-isolation.mjs";

test("isolated env keeps only allowed non-secret variables", () => {
  const env = createIsolatedEnv({
    PATH: "/bin",
    OPENAI_API_KEY: "secret",
    CUSTOM_TOKEN: "secret",
    SAFE_FLAG: "yes"
  }, { extraAllowlist: ["SAFE_FLAG"], extraEnv: { EQUAXIS_TEST: "1" } });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.SAFE_FLAG, "yes");
  assert.equal(env.EQUAXIS_TEST, "1");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CUSTOM_TOKEN, undefined);
});

test("runtime isolation creates workspace-local output directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-isolation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const isolation = prepareRuntimeIsolation({ projectRoot: root, cwd: ".", env: { PATH: "/bin" }, kind: "subagent", id: "a" });
  assert.equal(isolation.cwd, root);
  assert.equal(isolation.env.EQUAXIS_ISOLATED_RUN, "1");
  assert.equal(isolation.outputDir, path.join(root, ".pi", "runtime", "isolated", "subagent", "a"));
  assert.equal(fs.existsSync(isolation.outputDir), true);
  assert.throws(() => prepareRuntimeIsolation({ projectRoot: root, cwd: ".." }), /cwd must stay inside/);
  assert.throws(() => prepareRuntimeIsolation({ projectRoot: root, outputRoot: "../outside" }), /outputRoot must stay inside/);
});

test("runtime isolation description follows subagent config", () => {
  assert.deepEqual(describeRuntimeIsolation({ subagents: { isolation: { enabled: false } } }), { enabled: false, detail: "disabled" });
  assert.deepEqual(
    describeRuntimeIsolation({ subagents: { isolation: { enabled: true, scrubEnv: false, outputRoot: ".tmp/agents" } } }),
    { enabled: true, detail: "inherited-env; outputRoot=.tmp/agents" }
  );
});
