import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMemoryExtractionPrompt,
  consolidateMemoryHistory,
  parseMemoryExtractionResponse
} from "../src/memory-consolidate.mjs";

test("buildMemoryExtractionPrompt embeds history entries", () => {
  const prompt = buildMemoryExtractionPrompt([
    { cursor: 1, content: "user prefers dark mode", timestamp: "2026-08-13T10:00:00+00:00" },
    { cursor: 2, content: "decided to use deepseek", timestamp: "2026-08-13T10:01:00+00:00" }
  ]);
  assert.match(prompt, /user prefers dark mode/);
  assert.match(prompt, /2026-08-13T10:00:00/);
  assert.match(prompt, /STRICT JSON/);
});

test("parseMemoryExtractionResponse accepts fences and prefixes", () => {
  const parsed = parseMemoryExtractionResponse(
    'Sure! Here you go:\n```json\n{"memories":[{"content":"likes dark mode","wing":"equaxis","room":"ui","hall":"hall_preferences"}],"facts":[{"subject":"equaxis","predicate":"uses","object":"pi-web"}]}\n```'
  );
  assert.deepEqual(parsed.memories, [{ content: "likes dark mode", wing: "equaxis", room: "ui", hall: "hall_preferences" }]);
  assert.deepEqual(parsed.facts, [{ subject: "equaxis", predicate: "uses", object: "pi-web" }]);
});

test("parseMemoryExtractionResponse rejects invalid payloads", () => {
  assert.throws(() => parseMemoryExtractionResponse("not json at all"), /valid memory-extraction JSON/);
  assert.throws(() => parseMemoryExtractionResponse('{"memories":[]}'), /valid memory-extraction JSON/);
  assert.throws(() => parseMemoryExtractionResponse('{"memories":[{"content":""}],"facts":[]}'), /valid memory-extraction JSON/);
});

test("parseMemoryExtractionResponse trims and skips malformed items", () => {
  const parsed = parseMemoryExtractionResponse(
    '{"memories":[{"content":"  keep me  "},{"content":""},{"content":42}],"facts":[{"subject":"a","predicate":"b","object":"c"},{"subject":""}]}'
  );
  assert.deepEqual(parsed.memories, [{ content: "keep me", wing: undefined, room: undefined, hall: undefined }]);
  assert.deepEqual(parsed.facts, [{ subject: "a", predicate: "b", object: "c" }]);
});

test("consolidateMemoryHistory stores memories and facts then advances cursor", async () => {
  const calls = [];
  const bridge = {
    request: async (action, payload) => {
      calls.push([action, payload]);
      if (action === "remember") return { record: { drawer_id: `drawer-${payload.content.length}` } };
      if (action === "add_fact") return { triple: { triple_id: `fact-${payload.subject}` } };
      if (action === "set_dream_cursor") return { ok: true };
      throw new Error(`unexpected action ${action}`);
    }
  };
  const complete = async () =>
    '{"memories":[{"content":"prefers dark mode","hall":"hall_preferences"}],"facts":[{"subject":"equaxis","predicate":"uses","object":"pi-web"}]}';

  const result = await consolidateMemoryHistory({
    bridge,
    complete,
    entries: [
      { cursor: 5, content: "a", timestamp: "2026-08-13T10:00:00+00:00" },
      { cursor: 6, content: "b", timestamp: "2026-08-13T10:01:00+00:00" }
    ],
    defaults: { wing: "equaxis", room: "general" }
  });

  assert.equal(result.processed, 2);
  assert.equal(result.memories.length, 1);
  assert.equal(result.facts.length, 1);

  const remember = calls.find(([action]) => action === "remember");
  assert.deepEqual(remember[1], {
    content: "prefers dark mode",
    wing: "equaxis",
    room: "general",
    hall: "hall_preferences",
    source_file: "equaxis-dream",
    metadata: { source: "dream" }
  });
  const addFact = calls.find(([action]) => action === "add_fact");
  assert.deepEqual(addFact[1], { subject: "equaxis", predicate: "uses", object: "pi-web", metadata: { source: "dream" } });
  const setCursor = calls.find(([action]) => action === "set_dream_cursor");
  assert.deepEqual(setCursor[1], { cursor: 6 });
});

test("consolidateMemoryHistory skips empty history without calling the model", async () => {
  let called = false;
  const result = await consolidateMemoryHistory({
    bridge: { request: async () => { throw new Error("must not be called"); } },
    complete: async () => { called = true; return "{}"; },
    entries: []
  });
  assert.equal(result.processed, 0);
  assert.equal(called, false);
});

test("consolidateMemoryHistory does not advance cursor when storage fails", async () => {
  const calls = [];
  const bridge = {
    request: async (action, _payload) => {
      calls.push(action);
      if (action === "remember") throw new Error("storage boom");
      return {};
    }
  };
  await assert.rejects(
    consolidateMemoryHistory({
      bridge,
      complete: async () => '{"memories":[{"content":"x"}]}',
      entries: [{ cursor: 3, content: "x" }]
    }),
    /storage boom/
  );
  assert.deepEqual(calls, ["remember"]);
  assert.ok(!calls.includes("set_dream_cursor"));
});
