import crypto from "node:crypto";

const hash64 = (value) => BigInt(`0x${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16)}`);

/** Rendezvous hashing keeps most users on the same shard when capacity changes. */
export function routeUserShard(tenantId, userId, shards) {
  if (!shards.length) throw new Error("at least one shard is required");
  const key = `${tenantId}:${userId}`;
  return [...shards]
    .map((shard) => ({ shard, score: hash64(`${key}:${shard.id}`) * BigInt(Math.max(1, shard.weight ?? 1)) }))
    .sort((left, right) => left.score > right.score ? -1 : left.score < right.score ? 1 : String(left.shard.id).localeCompare(String(right.shard.id)))[0].shard;
}

export function memoryTier(memory, now = Date.now()) {
  const ageDays = Math.max(0, now - new Date(memory.createdAt).getTime()) / 86_400_000;
  if (memory.pinned || memory.kind === "profile" || ageDays <= 7) return "hot";
  if (ageDays <= 90 || Number(memory.importance ?? 0) >= 0.7) return "warm";
  return "cold";
}

export function memoryId(tenantId, userId, sourceId, contentHash) {
  return crypto.createHash("sha256").update(`${tenantId}:${userId}:${sourceId}:${contentHash}`).digest("hex");
}

