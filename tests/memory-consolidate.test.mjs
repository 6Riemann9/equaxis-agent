import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMemoryExtractionPrompt,
  consolidateMemoryHistory,
  cosineSimilarity,
  parseMemoryExtractionResponse,
  segmentEntriesBySimilarity
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
    metadata: { source: "dream", segments: 1 }
  });
  const addFact = calls.find(([action]) => action === "add_fact");
  assert.deepEqual(addFact[1], { subject: "equaxis", predicate: "uses", object: "pi-web", metadata: { source: "dream", segments: 1 } });
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

test("cosineSimilarity computes known values", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosineSimilarity([1, 1], [2, 2]) - 1) < 1e-9);
  assert.equal(cosineSimilarity([], [1]), 0);
  assert.equal(cosineSimilarity([1, 0], [0, 0]), 0);
});

test("segmentEntriesBySimilarity splits on topic switch (low similarity)", () => {
  const entries = [
    { cursor: 1, content: "discussing dark mode preference" },
    { cursor: 2, content: "configuring the editor theme colors" },
    { cursor: 3, content: "deploying the database migration plan" }
  ];
  const vectors = [
    [1, 0, 0],   // theme cluster
    [0.9, 0.1, 0],  // still theme
    [0, 0, 1]    // database topic switch
  ];
  const segments = segmentEntriesBySimilarity(entries, { vectors, threshold: 0.5, maxSegmentChars: 100000 });
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].map((e) => e.cursor), [1, 2]);
  assert.deepEqual(segments[1].map((e) => e.cursor), [3]);
});

test("segmentEntriesBySimilarity honors hard size cap regardless of similarity", () => {
  const entries = Array.from({ length: 4 }, (_, i) => ({ cursor: i + 1, content: "x".repeat(100) }));
  const vectors = Array.from({ length: 4 }, () => [1, 0]);
  const segments = segmentEntriesBySimilarity(entries, { vectors, threshold: 0.1, maxSegmentChars: 250 });
  assert.equal(segments.length, 2, "200 chars each exceeds 250 cap when combined");
  assert.equal(segments[0].length, 2);
  assert.equal(segments[1].length, 2);
});

test("segmentEntriesBySimilarity keeps one segment without vectors", () => {
  const entries = [
    { cursor: 1, content: "a" },
    { cursor: 2, content: "b" }
  ];
  const segments = segmentEntriesBySimilarity(entries, { threshold: 0.9, maxSegmentChars: 100000 });
  assert.equal(segments.length, 1);
});

test("consolidateMemoryHistory extracts per segment and never truncates history", async () => {
  const calls = [];
  const bridge = {
    request: async (action, payload) => {
      calls.push([action, payload]);
      if (action === "embed") {
        // two entries: similar; third entry: topic switch
        return { vectors: [[1, 0], [0.95, 0.05], [0, 1]] };
      }
      if (action === "remember") return { record: { drawer_id: `drawer-${calls.length}` } };
      if (action === "add_fact") return { triple: { triple_id: "fact-1" } };
      if (action === "set_dream_cursor") return { ok: true };
      throw new Error(`unexpected action ${action}`);
    }
  };
  const prompts = [];
  const complete = async (prompt) => {
    prompts.push(prompt);
    return '{"memories":[{"content":"remembered from segment"}],"facts":[]}';
  };

  const result = await consolidateMemoryHistory({
    bridge,
    complete,
    entries: [
      { cursor: 1, content: "designing the UI layout" },
      { cursor: 2, content: "choosing component spacing" },
      { cursor: 3, content: "migrating the auth service" }
    ],
    segmentation: { enabled: true, threshold: 0.5, maxSegmentChars: 100000 }
  });

  assert.equal(result.processed, 3);
  assert.equal(prompts.length, 2, "one extraction per segment, not per entry");
  assert.ok(prompts.every((p) => p.includes("remembered from segment") === false));
  assert.ok(prompts[0].includes("designing the UI layout"));
  assert.ok(prompts[1].includes("migrating the auth service"));
  const embed = calls.find(([action]) => action === "embed");
  assert.ok(embed, "segmentation calls the embed bridge action");
  assert.equal(embed[1].texts.length, 3);
  const remember = calls.filter(([action]) => action === "remember");
  assert.equal(remember.length, 2, "two memories from two segments");
  assert.deepEqual(remember[0][1].metadata, { source: "dream", segments: 2 });
});

test("consolidateMemoryHistory degrades to size-only segments when embed fails", async () => {
  let completeCalls = 0;
  const bridge = {
    request: async (action) => {
      if (action === "embed") throw new Error("embed unavailable");
      if (action === "remember") return { record: { drawer_id: "d1" } };
      if (action === "set_dream_cursor") return { ok: true };
      if (action === "add_fact") return { triple: { triple_id: "f1" } };
      throw new Error(`unexpected ${action}`);
    }
  };
  const result = await consolidateMemoryHistory({
    bridge,
    complete: async () => { completeCalls += 1; return '{"memories":[{"content":"m1"}],"facts":[]}'; },
    entries: [
      { cursor: 1, content: "a" },
      { cursor: 2, content: "b" }
    ],
    segmentation: { enabled: true, threshold: 0.5, maxSegmentChars: 100000 }
  });
  assert.equal(result.processed, 2);
  assert.equal(completeCalls, 1, "fallback to a single segment, no information loss");
});
