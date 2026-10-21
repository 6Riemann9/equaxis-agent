import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CompanionStore } from "../src/companion-store.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-m8-"));
}

function storeWithScout() {
  const store = CompanionStore.open(tmpRoot());
  store.createTeammate({ name: "scout", persona: "researcher" });
  return store;
}

const DAY = 24 * 3600 * 1000;

// ---- expiry ----

test("m8 rotation: a credential can be minted with a lifetime and expires closed", () => {
  const store = storeWithScout();
  const { credential, mint } = store.issueTeammateCredential("scout", { label: "phone", ttlMs: 30 * DAY });
  assert.ok(credential.expiresAt);
  assert.equal(Date.parse(credential.expiresAt) - Date.parse(credential.createdAt), 30 * DAY);
  assert.ok(store.resolveCredential(mint), "a fresh credential works");

  // Fast-forward the record instead of the clock: expiry must be enforced on
  // use, not merely displayed.
  const record = store.listCredentials()[0];
  record.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(store.credentialFile(), JSON.stringify([record], null, 2), "utf8");
  assert.equal(store.resolveCredential(mint), null, "an expired credential must fail closed");
});

test("m8 rotation: a credential minted without a ttl never expires", () => {
  const store = storeWithScout();
  const { credential, mint } = store.issueTeammateCredential("scout");
  assert.equal(credential.expiresAt, null);
  assert.ok(store.resolveCredential(mint));
});

test("m8 rotation: ttl must be a positive duration", () => {
  const store = storeWithScout();
  assert.throws(() => store.issueTeammateCredential("scout", { ttlMs: 0 }), /must be a positive duration/);
  assert.throws(() => store.issueTeammateCredential("scout", { ttlMs: -5 }), /must be a positive duration/);
  assert.throws(() => store.issueTeammateCredential("scout", { ttlMs: Number.NaN }), /must be a positive duration/);
});

// ---- rotation ----

test("m8 rotation: rotate revokes the old value and returns a working replacement", () => {
  const store = storeWithScout();
  const { credential: old, mint: oldMint } = store.issueTeammateCredential("scout", { label: "ci", ttlMs: 10 * DAY });

  const { credential: fresh, mint: freshMint, previous } = store.rotateCredential(old.id.slice(0, 8));

  assert.equal(previous.id, old.id);
  assert.equal(fresh.id === old.id, false, "rotation mints a new record, it does not reuse the old one");
  assert.equal(fresh.teammate, "scout");
  assert.equal(fresh.label, "ci", "label is carried over so logs stay meaningful");
  assert.equal(fresh.rotatedFromId, old.id);

  assert.equal(store.resolveCredential(oldMint), null, "the previous value stops working immediately");
  assert.equal(store.resolveCredential(freshMint).id, fresh.id, "the replacement works");
});

test("m8 rotation: the original lifetime policy is inherited", () => {
  const store = storeWithScout();
  const { credential } = store.issueTeammateCredential("scout", { ttlMs: 7 * DAY });
  const { credential: fresh } = store.rotateCredential(credential.id);
  const span = Date.parse(fresh.expiresAt) - Date.parse(fresh.createdAt);
  assert.equal(span, 7 * DAY, "rotating must not silently extend or drop the ttl");

  // An explicit ttl overrides the inherited one.
  const { credential: longer } = store.rotateCredential(fresh.id, { ttlMs: 30 * DAY });
  assert.equal(Date.parse(longer.expiresAt) - Date.parse(longer.createdAt), 30 * DAY);

  // Rotating a no-expiry credential keeps it unlimited.
  const { credential: unlimited } = store.issueTeammateCredential("scout");
  assert.equal(store.rotateCredential(unlimited.id).credential.expiresAt, null);
});

test("m8 rotation: rotating an already-revoked credential is refused, with guidance", () => {
  const store = storeWithScout();
  const { credential } = store.issueTeammateCredential("scout");
  store.revokeCredential(credential.id);
  assert.throws(() => store.rotateCredential(credential.id), /already revoked — issue a new one instead/);
});

test("m8 rotation: unknown and ambiguous prefixes are refused for both revoke and rotate", () => {
  const store = storeWithScout();
  const a = store.issueTeammateCredential("scout");
  const b = store.issueTeammateCredential("scout");
  assert.throws(() => store.rotateCredential("ffffffff"), /no credential matches/);
  assert.throws(() => store.rotateCredential(""), /ambiguous/);
  assert.ok(store.resolveCredential(a.mint));
  assert.ok(store.resolveCredential(b.mint));
});

// ---- expiry reporting ----

test("m8 rotation: expiringCredentials lists expired and soon-to-expire records only", () => {
  const store = storeWithScout();
  const soon = store.issueTeammateCredential("scout", { ttlMs: 2 * DAY });
  const later = store.issueTeammateCredential("scout", { ttlMs: 60 * DAY });
  const unlimited = store.issueTeammateCredential("scout");
  const revoked = store.issueTeammateCredential("scout", { ttlMs: DAY });
  store.revokeCredential(revoked.credential.id);

  const list = store.expiringCredentials({ withinMs: 7 * DAY });
  const ids = list.map((entry) => entry.id);
  assert.ok(ids.includes(soon.credential.id), "2d ahead is inside the 7d window");
  assert.equal(ids.includes(later.credential.id), false, "60d is outside the window");
  assert.equal(ids.includes(unlimited.credential.id), false, "no expiry is not expiring");
  assert.equal(ids.includes(revoked.credential.id), false, "revoked is already dead");
  assert.equal(list[0].expired, false);
  assert.deepEqual(ids, [soon.credential.id], "sorted by expiry");
});
