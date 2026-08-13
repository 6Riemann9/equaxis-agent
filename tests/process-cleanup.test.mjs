import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import {
  describeProcessCleanup,
  killProcessTree,
  registerChild,
  registeredChildren,
  spawnTracked,
  sweepRegisteredChildren,
  unregisterChild
} from "../src/process-cleanup.mjs";

test("killProcessTree delegates to the injectable kill strategy", async () => {
  const calls = [];
  const killImpl = async (pid, opts) => { calls.push({ pid, opts }); return { pid, killed: true }; };
  const outcome = await killProcessTree(4242, { killImpl, signal: "SIGKILL" });
  assert.deepEqual(calls, [{ pid: 4242, opts: { signal: "SIGKILL" } }]);
  assert.equal(outcome.killed, true);
});

test("registry tracks and sweeps children with tree kill", async () => {
  const killed = [];
  registerChild({ pid: 111, label: "one" });
  registerChild({ pid: 222, label: "two", token: "t-two" });
  assert.equal(registeredChildren().length, 2);
  const results = await sweepRegisteredChildren({ killImpl: async (pid) => { killed.push(pid); return { pid, killed: true }; } });
  assert.deepEqual(killed.sort(), [111, 222]);
  assert.equal(results.length, 2);
  assert.ok(results.every((item) => item.killed === true));
  assert.equal(registeredChildren().length, 0, "registry emptied after sweep");
});

test("unregisterChild removes a single child", () => {
  const token = registerChild({ pid: 333, label: "three" });
  assert.equal(registeredChildren().length, 1);
  assert.equal(unregisterChild(token), true);
  assert.equal(registeredChildren().length, 0);
  assert.equal(unregisterChild(token), false);
});

test("spawnTracked registers the child and unregisters on exit", async () => {
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 777;
    child.killed = false;
    calls.push({ command, args, options });
    return child;
  };
  const child = spawnTracked({ command: "node", args: ["-e", "1"], options: {}, label: "fake", spawnImpl: fakeSpawn });
  assert.equal(calls.length, 1);
  assert.equal(registeredChildren().length, 1);
  child.emit("exit");
  assert.equal(registeredChildren().length, 0, "exit unregisters");
});

test("describeProcessCleanup reports the strategy", () => {
  const info = describeProcessCleanup();
  assert.ok(info.strategy.length > 0);
  assert.equal(typeof info.registered, "number");
});