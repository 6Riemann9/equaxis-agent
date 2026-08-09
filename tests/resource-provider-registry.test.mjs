import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultResourceProviderRegistry, ResourceProviderRegistry } from "../src/resource-provider-registry.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-resource-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("resolves registered agent resources with evidence and audit trace", async () => {
  const events = [];
  const registry = new ResourceProviderRegistry({ trace: (event, data) => events.push({ event, data }) });
  registry.register("agent", {
    read: async (resource) => ({ text: `agent:${resource.segments.join("/")}`, metadata: { source: "unit" } })
  }, { authorities: ["equaxis"] });

  const result = await registry.read("agent://equaxis/session/current");
  assert.equal(result.text, "agent:session/current");
  assert.equal(result.metadata.source, "unit");
  assert.equal(result.evidence[0].uri, "agent://equaxis/session/current");
  assert.equal(events.at(-1).event, "resource_read");
});

test("denies unknown schemes and unapproved authorities", async () => {
  const registry = new ResourceProviderRegistry();
  registry.register("history", { read: async () => ({ text: "history" }) }, { authorities: ["local"] });

  await assert.rejects(() => registry.read("memory://equaxis/general/item"), /no provider registered/);
  await assert.rejects(() => registry.read("history://remote/session-1"), /authority not allowed/);
});

test("reads artifact resources without allowing workspace escape", async (t) => {
  const root = workspace(t);
  const artifactRoot = path.join(root, ".pi", "runtime", "artifacts");
  fs.mkdirSync(path.join(artifactRoot, "reports"), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, "reports", "summary.txt"), "artifact summary", "utf8");

  const registry = createDefaultResourceProviderRegistry({ projectRoot: root, artifactRoot: ".pi/runtime/artifacts" });
  const result = await registry.read("artifact://reports/summary.txt");
  assert.equal(result.text, "artifact summary");
  assert.equal(result.metadata.bytes, 16);

  await assert.rejects(() => registry.read("artifact://../outside.txt"), /must stay inside artifact root/);
});

test("resolves named runtime artifacts", async (t) => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, ".pi", "runtime", "protocols"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "runtime", "protocols", "traces.jsonl"), "protocol trace\n", "utf8");
  fs.mkdirSync(path.join(root, ".pi", "runtime"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "runtime", "release-manifest.json"), "{\"ok\":true}\n", "utf8");

  const registry = createDefaultResourceProviderRegistry({ projectRoot: root });
  assert.equal((await registry.read("artifact://protocols/traces")).text, "protocol trace\n");
  assert.equal((await registry.read("artifact://release/manifest")).metadata.path, ".pi/runtime/release-manifest.json");
});

test("default registry resolves in-memory agent and history providers", async () => {
  const registry = createDefaultResourceProviderRegistry({
    agentResources: { "agent://equaxis/status": { text: "ready" } },
    historyResources: { "history://local/run-1": "completed" }
  });
  assert.equal((await registry.read("agent://equaxis/status")).text, "ready");
  assert.equal((await registry.read("history://local/run-1")).text, "completed");
});
