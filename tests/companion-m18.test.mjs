import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  MAX_DELEGATION_DEPTH,
  buildHandoff,
  buildIntegrationRequest,
  delegationDepth,
  formatHandoff,
  routeTeammate,
  tokenizeForRouting
} from "../src/companion-team.mjs";
import { CompanionStore } from "../src/companion-store.mjs";
import { buildTeammatePrompt, parseDirectives, runCompanionWorker } from "../src/companion-runtime.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-m18-"));
}

function team() {
  const store = CompanionStore.open(tmpRoot());
  store.createTeammate({ name: "researcher", persona: "a meticulous researcher who cites sources and surveys documentation" });
  store.createTeammate({ name: "builder", persona: "ships small working increments and writes implementation code" });
  return store;
}

// ---- routing: who, not just what ----

test("m18 routing: the best-matched teammate wins, and the reason is explainable", () => {
  const store = team();
  const route = routeTeammate("survey the documentation for the config loader", store.listTeammates());
  assert.ok(route, "a route is found");
  assert.equal(route.teammate.name, "researcher");
  assert.match(route.reason, /matched/);

  const impl = routeTeammate("write the implementation code for the new loader", store.listTeammates());
  assert.equal(impl.teammate.name, "builder");
});

test("m18 routing: the delegator never routes to itself", () => {
  const store = team();
  // Excluding the only lexical match leaves one candidate, which the
  // sole-candidate fallback takes — the invariant is that it is never itself.
  const route = routeTeammate("survey the documentation", store.listTeammates(), { exclude: "researcher" });
  assert.ok(route);
  assert.notEqual(route.teammate.name, "researcher");

  // With more than one candidate left and no lexical match, it refuses.
  store.createTeammate({ name: "auditor", persona: "checks compliance paperwork" });
  assert.equal(routeTeammate("xyzzy plugh", store.listTeammates(), { exclude: "researcher" }), null);
});

test("m18 routing: an unmatched instruction returns null instead of a random teammate", () => {
  const store = team();
  assert.equal(routeTeammate("xyzzy plugh", store.listTeammates()), null);
  assert.equal(routeTeammate("", store.listTeammates()), null);
  assert.equal(routeTeammate("the a an", store.listTeammates()), null, "stop words alone carry no signal");
});

test("m18 routing: tokenizer drops stop words and keeps both scripts", () => {
  assert.deepEqual(tokenizeForRouting("please check the deployment pipeline"), ["deployment", "pipeline"]);
  assert.ok(tokenizeForRouting("部署 流水线").length >= 1, "CJK tokens survive");
});

// ---- lossless handoff ----

test("m18 handoff: the delegatee receives the ask, the findings and the files", () => {
  const store = team();
  const source = store.enqueue("researcher", "survey how config loads");
  const handoff = buildHandoff({
    from: store.getTeammate("researcher"),
    task: source,
    result: "config loads in three layers",
    artifacts: { added: [{ path: "notes.md" }], modified: [{ path: "README.md" }], deleted: [] }
  });
  assert.equal(handoff.from, "researcher");
  assert.equal(handoff.depth, 1);

  const rendered = formatHandoff(handoff).join("\n");
  assert.match(rendered, /HANDOFF from @researcher/);
  assert.match(rendered, /survey how config loads/, "the original ask travels with it");
  assert.match(rendered, /config loads in three layers/, "the findings travel with it");
  assert.match(rendered, /\+ notes\.md/, "produced files travel with it");
  assert.match(rendered, /delivered back to @researcher/, "the closed loop is announced");
  assert.deepEqual(formatHandoff(null), [], "no handoff renders nothing");
});

test("m18 handoff: a delegated task carries its handoff into the prompt", () => {
  const store = team();
  const task = store.enqueue("builder", "implement the loader", {
    handoff: { from: "researcher", fromTaskId: "abc", instruction: "survey config", summary: "three layers", artifacts: null, depth: 1, at: new Date().toISOString() }
  });
  const prompt = buildTeammatePrompt(store.getTeammate("builder"), task, { workspacePath: "/w" });
  assert.match(prompt, /HANDOFF from @researcher/);
  assert.match(prompt, /three layers/);

  // and it survives a reload (sanitizeTask rebuilds records field by field)
  const reloaded = CompanionStore.open(store.rootDir).getTask(task.id);
  assert.equal(reloaded.handoff.from, "researcher", "handoff must persist");
});

test("m18 protocol: a delegation may be routed instead of named", () => {
  const named = parseDirectives("DELEGATE @builder: do the thing");
  assert.deepEqual(named.delegations, [{ to: "builder", instruction: "do the thing", routed: false }]);

  const routed = parseDirectives("DELEGATE: whoever can survey this documentation");
  assert.equal(routed.delegations.length, 1);
  assert.equal(routed.delegations[0].to, null);
  assert.equal(routed.delegations[0].routed, true);

  const prompt = buildTeammatePrompt(storeForPrompt(), { id: "t1", instruction: "x" }, {});
  assert.match(prompt, /DELEGATE: instruction\s+— hand it to whoever is best matched/);
  assert.match(prompt, /delivered back to you automatically/);
});

function storeForPrompt() {
  const store = team();
  return store.getTeammate("builder");
}

// ---- the closed loop ----

test("m18 loop: a finished delegation reports back and gives the delegator a turn", async () => {
  const store = team();
  const delegated = store.enqueue("builder", "implement the loader", {
    runSource: "delegated:researcher",
    handoff: { from: "researcher", fromTaskId: "t0", instruction: "survey", summary: "", artifacts: null, depth: 1, at: new Date().toISOString() }
  });

  const summary = await runCompanionWorker({
    store,
    concurrency: 1,
    maxTasks: 1,
    routines: false,
    executor: async () => "implemented it\nRESULT: loader done"
  });
  // maxTasks stops the worker after the delegated task; the report is queued.
  assert.equal(summary.reported, 1, "the result was reported back");

  const inbox = store.unreadMessages("researcher");
  assert.equal(inbox.length, 1, "the delegator got a note");
  assert.match(inbox[0].text, /Finished your task/);
  assert.match(inbox[0].text, /loader done/);

  const integration = store.listTasks({}).find((task) => String(task.runSource).startsWith("report:builder"));
  assert.ok(integration, "an integration turn was queued for the delegator");
  assert.match(integration.instruction, /loader done/);
  assert.match(integration.instruction, /what remains/);
});

test("m18 loop: a failure is reported too, not swallowed", async () => {
  const store = team();
  store.enqueue("builder", "break it", {
    runSource: "delegated:researcher",
    handoff: { from: "researcher", fromTaskId: "t0", instruction: "survey", summary: "", artifacts: null, depth: 1, at: new Date().toISOString() }
  });
  await runCompanionWorker({
    store,
    concurrency: 1,
    maxTasks: 1,
    routines: false,
    executor: async () => { throw new Error("the build exploded"); }
  });
  const inbox = store.unreadMessages("researcher");
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].text, /the build exploded/);
});

test("m18 loop: depth is capped so two teammates cannot ping-pong forever", () => {
  const deep = { depth: MAX_DELEGATION_DEPTH + 1 };
  const request = buildIntegrationRequest({ delegateTask: { id: "x" }, delegateTeammate: { name: "b" }, result: "r", depth: deep.depth });
  assert.equal(request.refused, true);
  assert.match(request.reason, /exceeds the cap/);

  const ok = buildIntegrationRequest({ delegateTask: { id: "x" }, delegateTeammate: { name: "b" }, result: "r", depth: 1 });
  assert.equal(ok.refused, false);
  assert.equal(ok.runSource, "report:b");
});

test("m18 loop: a human-initiated task reports nothing back", async () => {
  const store = team();
  store.enqueue("builder", "just do it");
  const summary = await runCompanionWorker({ store, concurrency: 1, maxTasks: 1, routines: false, executor: async () => "done" });
  assert.equal(summary.reported, 0, "no handoff means no report");
  assert.equal(store.unreadMessages("researcher").length, 0);
});

test("m18 loop: depth accumulates across hops", () => {
  const store = team();
  const first = store.enqueue("researcher", "start", { handoff: { from: "human", depth: 1, at: new Date().toISOString() } });
  assert.equal(delegationDepth(first), 1);
  const next = buildHandoff({ from: { name: "researcher" }, task: first, result: "", depth: delegationDepth(first) });
  assert.equal(next.depth, 2, "each hop increments the depth the cap is measured against");
  assert.equal(delegationDepth({}), 0);
});

// ---- cross-language routing and the roster ----

test("m18 routing: Chinese instructions are tokenized as bigrams, not one blob", () => {
  const tokens = tokenizeForRouting("编写一个把两个数字相加的实现代码并写出测试");
  assert.ok(tokens.length > 5, `expected bigrams, got ${JSON.stringify(tokens)}`);
  assert.ok(tokens.includes("编写"));
  assert.ok(tokens.includes("代码"));
  // A Chinese persona can therefore match a Chinese instruction.
  const store = CompanionStore.open(tmpRoot());
  store.createTeammate({ name: "coder", persona: "负责编写实现代码与测试" });
  store.createTeammate({ name: "writer", persona: "负责撰写文档与说明" });
  const route = routeTeammate("编写实现代码并写出测试", store.listTeammates());
  assert.equal(route.teammate.name, "coder");
});

test("m18 routing: a single candidate is taken when nothing matches lexically", () => {
  const store = CompanionStore.open(tmpRoot());
  store.createTeammate({ name: "solo", persona: "does everything alone" });
  const route = routeTeammate("xyzzy plugh", store.listTeammates());
  assert.equal(route.teammate.name, "solo");
  assert.match(route.reason, /only available teammate/);

  // With two candidates and no match it still refuses rather than guessing.
  store.createTeammate({ name: "second", persona: "also unrelated" });
  assert.equal(routeTeammate("xyzzy plugh", store.listTeammates()), null);
});

test("m18 roster: every teammate sees who else exists, so it can name one", () => {
  const store = team();
  const prompt = buildTeammatePrompt(store.getTeammate("researcher"), { id: "t", instruction: "do it" }, { roster: store.listTeammates() });
  assert.match(prompt, /Your team/);
  assert.match(prompt, /@builder — ships small working increments/);
  assert.doesNotMatch(prompt, /@researcher — a meticulous researcher/, "a teammate does not need to be told about itself");
});

test("m18 loop: an unmatched auto-routing request bounces back to the delegator, not into the void", async () => {
  const store = team();
  // A third teammate so the sole-candidate fallback cannot apply: this has to
  // be a genuine miss for the bounce-back path to be exercised.
  store.createTeammate({ name: "auditor", persona: "checks compliance paperwork" });
  store.enqueue("researcher", "ask the worker to route this");
  const summary = await runCompanionWorker({
    store,
    concurrency: 1,
    maxTasks: 1,
    routines: false,
    // The reply delegates without a name, and nothing matches lexically.
    executor: async () => "surveyed\nRESULT: nothing yet\nDELEGATE: xyzzy plugh"
  });
  assert.equal(summary.routingMissed, 1);
  assert.equal(summary.routingDeferred, 1, "the decision went back to the delegator");
  const retry = store.listTasks({}).find((task) => task.runSource === "routing:retry");
  assert.ok(retry, "a retry turn was queued");
  assert.match(retry.instruction, /name the teammate explicitly/);
  assert.match(retry.instruction, /DELEGATE @name: xyzzy plugh/);
});
