import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeMemoryCore } from "../src/memory-core.mjs";

function makeCore() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-mem-test-"));
  return new NativeMemoryCore({ rootDir });
}

// remember() is async (embedding is best-effort; null when the model is
// unavailable), so seeding must await each call.
async function seed(core, drawerCount, factCount) {
  for (let i = 0; i < drawerCount; i += 1) {
    await core.remember({ content: `drawer content ${i}`, wing: "w" + (i % 2), room: "r" + (i % 3), hall: "hall_general" });
  }
  for (let i = 0; i < factCount; i += 1) {
    core.addFact({ subject: `s${i}`, predicate: "relates", object: `o${i}` });
  }
}

test("visualize returns a full first page with honest truncation flags", async () => {
  const core = makeCore();
  await seed(core, 5, 3);
  const page = core.visualize({ limit: 500 });
  assert.equal(page.drawers.length, 5);
  assert.equal(page.facts.length, 3);
  assert.equal(page.truncated.drawers, false);
  assert.equal(page.truncated.facts, false);
  assert.deepEqual(page.page, { limit: 500, offset: 0, total_drawers: 5, total_facts: 3 });
  // rooms summarize the whole store
  assert.equal(Object.keys(page.rooms).length, 2);
});

test("visualize paginates drawers and facts with offset", async () => {
  const core = makeCore();
  await seed(core, 12, 7);
  const first = core.visualize({ limit: 5 });
  assert.equal(first.drawers.length, 5);
  assert.equal(first.facts.length, 5);
  assert.equal(first.truncated.drawers, true);
  assert.equal(first.truncated.facts, true);
  assert.equal(first.page.total_drawers, 12);
  assert.equal(first.page.total_facts, 7);

  const second = core.visualize({ limit: 5, offset: 5 });
  assert.equal(second.drawers.length, 5);
  assert.equal(second.facts.length, 2);
  assert.equal(second.truncated.drawers, true);
  assert.equal(second.truncated.facts, false);

  const last = core.visualize({ limit: 5, offset: 10 });
  assert.equal(last.drawers.length, 2);
  assert.equal(last.truncated.drawers, false);

  // pages are disjoint and ordered
  const ids = new Set([...first.drawers, ...second.drawers, ...last.drawers].map((d) => d.id));
  assert.equal(ids.size, 12);
});

test("visualize clamps limit and tolerates bad params", async () => {
  const core = makeCore();
  await seed(core, 3, 0);
  assert.equal(core.visualize({ limit: 99999 }).drawers.length, 3);
  assert.equal(core.visualize({ limit: -5, offset: -2 }).drawers.length, 3);
  assert.equal(core.visualize({}).drawers.length, 3);
  assert.equal(core.visualize().drawers.length, 3);
});
