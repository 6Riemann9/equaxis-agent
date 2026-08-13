import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createPiJsonExecutor } from "../src/subagent-executor.mjs";
import { EventEmitter } from "node:events";

function fakeSpawnCollector(calls) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    calls.push({ command, args, options, child });
    return child;
  };
}

test("spawns Pi JSON mode with the prompt as the final argument", async () => {
  const calls = [];
  const executor = createPiJsonExecutor({ piEntry: "/pi/cli.js", spawnImpl: fakeSpawnCollector(calls) });
  const run = executor({ id: "a", label: "a", prompt: "inspect the repo" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  const [command, args] = [calls[0].command, calls[0].args];
  assert.equal(command, process.execPath);
  assert.equal(args[0], "/pi/cli.js");
  assert.ok(args.includes("--mode"));
  assert.ok(args.includes("json"));
  assert.equal(args[args.length - 1], "inspect the repo");
  // resolve the pending promise so the test does not leak
  run.finally(() => {});
});

test("resolves ok with captured stdout on clean exit", async () => {
  const calls = [];
  const executor = createPiJsonExecutor({ piEntry: "/pi/cli.js", spawnImpl: fakeSpawnCollector(calls) });
  const promise = executor({ id: "a", label: "a", prompt: "do it" });
  await new Promise((resolve) => setImmediate(resolve));
  const child = calls[0] && calls[0].child;
  if (!child) throw new Error("child not created");
  child.stdout.emit("data", Buffer.from("summary done"));
  child.emit("close", 0);
  const result = await promise;
  assert.equal(result.ok, true);
  assert.equal(result.id, "a");
  assert.equal(result.output, "summary done");
});

test("rejects when the pi json subprocess exits nonzero and spills output", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-subagent-executor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const executor = createPiJsonExecutor({ piEntry: "/pi/cli.js", projectRoot: root, spawnImpl: fakeSpawnCollector(calls) });
  const promise = executor({ id: "a", prompt: "fail", attempt: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const child = calls[0] && calls[0].child;
  if (!child) throw new Error("child not created");
  child.stderr.emit("data", Buffer.from("boom"));
  child.stdout.emit("data", Buffer.from("partial stdout"));
  child.emit("close", 1);
  await assert.rejects(promise, /exited 1: boom \(full output:/);
  const artifact = path.join(root, ".pi", "runtime", "subagents", "artifacts", "a-attempt1.out");
  assert.equal(fs.existsSync(artifact), true);
  assert.match(fs.readFileSync(artifact, "utf8"), /partial stdout/);
  assert.match(fs.readFileSync(artifact, "utf8"), /boom/);
});

test("rejects immediately when the prompt is missing", async () => {
  const executor = createPiJsonExecutor({ piEntry: "/pi/cli.js", spawnImpl: fakeSpawnCollector([]) });
  await assert.rejects(executor({ id: "a" }), /prompt is required/);
});

test("isolates subagent cwd, env, and output directory by default", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-subagent-executor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const executor = createPiJsonExecutor({
    piEntry: "/pi/cli.js",
    projectRoot: root,
    cwd: ".",
    env: { OPENAI_API_KEY: "secret", PATH: "/bin", SAFE_FLAG: "1" },
    spawnImpl: fakeSpawnCollector(calls)
  });
  const promise = executor({ id: "a", label: "a", prompt: "do it" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cwd, root);
  assert.equal(calls[0].options.env.PATH, "/bin");
  assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(calls[0].options.env.SAFE_FLAG, undefined);
  assert.equal(calls[0].options.env.EQUAXIS_ISOLATED_RUN, "1");
  assert.equal(calls[0].options.env.EQUAXIS_ISOLATION_OUTPUT_DIR, path.join(root, ".pi", "runtime", "isolated", "subagent", "a"));
  assert.equal(fs.existsSync(calls[0].options.env.EQUAXIS_ISOLATION_OUTPUT_DIR), true);
  calls[0].child.emit("close", 0);
  await promise;
});
