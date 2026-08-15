import test from "node:test";
import assert from "node:assert/strict";
import { createPrefixTracker, longestCommonPrefixLength, stablePrefixStats } from "../src/prefix-stability.mjs";

test("longestCommonPrefixLength computes byte-level stable prefix", () => {
  assert.equal(longestCommonPrefixLength("abc", "abc"), 3);
  assert.equal(longestCommonPrefixLength("abcde", "abxyz"), 2);
  assert.equal(longestCommonPrefixLength("", "abc"), 0);
  assert.equal(longestCommonPrefixLength("abc", ""), 0);
  assert.equal(longestCommonPrefixLength("abc", "abc"), 3);
  assert.equal(longestCommonPrefixLength("", ""), 0);
});

test("stablePrefixStats reports ratio of stable prefix to current prompt", () => {
  const stats = stablePrefixStats("FIXED PROMPT [dynamic-a]", "FIXED PROMPT [dynamic-b]");
  assert.equal(stats.commonPrefixLength, "FIXED PROMPT [dynamic-".length);
  assert.ok(stats.stableRatio > 0.5 && stats.stableRatio < 1);
  const identical = stablePrefixStats("same", "same");
  assert.equal(identical.stableRatio, 1);
  const unrelated = stablePrefixStats("aaaa", "bbbb");
  assert.equal(unrelated.commonPrefixLength, 0);
  assert.equal(unrelated.stableRatio, 0);
  const first = stablePrefixStats(null, "first-ever");
  assert.equal(first.commonPrefixLength, 0);
  assert.equal(first.stableRatio, 0);
});

test("prefix tracker keeps window and reports min/avg stability", () => {
  const tracker = createPrefixTracker({ windowSize: 3 });
  const a = tracker.snapshot("FIXED [task-1]");
  const b = tracker.snapshot("FIXED [task-2]");
  const c = tracker.snapshot("FIXED [task-3]");
  assert.equal(a.window, 1);
  assert.equal(b.window, 2);
  assert.equal(c.window, 3);
  assert.equal(tracker.history().length, 3);
  // window evicts oldest: 4th snapshot keeps size 3
  tracker.snapshot("COMPLETELY DIFFERENT PROMPT");
  assert.equal(tracker.history().length, 3);
  const d = tracker.snapshot("FIXED [task-4]");
  assert.equal(d.window, 3);
  assert.ok(d.minStableRatio >= 0 && d.minStableRatio <= d.avgStableRatio);
});

test("tracker treats empty prompts as zero-stability measurements, not errors", () => {
  const tracker = createPrefixTracker();
  const stats = tracker.snapshot("");
  assert.equal(stats.currLength, 0);
  assert.equal(stats.stableRatio, 0);
  assert.equal(tracker.history().length, 1);
});
