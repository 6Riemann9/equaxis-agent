import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildWakePlan, runScheduledWake, scheduledTaskCommand } from "../src/wake-scheduler.mjs";
import { createGoal } from "../src/goal-state.mjs";

const NOW = () => "2026-08-15T00:00:00.000Z";

function goalWith(patch = {}) {
  return createGoal({ id: "g1", objective: "ship", quota: { tokenBudget: 100, windowHours: 24 }, ...patch }, { now: NOW });
}

test("buildWakePlan reports eligibility from gates and quota", () => {
  const noGoal = buildWakePlan({ goal: null });
  assert.equal(noGoal.eligible, false);
  assert.equal(noGoal.reason, "no_active_goal");
  assert.equal(noGoal.wouldRun, false);

  const gated = goalWith();
  gated.gates.push({ name: "review", kind: "quality_gate", question: "run the suite?", status: "open", resolution: "", resolvedAt: null });
  const gatePlan = buildWakePlan({ goal: gated, now: NOW });
  assert.equal(gatePlan.eligible, false);
  assert.equal(gatePlan.reason, "gate_open");
  assert.equal(gatePlan.gate, "review");
  assert.equal(gatePlan.wouldRun, false);

  const exhausted = goalWith();
  exhausted.quota.spentTokens = 100;
  const quotaPlan = buildWakePlan({ goal: exhausted, now: NOW });
  assert.equal(quotaPlan.eligible, false);
  assert.equal(quotaPlan.reason, "quota_exhausted");
  assert.equal(quotaPlan.nextEligibleAt, "2026-08-16T00:00:00.000Z");

  const ok = buildWakePlan({ goal: goalWith({ nextAction: "merge the PR" }), config: { autoWake: { enabled: true } }, now: NOW });
  assert.equal(ok.eligible, true);
  assert.equal(ok.wouldRun, true);
  assert.equal(ok.nextAction, "merge the PR");
});

test("wouldRun requires autoWake enabled AND a nextAction", () => {
  const goal = goalWith({ nextAction: "merge" });
  assert.equal(buildWakePlan({ goal, config: {}, now: NOW }).wouldRun, false, "autoWake disabled by default");
  assert.equal(buildWakePlan({ goal, config: { autoWake: { enabled: true } }, now: NOW }).wouldRun, true);
  const noNext = goalWith();
  assert.equal(buildWakePlan({ goal: noNext, config: { autoWake: { enabled: true } }, now: NOW }).wouldRun, false, "no nextAction");
});

test("scheduledTaskCommand builds a schtasks registration string", () => {
  const command = scheduledTaskCommand({ projectRoot: "C:/proj", intervalMinutes: 30, taskName: "EquaxisWake", nodeCmd: "C:/node.exe" });
  assert.match(command, /^schtasks \/Create \/TN "EquaxisWake"/);
  assert.match(command, /\/SC MINUTE \/MO 30/);
  assert.match(command, /--scheduled/);
  assert.match(command, /\/F$/);
  // Both executables are quoted and backslash-normalized; the script path is
  // derived from the same path.resolve the module uses, so the assertion is
  // platform-neutral (POSIX embeds the drive-letter root differently).
  const winPath = (value) => String(value).replaceAll("/", "\\");
  const expectedScript = winPath(path.resolve("C:/proj", "scripts", "equaxis-wake.mjs"));
  assert.ok(command.includes(`"${winPath("C:/node.exe")}" "${expectedScript}" --scheduled`), `command: ${command}`);
  const clamped = scheduledTaskCommand({ projectRoot: "C:/proj", intervalMinutes: 0 });
  assert.match(clamped, /\/MO 1/);
});

test("runScheduledWake never spawns when not wouldRun", async () => {
  let spawned = 0;
  const result = await runScheduledWake({
    projectRoot: "C:/proj",
    config: {},
    goal: goalWith({ nextAction: "merge" }),
    spawnImpl: async () => { spawned += 1; }
  });
  assert.equal(result.started, false);
  assert.equal(result.wouldRun, false);
  assert.equal(spawned, 0);
});

test("runScheduledWake spawns one session with nextAction and configured model", async () => {
  const calls = [];
  const result = await runScheduledWake({
    projectRoot: "C:/proj",
    config: { autoWake: { enabled: true, provider: "deepseek", model: "deepseek-v4-flash" } },
    goal: goalWith({ nextAction: "merge the PR" }),
    spawnImpl: async (cmd, args) => { calls.push({ cmd, args }); }
  });
  assert.equal(result.started, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, ["scripts/equaxis.mjs", "--mode", "json", "--thinking", "off", "--provider", "deepseek", "--model", "deepseek-v4-flash", "merge the PR"]);
});

test("runScheduledWake refuses to spawn without configured provider/model", async () => {
  const calls = [];
  const logs = [];
  const result = await runScheduledWake({
    projectRoot: "C:/proj",
    config: { autoWake: { enabled: true } },
    goal: goalWith({ nextAction: "ship" }),
    spawnImpl: async (cmd, args) => { calls.push(args); },
    log: (line) => logs.push(line)
  });
  assert.equal(calls.length, 0, "no spawn without provider/model");
  assert.equal(result.started, false);
  assert.ok(result.error.includes("autoWake.provider/model"), `error names the missing keys: ${result.error}`);
  assert.ok(logs.some((line) => line.includes("autoWake.provider/model")));
});

test("runScheduledWake logs skip and spawn failure via the log hook", async () => {
  const logs = [];
  const skipped = await runScheduledWake({ projectRoot: "C:/p", config: {}, goal: goalWith(), log: (line) => logs.push(line) });
  assert.equal(skipped.started, false);
  assert.ok(logs.some((line) => line.includes("wake skipped")));

  const failLogs = [];
  await runScheduledWake({
    projectRoot: "C:/p",
    config: { autoWake: { enabled: true, provider: "deepseek", model: "deepseek-v4-flash" } },
    goal: goalWith({ nextAction: "x" }),
    spawnImpl: async () => { throw new Error("no node"); },
    log: (line) => failLogs.push(line)
  });
  assert.ok(failLogs.some((line) => line.includes("wake spawn failed")));
});

test("scheduledTaskCommand script path stays inside the project root", () => {
  const command = scheduledTaskCommand({ projectRoot: path.resolve("C:/proj"), nodeCmd: "node" });
  assert.ok(!command.includes(".."), "no traversal in task command");
});
