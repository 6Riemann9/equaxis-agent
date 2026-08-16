import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildRuntimeDashboard, formatRuntimeDashboard, renderRuntimeDashboardLines } from "../../src/runtime-dashboard.mjs";
import { makeUiKit } from "../../src/ui-kit.mjs";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

type DashboardArgs = {
  json: boolean;
  fullscreen: boolean;
  plain: boolean;
};

function parseArgs(raw: unknown): DashboardArgs {
  const text = typeof raw === "string" ? raw : "";
  const args = text.trim().split(/\s+/).filter(Boolean);
  return {
    json: args.includes("--json"),
    fullscreen: args.includes("full") || args.includes("--full"),
    plain: args.includes("--plain") || args.includes("--text"),
  };
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

function buildDashboard(ctx: { cwd?: unknown }) {
  const cwd = commandCwd(ctx);
  return {
    cwd,
    dashboard: buildRuntimeDashboard({
      projectRoot: cwd,
      cwd,
      env: process.env,
      config: runtimeConfig(ctx),
    }),
  };
}

export default function dashboardCommandExtension(pi: ExtensionAPI) {
  pi.registerCommand("dashboard", {
    description: "Show the Equaxis runtime dashboard (full = full-screen view, --json = machine readable)",
    handler: async (rawArgs, ctx) => {
      const args = parseArgs(rawArgs);
      if (args.json) {
        const { dashboard } = buildDashboard(ctx);
        ctx.ui.notify(JSON.stringify(dashboard, null, 2), "info");
        return;
      }

      if (args.fullscreen || (ctx.mode === "tui" && !args.plain)) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("Full-screen dashboard requires interactive TUI mode (use --plain or --json otherwise)", "error");
          return;
        }
        const { dashboard } = buildDashboard(ctx);
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          return new DashboardViewer(dashboard, theme, done, () => tui.requestRender());
        });
        return;
      }

      const { dashboard } = buildDashboard(ctx);
      ctx.ui.notify(formatRuntimeDashboard(dashboard, { color: false }), "info");
    },
  });
}

/**
 * Full-screen dashboard viewer: scrollable, theme-rendered, shares the exact
 * same layout as the CLI text output (renderRuntimeDashboardLines).
 */
class DashboardViewer {
  private offset = 0;
  private cachedWidth = -1;
  private cachedHeight = -1;
  private cachedLines: string[] = [];

  constructor(
    private readonly dashboard: ReturnType<typeof buildRuntimeDashboard>,
    private readonly theme: ExtensionContext["ui"]["theme"],
    private readonly done: () => void,
    private readonly requestRender: () => void,
  ) {}

  handleInput(data: string): void {
    const total = this.cachedLines.length;    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.done();
      return;
    }
    if (matchesKey(data, "up") || data === "k") this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, "down") || data === "j") this.offset = Math.min(Math.max(0, total - 1), this.offset + 1);
    else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - 12);
    else if (matchesKey(data, "pageDown")) this.offset = Math.min(Math.max(0, total - 1), this.offset + 12);
    else if (matchesKey(data, "home")) this.offset = 0;
    else if (matchesKey(data, "end")) this.offset = Math.max(0, total - 1);
    this.requestRender();
  }

  render(width: number): string[] {
    const kit = makeUiKit({ theme: this.theme });
    const lines = renderRuntimeDashboardLines(this.dashboard, kit);
    const height = Math.min(32, Math.max(10, lines.length + 6));

    if (this.cachedWidth === width && this.cachedHeight === height && this.cachedLines.length === lines.length) {
      return this.cachedLines;
    }

    const visibleRows = Math.max(1, height - 5);
    this.offset = Math.min(this.offset, Math.max(0, lines.length - visibleRows));
    const page = lines.slice(this.offset, this.offset + visibleRows);

    const top =
      kit.paint("accent", kit.bold("Equaxis Runtime Dashboard")) +
      kit.paint("dim", "  Up/Down PgUp/PgDn Home/End scroll · Q/Esc close");
    const bottom = kit.paint(
      "dim",
      `rows ${lines.length === 0 ? 0 : this.offset + 1}-${this.offset + page.length} of ${lines.length}`
    );

    const out = [top, kit.paint("borderMuted", "─".repeat(Math.max(1, width))), ...page, kit.paint("borderMuted", "─".repeat(Math.max(1, width))), bottom];
    this.cachedWidth = width;
    this.cachedHeight = height;
    this.cachedLines = out.map((line) => truncateToWidth(line, Math.max(1, width)));
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = -1;
  }
}
