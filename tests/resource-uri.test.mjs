import test from "node:test";
import assert from "node:assert/strict";
import { createResourceUri, normalizeResourceUri, parseResourceUri } from "../src/resource-uri.mjs";

test("parses and normalizes supported resource URI schemes", () => {
  const resource = parseResourceUri("memory://equaxis/general/preference-1?score=0.9#summary");
  assert.equal(resource.ok, true);
  assert.equal(resource.scheme, "memory");
  assert.equal(resource.kind, "memory");
  assert.equal(resource.authority, "equaxis");
  assert.deepEqual(resource.segments, ["general", "preference-1"]);
  assert.deepEqual(resource.query, { score: "0.9" });
  assert.equal(resource.fragment, "summary");
  assert.equal(resource.normalized, "memory://equaxis/general/preference-1?score=0.9#summary");
});

test("creates stable URIs with encoded path segments and sorted query keys", () => {
  assert.equal(
    createResourceUri({ scheme: "tool", authority: "mcp", segments: ["eval server", "score"], query: { b: "2", a: "1" } }),
    "tool://mcp/eval%20server/score?a=1&b=2"
  );
});

test("rejects unsupported or malformed resource URIs", () => {
  assert.equal(parseResourceUri("javascript:alert(1)").ok, false);
  assert.equal(parseResourceUri("file:///tmp/a.txt").ok, true);
  assert.equal(parseResourceUri("not a uri").ok, false);
});

test("normalizes plain file paths when a workspace is supplied", () => {
  const resource = normalizeResourceUri("src/index.ts", { workspace: "/repo/app" });
  assert.equal(resource.ok, true);
  assert.equal(resource.scheme, "file");
  assert.match(resource.normalized, /\/repo\/app\/src\/index\.ts$/);
});
