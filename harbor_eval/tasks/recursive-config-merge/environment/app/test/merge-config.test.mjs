import test from "node:test";
import assert from "node:assert/strict";
import { mergeConfig } from "../src/merge-config.mjs";

test("preserves sibling settings during a nested override", () => {
  const result = mergeConfig(
    { service: { host: "localhost", ports: [80] } },
    { service: { ports: [443] } }
  );
  assert.deepEqual(result, {
    service: { host: "localhost", ports: [443] }
  });
});
