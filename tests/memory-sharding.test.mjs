import test from "node:test";
import assert from "node:assert/strict";
import { memoryId, memoryTier, routeUserShard } from "../src/memory-sharding.mjs";

test("routes a user deterministically with rendezvous hashing", () => {
  const shards = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(routeUserShard("tenant", "user-1", shards), routeUserShard("tenant", "user-1", shards));
});

test("routes memory to hot, warm and cold tiers", () => {
  const now = Date.parse("2026-07-23T00:00:00Z");
  assert.equal(memoryTier({ createdAt: "2026-07-22T00:00:00Z" }, now), "hot");
  assert.equal(memoryTier({ createdAt: "2026-06-01T00:00:00Z" }, now), "warm");
  assert.equal(memoryTier({ createdAt: "2025-01-01T00:00:00Z" }, now), "cold");
  assert.equal(memoryTier({ createdAt: "2025-01-01T00:00:00Z", pinned: true }, now), "hot");
});

test("builds stable idempotent memory ids", () => {
  assert.equal(memoryId("t", "u", "s", "h"), memoryId("t", "u", "s", "h"));
  assert.notEqual(memoryId("t", "u1", "s", "h"), memoryId("t", "u2", "s", "h"));
});

