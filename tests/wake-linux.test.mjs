import test from "node:test";
import assert from "node:assert/strict";
import { scheduledTaskCommand, buildWakePlan } from "../src/wake-scheduler.mjs";

const PLATFORM = process.platform;

test("scheduledTaskCommand returns a systemd user timer snippet on Linux", { skip: PLATFORM === "win32" }, () => {
  const snippet = scheduledTaskCommand({ projectRoot: "/opt/equaxis", intervalMinutes: 30, taskName: "EquaxisWake" });
  assert.match(snippet, /systemctl --user daemon-reload/);
  assert.match(snippet, /systemctl --user enable --now equaxiswake\.timer/);
  assert.match(snippet, /OnCalendar=\*:0\/30/);
  assert.match(snippet, /Persistent=true/);
  assert.match(snippet, /WantedBy=timers\.target/);
  assert.match(snippet, /equaxis-wake\.mjs --scheduled/);
  assert.match(snippet, /WorkingDirectory=\/opt\/equaxis/);
  // the unit name is derived from the task name
  assert.match(snippet, /equaxiswake\.service/);
  // removal instructions keep the registration reversible
  assert.match(snippet, /systemctl --user disable --now equaxiswake\.timer/);
});

test("scheduledTaskCommand clamps and sanitizes the unit name", { skip: PLATFORM === "win32" }, () => {
  const snippet = scheduledTaskCommand({ projectRoot: "/opt/equaxis", intervalMinutes: 0.5, taskName: "My Weird!! Name" });
  assert.match(snippet, /OnCalendar=\*:0\/1/);
  assert.match(snippet, /my-weird-name\.(service|timer)/);
});

test("wake plan stays a three-way gate (no goal, no run)", () => {
  const plan = buildWakePlan({ goal: null, config: { autoWake: { enabled: true } } });
  assert.equal(plan.wouldRun, false);
  assert.equal(plan.reason, "no_active_goal");
});

test("printf escaping produces valid single-quoted shell strings", { skip: PLATFORM === "win32" }, () => {
  const snippet = scheduledTaskCommand({ projectRoot: "/opt/equaxis", intervalMinutes: 15 });
  // Extract the printf'd service definition and verify no raw newline is present
  // inside the single-quoted string (they must be \n escapes).
  const printfMatch = snippet.match(/printf '([^']*)' > /);
  assert.ok(printfMatch, "printf command present");
  assert.ok(!printfMatch[1].includes("\n"), "no literal newlines inside the quoted unit body");
  assert.match(printfMatch[1], /\[Unit\]\\nDescription/);
});
