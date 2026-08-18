import assert from "node:assert/strict";
import test from "node:test";
import { createDeferredResultDelivery } from "../src/deferred-result-delivery.mjs";

test("a result consumed by a later wait is not delivered", () => {
  const delivery = createDeferredResultDelivery();
  delivery.defer({ id: "sa-1", output: "done" });
  delivery.consume(["sa-1"]);
  assert.deepEqual(delivery.drain(), []);
});

test("unconsumed results are delivered once in insertion order", () => {
  const delivery = createDeferredResultDelivery();
  const first = { id: "sa-1" };
  const second = { id: "sa-2" };
  delivery.defer(first);
  delivery.defer(second);
  assert.deepEqual(delivery.drain(), [first, second]);
  // drain clears the buffer
  assert.deepEqual(delivery.drain(), []);
});

test("clear drops all pending results", () => {
  const delivery = createDeferredResultDelivery();
  delivery.defer({ id: "sa-1" });
  delivery.defer({ id: "sa-2" });
  delivery.clear();
  assert.deepEqual(delivery.drain(), []);
});

test("defer replaces prior entry for same id", () => {
  const delivery = createDeferredResultDelivery();
  delivery.defer({ id: "sa-1", version: 1 });
  delivery.defer({ id: "sa-1", version: 2 });
  const results = delivery.drain();
  assert.equal(results.length, 1);
  assert.equal(results[0].version, 2);
});

test("consume is a no-op for unknown ids", () => {
  const delivery = createDeferredResultDelivery();
  delivery.defer({ id: "sa-1" });
  delivery.consume(["sa-unknown"]);
  assert.equal(delivery.drain().length, 1);
});
