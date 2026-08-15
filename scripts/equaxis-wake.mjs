#!/usr/bin/env node
/**
 * Quota-aware wake probe (loopx should-run slice).
 *
 * Usage:
 *   node scripts/equaxis-wake.mjs            # human-readable decision + exit 0/1
 *   node scripts/equaxis-wake.mjs --json     # machine-readable plan
 *   node scripts/equaxis-wake.mjs --scheduled
 *     # scheduled mode: when the plan says wouldRun (eligible + autoWake
 *     # enabled + nextAction set), launch an Equaxis session with the
 *     # goal's nextAction; exit 0 when launched, 2 when skipped.
 *
 * Register a cadence with the schtasks command printed by
 * /equaxis-goal schedule (admin shell).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEquaxisConfig } from "../src/equaxis-config.mjs";
import { createGoalStore } from "../src/goal-state.mjs";
import { buildWakePlan, runScheduledWake } from "../src/wake-scheduler.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const scheduled = args.includes("--scheduled");

const config = loadEquaxisConfig(projectRoot);
const goalStateConfig = config.goalState ?? {};
const store = createGoalStore({ projectRoot, rootDir: goalStateConfig.rootDir ?? ".pi/runtime/goals" });
const goal = store.activeGoal();

if (scheduled) {
  const result = await runScheduledWake({ projectRoot, config: goalStateConfig, goal, log: (line) => console.error(line) });
  console.log(JSON.stringify(result));
  process.exit(result.started ? 0 : 2);
}

const plan = buildWakePlan({ goal, config: goalStateConfig });
if (asJson) {
  console.log(JSON.stringify(plan));
} else if (plan.eligible) {
  console.log(`should run: yes (${plan.reason})`);
  if (plan.nextAction) console.log(`next action: ${plan.nextAction}`);
} else {
  console.log(`should run: no (${plan.reason})`);
  if (plan.gate) console.log(`blocking gate: ${plan.gate}`);
  if (plan.nextEligibleAt) console.log(`next eligible: ${plan.nextEligibleAt}`);
}
process.exit(plan.eligible ? 0 : 1);
