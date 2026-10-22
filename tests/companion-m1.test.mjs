import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CompanionStore, MIN_ROUTINE_INTERVAL_MS } from "../src/companion-store.mjs";
import { createNotifier } from "../src/companion-notify.mjs";
import { buildTeammatePrompt, extractResult, parseDirectives, parsePiJsonReply, enqueueDueRoutines, runCompanionWorker } from "../src/companion-runtime.mjs";
import { buildBwrapArgs, createBwrapSpawnWrapper } from "../src/companion-sandbox.mjs";
import { parseDurationMs } from "../src/duration.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-m1-"));
}

function seededStore(root) {
  const store = CompanionStore.open(root);
  store.createTeammate({ name: "scout", persona: "researcher" });
  store.createTeammate({ name: "builder", persona: "ships things" });
  return store;
}

// ---- messages ----

test("m1 messages: sendMessage requires an existing teammate and persists", () => {
  const root = tmpRoot();
  const store = seededStore(root);
  assert.throws(() => store.sendMessage({ from: "human", to: "ghost", text: "hi" }), /not found/);
  store.sendMessage({ from: "human", to: "scout", text: "look at the config" });
  const reopened = CompanionStore.open(root);
  assert.equal(reopened.unreadMessages("scout").length, 1);
  assert.equal(reopened.unreadMessages("scout")[0].text, "look at the config");
  assert.equal(reopened.unreadMessages("builder").length, 0);
});

test("m1 messages: drainInbox returns unread once and marks them read", () => {
  const store = seededStore(tmpRoot());
  store.sendMessage({ from: "human", to: "scout", text: "one" });
  store.sendMessage({ from: "builder", to: "scout", text: "two" });
  const drained = store.drainInbox("scout");
  assert.deepEqual(drained.map((m) => m.text), ["one", "two"]);
  assert.deepEqual(drained.map((m) => m.from), ["human", "builder"]);
  assert.equal(store.drainInbox("scout").length, 0);
});

test("m1 messages: inbox is rendered into the teammate prompt", () => {
  const prompt = buildTeammatePrompt(
    { name: "scout", persona: "", model: null },
    { id: "t1", instruction: "do things" },
    { workspacePath: "/w", inbox: [{ from: "human", text: "check the logs" }] }
  );
  assert.match(prompt, /Unread messages for you/);
  assert.match(prompt, /- from human: check the logs/);
});

// ---- directives ----

test("m1 directives: parseDirectives extracts DELEGATE and MESSAGE lines", () => {
  const reply = [
    "I looked into it.",
    "DELEGATE @builder: write the config loader test",
    "MESSAGE @builder: the config lives in equaxis-config.mjs",
    "delegate @scout: lowercase should work too",
    "DELEGATE @ghost this line is malformed",
    "RESULT:",
    "all done"
  ].join("\n");
  const { delegations, messages } = parseDirectives(reply);
  assert.equal(delegations.length, 2);
  // `routed` distinguishes "name given" from "let the worker decide" (M18).
  assert.deepEqual(delegations[0], { to: "builder", instruction: "write the config loader test", routed: false });
  assert.equal(delegations[1].to, "scout");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, "builder");
});

test("m1 directives: prompt teaches the collaboration protocol", () => {
  const prompt = buildTeammatePrompt(
    { name: "scout", persona: "", model: null },
    { id: "t", instruction: "x" },
    { workspacePath: "/w" }
  );
  assert.match(prompt, /DELEGATE @<teammate>:/);
  assert.match(prompt, /MESSAGE @<teammate>:/);
});

// ---- routines ----

test("m1 routines: addRoutine validates interval floor and teammate", () => {
  const store = seededStore(tmpRoot());
  assert.throws(() => store.addRoutine({ teammate: "scout", instruction: "x", everyMs: 5000 }), /at least/);
  assert.throws(() => store.addRoutine({ teammate: "ghost", instruction: "x", everyMs: MIN_ROUTINE_INTERVAL_MS }), /not found/);
  const routine = store.addRoutine({ teammate: "scout", instruction: "check the queue", everyMs: 60_000 });
  assert.equal(routine.enabled, true);
  assert.equal(routine.lastRunAt, null);
});

test("m1 routines: dueRoutines fires once, then not again before the interval", () => {
  const store = seededStore(tmpRoot());
  const routine = store.addRoutine({ teammate: "scout", instruction: "heartbeat", everyMs: 60_000 });
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(store.dueRoutines(t0).length, 1, "never-run routine is due");

  const fired = enqueueDueRoutines(store, t0);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].runSource, "routine");
  assert.equal(store.listTasks({ status: "pending" }).length, 1);
  assert.equal(store.dueRoutines(t0 + 59_999).length, 0, "not due before the interval elapses");
  assert.equal(store.dueRoutines(t0 + 60_000).length, 1, "due again after the interval");
  assert.equal(store.listRoutines()[0].id, routine.id);
});

test("m1 routines: a deleted teammate's routine is skipped, not crashed", () => {
  const store = seededStore(tmpRoot());
  store.addRoutine({ teammate: "builder", instruction: "tick", everyMs: 60_000 });
  store.deleteTeammate("builder");
  const fired = enqueueDueRoutines(store, Date.now());
  assert.equal(fired.length, 0);
});

test("m1 duration: parseDurationMs accepts 90s/30m/2h/1d and bare ms", () => {
  assert.equal(parseDurationMs("90s"), 90_000);
  assert.equal(parseDurationMs("30m"), 1_800_000);
  assert.equal(parseDurationMs("2h"), 7_200_000);
  assert.equal(parseDurationMs("1d"), 86_400_000);
  assert.equal(parseDurationMs("1500"), 1500);
  assert.ok(Number.isNaN(parseDurationMs("soon")));
  assert.ok(Number.isNaN(parseDurationMs("5x")));
});

// ---- worker integration: routines + delegation + inbox ----

test("m1 worker: fires due routines before claiming, then processes them", async () => {
  const store = seededStore(tmpRoot());
  store.addRoutine({ teammate: "scout", instruction: "heartbeat", everyMs: 60_000 });
  const seenPrompts = [];
  const summary = await runCompanionWorker({
    store,
    routines: true,
    once: true,
    executor: (task, ctx) => {
      seenPrompts.push(ctx.prompt);
      return "RESULT: beat";
    }
  });
  assert.equal(summary.processed, 1);
  assert.equal(summary.completed, 1);
  assert.match(seenPrompts[0], /heartbeat/);
  assert.equal(store.listTasks({ status: "done" })[0].runSource, "routine");
});

test("m1 worker: delegation directives become queued tasks for the other teammate", async () => {
  const store = seededStore(tmpRoot());
  store.enqueue("scout", "plan the fix");
  const summary = await runCompanionWorker({
    store,
    executor: () => "DELEGATE @builder: implement the fix\nMESSAGE @builder: spec is in notes.md\nRESULT:\nplanned",
    once: true
  });
  assert.equal(summary.delegated, 1);
  const delegated = store.listTasks({ teammateId: store.getTeammate("builder").id })[0];
  assert.equal(delegated.instruction, "implement the fix");
  assert.equal(delegated.runSource, "delegated:scout");
  const inbox = store.unreadMessages("builder");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].from, "scout");
  assert.match(inbox[0].text, /spec is in notes\.md/);
});

test("m1 worker: delegation to an unknown teammate is rejected without failing the task", async () => {
  const store = seededStore(tmpRoot());
  store.enqueue("scout", "try to delegate to nobody");
  const summary = await runCompanionWorker({
    store,
    executor: () => "DELEGATE @ghost: impossible\nRESULT:\ndone anyway",
    once: true
  });
  assert.equal(summary.completed, 1);
  assert.equal(summary.delegated, 0);
});

test("m1 worker: unread inbox is drained into the teammate's prompt exactly once", async () => {
  const store = seededStore(tmpRoot());
  store.sendMessage({ from: "human", to: "scout", text: "prioritize the config issue" });
  store.enqueue("scout", "work");
  const prompts = [];
  await runCompanionWorker({
    store,
    executor: (task, ctx) => {
      prompts.push(ctx.prompt);
      return "RESULT: ok";
    },
    once: true
  });
  assert.match(prompts[0], /prioritize the config issue/);
  assert.equal(store.unreadMessages("scout").length, 0, "drained after the task");
});

// ---- sandbox ----

test("m1 sandbox: buildBwrapArgs confines writes to the workspace", () => {
  const args = buildBwrapArgs({ workspace: "/proj/.pi/companion/workspaces/scout", projectRoot: "/proj", home: "/home/user" });
  const joined = args.join(" ");
  assert.match(joined, /--ro-bind \/usr \/usr/);
  assert.match(joined, /--ro-bind \/home\/user \/home\/user/);
  assert.match(joined, /--bind \/home\/user\/\.pi \/home\/user\/\.pi/, "Pi's own state dir stays writable (auth lock files)");
  assert.match(joined, /--ro-bind \/proj \/proj/);
  assert.match(joined, /--bind \/proj\/\.pi\/companion\/workspaces\/scout \/proj\/\.pi\/companion\/workspaces\/scout/);
  assert.match(joined, /--tmpfs \/tmp/);
  assert.match(joined, /--die-with-parent/);
  // the workspace bind must come after the project ro-bind (later wins)
  assert.ok(args.indexOf("--bind") > args.indexOf("--ro-bind"), "writable workspace bind must follow the read-only project bind");
  assert.throws(() => buildBwrapArgs({}), /workspace is required/);
});

test("m1 sandbox: spawn wrapper prefixes bwrap and the command", () => {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    return { pid: 1 };
  };
  const wrapped = createBwrapSpawnWrapper({
    bwrapPath: "/usr/bin/bwrap",
    workspace: "/w",
    projectRoot: "/proj",
    home: "/home/user",
    spawnImpl
  });
  wrapped("node", ["cli.js", "--mode", "json", "hi"], { cwd: "/w" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/bwrap");
  const args = calls[0].args;
  assert.equal(args[args.indexOf("--") + 1], "node");
  assert.deepEqual(args.slice(args.indexOf("--") + 1), ["node", "cli.js", "--mode", "json", "hi"]);
  assert.deepEqual(Object.keys(calls[0]), ["command", "args"]);
});

// ---- ntfy channel ----

test("m1 notify: ntfy posts the body when COMPANION_NTFY_URL is set", async () => {
  const store = seededStore(tmpRoot());
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const notifier = createNotifier({ store, fetchImpl, env: { COMPANION_NTFY_URL: "https://ntfy.example.com/my-topic" } });
  const report = await notifier({ kind: "task_completed", teammate: { name: "scout" }, task: { id: "t", result: "done" } });
  assert.equal(report.ntfy, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ntfy.example.com/my-topic");
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].init.body, /task done/);

  const off = createNotifier({ store, fetchImpl, env: {} });
  const offReport = await off({ kind: "task_completed", teammate: { name: "scout" }, task: { result: "x" } });
  assert.equal(offReport.ntfy, false);
});

// Regression: a transport wrapper that leaks an object into the result path
// used to be stored verbatim as "[object Object]" (found in real feed data).
test("m1 result: an object reply is serialized, never stringified into [object Object]", () => {
  const fromObject = extractResult({ ok: true, output: "stream" });
  assert.notEqual(fromObject, "[object Object]");
  assert.match(fromObject, /"ok":true/);

  assert.equal(extractResult(null), "");
  assert.equal(extractResult(undefined), "");
  assert.equal(extractResult("  plain text  "), "plain text");

  // A RESULT: section still wins, whatever the container type.
  assert.equal(extractResult({ text: "x\nRESULT:\nthe answer" }), "{\"text\":\"x\\nRESULT:\\nthe answer\"}");
  assert.equal(extractResult("did work\nRESULT:\nthe answer"), "the answer");

  // Directives are only parsed from strings; an object must not crash.
  assert.deepEqual(parseDirectives({ not: "a string" }), { delegations: [], messages: [], hires: [] });
  assert.equal(parsePiJsonReply({ not: "a stream" }), "");
});
