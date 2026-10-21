import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CompanionStore, MAX_ATTEMPTS } from "../src/companion-store.mjs";
import { createNotifier, formatTaskMessage } from "../src/companion-notify.mjs";
import { buildTeammatePrompt, extractResult, parsePiJsonReply, runCompanionWorker } from "../src/companion-runtime.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-test-"));
}

function seededStore(root) {
  const store = CompanionStore.open(root);
  store.createTeammate({ name: "scout", persona: "a careful researcher", workspace: "scout" });
  return store;
}

// ---- store ----

test("companion store: createTeammate persists and reloads", () => {
  const root = tmpRoot();
  const store = seededStore(root);
  const reopened = CompanionStore.open(root);
  assert.equal(reopened.listTeammates().length, 1);
  assert.equal(reopened.getTeammate("scout").persona, "a careful researcher");
});

test("companion store: rejects duplicate names and bad kebab-case", () => {
  const store = seededStore(tmpRoot());
  assert.throws(() => store.createTeammate({ name: "scout" }), /already exists/);
  assert.throws(() => store.createTeammate({ name: "Bad Name!" }), /kebab-case/);
});

test("companion store: queue is FIFO and enqueue requires a known teammate", () => {
  const store = seededStore(tmpRoot());
  assert.throws(() => store.enqueue("ghost", "do things"), /not found/);
  const first = store.enqueue("scout", "first task");
  const second = store.enqueue("scout", "second task");
  assert.equal(store.next().id, first.id);
  assert.equal(store.next().id, second.id);
  assert.equal(store.next(), null);
});

test("companion store: complete/fail bump teammate stats and record results", () => {
  const store = seededStore(tmpRoot());
  const done = store.enqueue("scout", "good task");
  store.next();
  store.complete(done.id, "all good");
  const failed = store.enqueue("scout", "bad task");
  store.next();
  store.fail(failed.id, new Error("boom"));
  const teammate = store.getTeammate("scout");
  assert.equal(teammate.stats.completed, 1);
  assert.equal(teammate.stats.failed, 1);
  assert.equal(store.getTask(done.id).result, "all good");
  assert.match(store.getTask(failed.id).error, /boom/);
});

test("companion store: crash recovery requeues running tasks under the attempt cap", () => {
  const root = tmpRoot();
  const store = seededStore(root);
  const task = store.enqueue("scout", "interrupted work");
  store.next(); // now running; simulate a crashed worker by not completing

  const reopened = CompanionStore.open(root);
  assert.deepEqual(reopened.recoveredOnOpen, [task.id]);
  const recovered = reopened.getTask(task.id);
  assert.equal(recovered.status, "pending");
  // attempts: 1 from the original claim, +1 from crash recovery
  assert.equal(recovered.attempts, 2);

  // Drive attempts to the cap: each open() with a running task requeues.
  let current = recovered;
  while (current.attempts < MAX_ATTEMPTS) {
    reopened.next();
    current = reopened.getTask(current.id);
  }
  const final = CompanionStore.open(root);
  const failedTask = final.getTask(task.id);
  assert.equal(failedTask.status, "failed");
  assert.match(failedTask.error, /worker crashed/);
});

test("companion store: deleteTeammate keeps running tasks but drops the rest", () => {
  const store = seededStore(tmpRoot());
  const running = store.enqueue("scout", "in flight");
  store.enqueue("scout", "queued");
  store.next();
  assert.equal(store.getTask(running.id).status, "running");
  store.deleteTeammate("scout");
  const tasks = store.listTasks({});
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, running.id);
});

test("companion store: teammate ids are stable across reloads", () => {
  const root = tmpRoot();
  const store = seededStore(root);
  const task = store.enqueue("scout", "a task");
  // Regression: reload used to regenerate teammate UUIDs, which orphaned
  // every queued task's teammateId.
  const reopened = CompanionStore.open(root);
  const teammate = reopened.teammates.find((t) => t.id === task.teammateId);
  assert.ok(teammate, "queued task must still resolve its teammate after reload");
  assert.equal(teammate.name, "scout");
  const again = CompanionStore.open(root);
  assert.equal(again.getTeammate("scout").id, teammate.id, "id must not change on a second reload");
});

test("companion store: teammateDirectory resolves project-relative workspaces", () => {
  const store = seededStore(tmpRoot());
  const teammate = store.getTeammate("scout");
  const dir = store.teammateDirectory(teammate, "/proj");
  assert.equal(dir, path.join("/proj", ".pi", "companion", "workspaces", "scout"));
  const absolute = store.teammateDirectory({ ...teammate, workspace: "/abs" }, "/proj");
  assert.equal(absolute, "/abs");
});

test("companion store: feed round-trips and tolerates corruption", () => {
  const store = seededStore(tmpRoot());
  store.appendFeed({ kind: "task_completed", text: "hello" });
  fs.appendFileSync(store.feedFile, "not json\n", "utf8");
  const entries = store.readFeed();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].text, "hello");
  assert.equal(entries[1].kind, "corrupt_line");
});

// ---- notify ----

test("companion notify: formatTaskMessage covers done and failed", () => {
  const done = formatTaskMessage({ kind: "task_completed", teammate: { name: "scout" }, task: { result: "summary" } });
  assert.match(done, /\[scout\] task done:\nsummary/);
  const failed = formatTaskMessage({ kind: "task_failed", teammate: { name: "scout" }, task: { error: "boom" } });
  assert.match(failed, /task failed: boom/);
});

test("companion notify: always writes the feed; telegram only when configured", async () => {
  const store = seededStore(tmpRoot());
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const event = { kind: "task_completed", teammate: { name: "scout" }, task: { id: "t1", result: "done" } };

  const bare = createNotifier({ store });
  const bareReport = await bare(event);
  assert.equal(bareReport.telegram, false);
  assert.equal(store.readFeed().length, 1);

  const configured = createNotifier({
    store,
    fetchImpl,
    env: { COMPANION_TELEGRAM_TOKEN: "test-token-value", COMPANION_TELEGRAM_CHAT_ID: "42" }
  });
  const report = await configured(event);
  assert.equal(report.telegram, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.telegram\.org/);
  assert.equal(calls[0].body.chat_id, "42");
  assert.equal(store.readFeed().length, 2);
});

test("companion notify: a telegram failure never fails the notification", async () => {
  const store = seededStore(tmpRoot());
  const failing = createNotifier({
    store,
    fetchImpl: async () => ({ ok: false, status: 500 }),
    env: { COMPANION_TELEGRAM_TOKEN: "test-token-value", COMPANION_TELEGRAM_CHAT_ID: "42" }
  });
  const report = await failing({ kind: "task_failed", teammate: { name: "scout" }, task: { error: "x" } });
  assert.equal(report.telegram, false);
  assert.equal(report.feed, true);
});

// ---- runtime ----

test("companion runtime: buildTeammatePrompt includes persona, instruction and workspace", () => {
  const prompt = buildTeammatePrompt(
    { name: "scout", persona: "a careful researcher", model: null },
    { id: "t1", instruction: "survey the repo" },
    { workspacePath: "/proj/.pi/companion/workspaces/scout" }
  );
  assert.match(prompt, /You are scout, a persistent AI teammate/);
  assert.match(prompt, /a careful researcher/);
  assert.match(prompt, /survey the repo/);
  assert.match(prompt, /companion\/workspaces\/scout/);
  assert.match(prompt, /RESULT:/);
});

test("companion runtime: extractResult prefers the RESULT section and truncates", () => {
  assert.equal(extractResult("work work\nRESULT:\nfinal answer"), "final answer");
  assert.equal(extractResult("RESULT: inline"), "inline");
  assert.equal(extractResult("no marker"), "no marker");
  const long = "x".repeat(5000);
  assert.ok(extractResult(long).length <= 4000);
});

test("companion runtime: worker drains the queue and notifies", async () => {
  const store = seededStore(tmpRoot());
  store.enqueue("scout", "task one");
  store.enqueue("scout", "task two");
  const notifications = [];
  const notify = async (event) => notifications.push(event.kind);
  const replies = new Map([
    ["task one", "noise\nRESULT:\nfirst done"],
    ["task two", "RESULT: second done"]
  ]);
  const summary = await runCompanionWorker({
    store,
    notify,
    pollMs: 10,
    maxTasks: 2,
    executor: (task) => replies.get(store.getTask(task.id).instruction) ?? "RESULT: ok"
  });
  assert.equal(summary.processed, 2);
  assert.deepEqual(notifications, ["task_completed", "task_completed"]);
});

test("companion runtime: worker failure records the error and notifies task_failed", async () => {
  const store = seededStore(tmpRoot());
  store.enqueue("scout", "explode");
  const notifications = [];
  const summary = await runCompanionWorker({
    store,
    notify: async (event) => notifications.push(event.kind),
    executor: () => {
      throw new Error("kaboom");
    },
    maxTasks: 1
  });
  assert.equal(summary.completed, 0);
  assert.equal(summary.failed, 1);
  assert.deepEqual(notifications, ["task_failed"]);
  assert.match(store.listTasks({ status: "failed" })[0].error, /kaboom/);
});

test("companion runtime: parsePiJsonReply extracts the final assistant text from a JSONL stream", () => {
  const stream = [
    JSON.stringify({ type: "session", id: "s1" }),
    JSON.stringify({ type: "agent_start" }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "thinking out loud" }] } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FINAL: OK" }] } }),
    JSON.stringify({ type: "agent_end", messages: [
      { role: "system", content: "" },
      { role: "assistant", content: [{ type: "text", text: "FINAL: OK" }] }
    ] })
  ].join("\n");
  assert.equal(parsePiJsonReply(stream), "FINAL: OK");
  const minimal = JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: "plain text reply" }] });
  assert.equal(parsePiJsonReply(minimal), "plain text reply");
  assert.equal(parsePiJsonReply("not json\n{}\n"), "");
  assert.equal(parsePiJsonReply(""), "");
});

test("companion runtime: once processes exactly one task", async () => {
  const store = seededStore(tmpRoot());
  store.enqueue("scout", "a");
  store.enqueue("scout", "b");
  const summary = await runCompanionWorker({
    store,
    executor: () => "RESULT: ok",
    once: true
  });
  assert.equal(summary.processed, 1);
  assert.equal(summary.stoppedBy, "once");
  assert.equal(store.listTasks({ status: "pending" }).length, 1);
});

test("companion runtime: aborted signal stops the idle loop", async () => {
  const store = seededStore(tmpRoot());
  const controller = new AbortController();
  const workerPromise = runCompanionWorker({
    store,
    executor: () => "RESULT: ok",
    pollMs: 10,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 30);
  const summary = await workerPromise;
  assert.equal(summary.stoppedBy, "aborted");
  assert.equal(summary.processed, 0);
});
