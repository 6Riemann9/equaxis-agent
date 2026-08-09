import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildRuntimeDashboard, formatRuntimeDashboard } from "../../src/runtime-dashboard.mjs";

type DashboardArgs = {
  json: boolean;
};

function parseArgs(raw: string): DashboardArgs {
  const args = raw.trim().split(/\s+/).filter(Boolean);
  return { json: args.includes("--json") };
}

export default function dashboardCommandExtension(pi: ExtensionAPI) {
  pi.registerCommand("dashboard", {
    description: "Show the Equaxis runtime dashboard",
    handler: async (rawArgs, ctx) => {
      const args = parseArgs(rawArgs);
      const dashboard = buildRuntimeDashboard({
        projectRoot: ctx.cwd,
        cwd: ctx.cwd,
        env: process.env,
        config: (ctx as { services?: { config?: unknown } }).services?.config
      });
      const output = args.json ? JSON.stringify(dashboard, null, 2) : formatRuntimeDashboard(dashboard);
      ctx.ui.notify(output, "info");
    }
  });
}
