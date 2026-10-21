import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CompanionStore } from "../src/companion-store.mjs";
import {
  TEMPLATE_KEY,
  TEMPLATE_VERSION,
  applyTemplate,
  buildTemplate,
  formatTemplateReport,
  normalizeTemplateTeammate,
  parseTemplate
} from "../src/companion-templates.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-m9-"));
}

function seedStore() {
  const store = CompanionStore.open(tmpRoot());
  store.createTeammate({ name: "researcher", persona: "cites sources", model: "sonnet" });
  store.createTeammate({ name: "builder", persona: "ships small increments" });
  return store;
}

// ---- export ----

test("m9 templates: export carries the working profile and nothing else", () => {
  const store = seedStore();
  // Give the store some history that must NOT leak into a template.
  const task = store.enqueue("researcher", "old chore");
  store.complete(task.id, "done");
  store.appendFeed({ at: new Date().toISOString(), kind: "done", teammate: "researcher", text: "x" });
  store.issueTeammateCredential("researcher");

  const template = buildTemplate(store.listTeammates());
  assert.equal(template[TEMPLATE_KEY], TEMPLATE_VERSION);
  assert.equal(template.teammates.length, 2);

  const researcher = template.teammates.find((entry) => entry.name === "researcher");
  assert.deepEqual(Object.keys(researcher).sort(), ["model", "name", "persona", "workspace"]);
  assert.equal(researcher.persona, "cites sources");
  assert.equal(researcher.model, "sonnet");

  const serialized = JSON.stringify(template);
  for (const forbidden of ["digest", "eqc1_", "lastUsedAt", "stats", "taskId", "finishedAt", "webhook"]) {
    assert.equal(serialized.includes(forbidden), false, `template must not leak ${forbidden}`);
  }
});

test("m9 templates: export can select named teammates and refuses empty selections", () => {
  const store = seedStore();
  const only = buildTemplate(store.listTeammates(), { names: ["builder"] });
  assert.deepEqual(only.teammates.map((entry) => entry.name), ["builder"]);

  assert.throws(() => buildTemplate(store.listTeammates(), { names: ["ghost"] }), /no teammate matches ghost/);
  assert.throws(() => buildTemplate([]), /no teammates to export/);
});

test("m9 templates: a model-less teammate exports without the model key", () => {
  const store = seedStore();
  const template = buildTemplate(store.listTeammates(), { names: ["builder"] });
  assert.equal("model" in template.teammates[0], false);
});

// ---- parse ----

test("m9 templates: parse accepts the documented shape and a bare array", () => {
  const documented = parseTemplate(JSON.stringify({
    [TEMPLATE_KEY]: 1,
    teammates: [{ name: "scout", persona: "p", workspace: "w", model: "m" }]
  }));
  assert.equal(documented.version, 1);
  assert.deepEqual(documented.teammates[0], { name: "scout", persona: "p", workspace: "w", model: "m" });

  const bare = parseTemplate([{ name: "scout" }]);
  assert.equal(bare.teammates[0].name, "scout");
  assert.equal(bare.teammates[0].persona, "", "missing persona defaults to empty");
  assert.equal(bare.teammates[0].workspace, "scout", "missing workspace defaults to the name");
});

test("m9 templates: parse refuses the mistakes that would silently misfire", () => {
  // Unknown version.
  assert.throws(() => parseTemplate({ [TEMPLATE_KEY]: 99, teammates: [{ name: "a" }] }), /version 99 is not supported/);
  // Unknown field: a typo must not be dropped silently.
  assert.throws(() => parseTemplate([{ name: "a", presona: "typo" }]), /unknown field\(s\): presona/);
  // Bad name.
  assert.throws(() => parseTemplate([{ name: "Bad Name" }]), /must be kebab-case/);
  assert.throws(() => parseTemplate([{ name: "" }]), /"name" must not be empty/);
  assert.throws(() => parseTemplate([{ persona: "no name" }]), /"name" is required/);
  // Shape problems.
  assert.throws(() => parseTemplate("not json"), /not valid JSON/);
  assert.throws(() => parseTemplate({ teammates: [] }), /non-empty "teammates" array/);
  assert.throws(() => parseTemplate([]), /the array is empty/);
  assert.throws(() => parseTemplate([null]), /must be an object/);
  // Field length guard.
  assert.throws(() => normalizeTemplateTeammate({ name: "a", persona: "x".repeat(4001) }), /longer than 4000/);
});

// ---- apply ----

test("m9 templates: import creates teammates, skips existing ones, and can overwrite", () => {
  const store = seedStore();
  const template = parseTemplate([
    { name: "researcher", persona: "CHANGED", model: "opus" },
    { name: "auditor", persona: "checks compliance" }
  ]);

  const skipped = applyTemplate(store, template);
  assert.deepEqual(skipped.created, ["auditor"]);
  assert.deepEqual(skipped.skipped, ["researcher"]);
  assert.equal(store.getTeammate("researcher").persona, "cites sources", "existing profile untouched by default");
  assert.equal(store.getTeammate("auditor").persona, "checks compliance");

  const forced = parseTemplate([{ name: "researcher", persona: "CHANGED", model: "opus" }]);
  const updated = applyTemplate(store, forced, { overwrite: true });
  assert.deepEqual(updated.updated, ["researcher"]);
  assert.equal(store.getTeammate("researcher").persona, "CHANGED");
  assert.equal(store.getTeammate("researcher").model, "opus");
});

test("m9 templates: --rename stamps a copy under a new name with its own workspace", () => {
  const store = seedStore();
  const template = parseTemplate([{ name: "researcher", persona: "cites sources", workspace: "shared", model: "sonnet" }]);
  const report = applyTemplate(store, template, { rename: "researcher-2" });
  assert.deepEqual(report.created, ["researcher-2"]);

  const copy = store.getTeammate("researcher-2");
  assert.equal(copy.persona, "cites sources");
  assert.equal(copy.model, "sonnet");
  assert.equal(copy.workspace, "researcher-2", "a renamed copy gets its own workspace instead of sharing files");

  assert.throws(
    () => applyTemplate(store, parseTemplate([{ name: "a" }, { name: "b" }]), { rename: "c" }),
    /--rename can only be used with a single-teammate template/
  );
  assert.throws(() => applyTemplate(store, template, { rename: "Bad Name" }), /must be kebab-case/);
});

test("m9 templates: a dry run reports the plan and writes nothing", () => {
  const store = seedStore();
  const template = parseTemplate([{ name: "auditor" }, { name: "builder" }]);
  const report = applyTemplate(store, template, { dryRun: true });
  assert.equal(report.planned, true);
  assert.deepEqual(report.created, ["auditor"]);
  assert.deepEqual(report.skipped, ["builder"]);
  assert.equal(store.getTeammate("auditor"), null, "dry run must not create");
  assert.match(formatTemplateReport(report), /^\[dry run\]/);
});

test("m9 templates: export → import round-trips through disk", () => {
  const store = seedStore();
  const file = path.join(tmpRoot(), "team.json");
  fs.writeFileSync(file, JSON.stringify(buildTemplate(store.listTeammates()), null, 2), "utf8");

  const other = CompanionStore.open(tmpRoot());
  const report = applyTemplate(other, parseTemplate(fs.readFileSync(file, "utf8")));
  assert.deepEqual(report.created.sort(), ["builder", "researcher"]);
  assert.equal(other.getTeammate("researcher").persona, "cites sources");
  assert.equal(other.getTeammate("researcher").model, "sonnet");
});
