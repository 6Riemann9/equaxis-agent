import test from "node:test";
import assert from "node:assert/strict";
import { scheduleTools } from "../src/tool-scheduler.mjs";

test("parallelizes independent reads and respects dependencies", () => {
  const result = scheduleTools([
    { id: "read-a", toolName: "read", readOnly: true, estimatedMs: 100 },
    { id: "read-b", toolName: "read", readOnly: true, estimatedMs: 200 },
    { id: "edit", toolName: "edit", readOnly: false, dependsOn: ["read-a", "read-b"], estimatedMs: 50 }
  ], { maxConcurrency: 4 });
  assert.deepEqual(result.waves.map((wave) => wave.tasks.map((task) => task.id)), [["read-a", "read-b"], ["edit"]]);
  assert.equal(result.estimatedCriticalPathMs, 250);
});

test("serializes side effects even when independent", () => {
  const result = scheduleTools([
    { id: "write-a", toolName: "write", readOnly: false },
    { id: "write-b", toolName: "write", readOnly: false }
  ]);
  assert.equal(result.waveCount, 2);
  assert.equal(result.maxParallelism, 1);
});

test("isolates high-risk tasks and rejects cycles", () => {
  const safe = scheduleTools([
    { id: "read", toolName: "read" },
    { id: "destroy", toolName: "bash", risk: "high", readOnly: false }
  ]);
  assert.deepEqual(safe.waves.map((wave) => wave.tasks.map((task) => task.id)), [["read"], ["destroy"]]);
  assert.throws(() => scheduleTools([
    { id: "a", toolName: "read", dependsOn: ["b"] },
    { id: "b", toolName: "read", dependsOn: ["a"] }
  ]), /cycle/);
});
