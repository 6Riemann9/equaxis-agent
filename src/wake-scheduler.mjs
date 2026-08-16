/**
 * Quota-aware auto-wake (huangruiteng/loopx quota should-run + scheduler
 * hint, Windows slice).
 *
 * The eligibility decision already lives in goal-state (shouldRunGoal:
 * gates first, then the token window). This module turns it into a wake
 * plan: a probe (scripts/equaxis-wake.mjs) answers "should this goal lane
 * act now", a schtasks builder registers the cadence, and — only when the
 * user opts in via goalState.autoWake.enabled — runScheduledWake launches
 * an Equaxis session with the goal's nextAction. Auto-execution is OFF by
 * default; the probe + scheduler registration are the default posture.
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { shouldRunGoal } from "./goal-state.mjs";

/**
 * Combine the goal eligibility decision with the autoWake config into one
 * wake plan. `wouldRun` is true only when eligible AND autoWake is enabled
 * AND the goal has a nextAction — the three-way gate keeps scheduled
 * execution explicit.
 *
 * @param {{ goal?: object|null, config?: object, now?: () => string }} options
 */
export function buildWakePlan({ goal, config = {}, now = () => new Date().toISOString() } = {}) {
  if (!goal) {
    return { eligible: false, reason: "no_active_goal", gate: null, spent: null, budget: null, nextEligibleAt: null, nextAction: null, wouldRun: false };
  }
  const decision = shouldRunGoal(goal, { now });
  const autoWake = config.autoWake ?? {};
  const nextAction = String(goal.nextAction ?? "").trim() || null;
  return {
    eligible: decision.eligible,
    reason: decision.reason,
    gate: decision.gate ?? null,
    spent: decision.spent ?? null,
    budget: decision.budget ?? null,
    nextEligibleAt: decision.nextEligibleAt ?? null,
    nextAction,
    wouldRun: decision.eligible === true && autoWake.enabled === true && nextAction !== null
  };
}

/**
 * Windows Task Scheduler registration command for the wake probe:
 * runs scripts/equaxis-wake.mjs --scheduled every `intervalMinutes`.
 * Returns the schtasks create string (run it in an admin shell).
 *
 * @param {{ projectRoot: string, intervalMinutes?: number, taskName?: string, nodeCmd?: string }} options
 */
export function scheduledTaskCommand({ projectRoot, intervalMinutes = 30, taskName = "EquaxisWake", nodeCmd = process.execPath } = {}) {
  const script = path.join(path.resolve(projectRoot), "scripts", "equaxis-wake.mjs");
  const winPath = (value) => String(value).replaceAll("/", "\\");
  const task = `"${winPath(nodeCmd)}" "${winPath(script)}" --scheduled`;
  return `schtasks /Create /TN "${taskName}" /TR ${task} /SC MINUTE /MO ${Math.max(1, Math.floor(intervalMinutes))} /F`;
}

/**
 * Run the scheduled wake: when the plan says wouldRun, spawn an Equaxis
 * session (json mode, nextAction as the prompt) with the configured
 * provider/model (autoWake.provider/model — required when autoWake is
 * enabled; no vendor default is assumed). Returns the plan + started
 * flag; never spawns when not wouldRun.
 */
export async function runScheduledWake({ projectRoot, config = {}, goal, spawnImpl, log = () => {} } = {}) {
  const plan = buildWakePlan({ goal, config });
  if (!plan.wouldRun) {
    log(`wake skipped: ${plan.reason}`);
    return { ...plan, started: false, args: null };
  }
  const autoWake = config.autoWake ?? {};
  const provider = String(autoWake.provider ?? "").trim();
  const model = String(autoWake.model ?? "").trim();
  if (!provider || !model) {
    const error = "autoWake is enabled but goalState.autoWake.provider/model is not set — configure them in .pi/equaxis.json";
    log(`wake skipped: ${error}`);
    return { ...plan, started: false, args: null, error };
  }
  const args = ["scripts/equaxis.mjs", "--mode", "json", "--thinking", "off", "--provider", provider, "--model", model, String(plan.nextAction)];
  const launch = spawnImpl ?? ((cmd, argv) => new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd: path.resolve(projectRoot), stdio: "inherit", windowsHide: true });
    child.on("close", resolve);
    child.on("error", (error) => { log(`wake spawn failed: ${String(error?.message ?? error)}`); resolve(); });
  }));
  try {
    await launch(process.execPath, args);
  } catch (error) {
    log(`wake spawn failed: ${String(error?.message ?? error)}`);
    return { ...plan, started: false, args };
  }
  log(`wake launched: ${provider}/${model} — ${plan.nextAction}`);
  return { ...plan, started: true, args };
}
