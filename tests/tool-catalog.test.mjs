import test from "node:test";
import assert from "node:assert/strict";
import { createToolCatalog, defaultToolCatalog } from "../src/tool-catalog.mjs";

test("retrieves a small ranked candidate set instead of exposing the whole catalog", () => {
  const results = defaultToolCatalog.search("search durable memory", { limit: 2 });
  assert.ok(results.length >= 1);
  assert.equal(results[0].name, "memory_search");
  assert.ok(results[0].score > results[1].score);
});

test("namespace filtering removes unrelated candidates", () => {
  const results = defaultToolCatalog.search("search", { namespace: "memory", limit: 10 });
  assert.ok(results.length > 0);
  assert.ok(results.every((result) => result.namespace === "memory"));
});

test("empty query returns deterministic top candidates", () => {
  const catalog = createToolCatalog([
    { name: "z_tool", namespace: "z", summary: "z", keywords: [] },
    { name: "a_tool", namespace: "a", summary: "a", keywords: [] }
  ]);
  assert.deepEqual(catalog.search("", { limit: 2 }).map((item) => item.name), ["a_tool", "z_tool"]);
});

test("finds protocol advisor and reflection product tools", () => {
  assert.equal(defaultToolCatalog.search("debug breakpoint stack", { limit: 1 })[0].name, "dap_probe");
  assert.equal(defaultToolCatalog.search("advisor risk recommendation", { limit: 1 })[0].name, "advisor_consult");
  assert.equal(defaultToolCatalog.search("reflect lesson postmortem", { limit: 1 })[0].name, "reflect");
});
