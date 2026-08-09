import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildRuntimeDashboard, formatRuntimeDashboard } from "../../src/runtime-dashboard.mjs";

type DashboardArgs = {
  json: boolean;
};

function parseArgs(raw: unknown): DashboardArgs {
  const text = typeof raw === "string" ? raw : "";
  const args = text.trim().split(/\s+/).filter(Boolean);
  return { json: args.includes("--json") };
}

function commandCwd(ctx: { cwd?: unknown }): string {
  return typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
}

function runtimeConfig(ctx: unknown): unknown {
  const config = (ctx as { services?: { config?: unknown } })?.services?.config;
  if (!config || typeof config !== "object") return undefined;
  if ("evaluation" in config || "protocols" in config || "subagents" in config) return config;
  return undefined;
}

export default function dashboardCommandExtension(pi: ExtensionAPI) {
  pi.registerCommand("dashboard", {
    description: "Show the Equaxis runtime dashboard",
    handler: async (rawArgs, ctx) => {
      const args = parseArgs(rawArgs);
      const cwd = commandCwd(ctx);
      const dashboard = buildRuntimeDashboard({
        projectRoot: cwd,
        cwd,
        env: process.env,
        config: runtimeConfig(ctx)
      });
      const output = args.json ? JSON.stringify(dashboard, null, 2) : formatRuntimeDashboard(dashboard);
      ctx.ui.notify(output, "info");
    }
  });
}
