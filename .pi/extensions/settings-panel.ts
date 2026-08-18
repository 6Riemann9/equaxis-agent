import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createExtensionRuntimeServices } from "../../src/extension-runtime-services.mjs";
import { CONFIG_SECTIONS, getAtPath, sectionMetadataById } from "../../src/config-sections.mjs";
import { loadEquaxisConfigLayers } from "../../src/equaxis-config.mjs";
import { makeUiKit } from "../../src/ui-kit.mjs";

interface SettingsLayer {
  global?: Record<string, unknown>;
  project?: Record<string, unknown>;
  effective: Record<string, unknown>;
  defaults: Record<string, unknown>;
}

function commandCwd(ctx: { cwd?: unknown }): string {
  return typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
}

/** Which layer provides the effective value for a key: project > global > default. */
function sourceOf(layers: SettingsLayer, key: string): string {
  if (getAtPath(layers.project ?? {}, key) !== undefined) return "project";
  if (getAtPath(layers.global ?? {}, key) !== undefined) return "global";
  return "default";
}

export default function settingsPanelExtension(pi: ExtensionAPI) {
  const services = createExtensionRuntimeServices({ cwd: process.cwd(), extensionId: "settings-panel", pi });

  // Register /settings command
  pi.registerCommand("settings", {
    description: "Open the Equaxis settings panel. Use --section <id> to jump to a specific section, or --search <query> to filter settings.",
    getArgumentCompletions: (prefix) => {
      const sections = CONFIG_SECTIONS.map((s) => ({ value: s.id, label: s.label }));
      if (prefix.startsWith("--section ")) {
        const query = prefix.slice(10).toLowerCase();
        return sections.filter((s) => s.value.startsWith(query));
      }
      if (prefix.startsWith("--search ")) return [];
      return [
        { value: "--section", label: "Jump to section" },
        { value: "--search", label: "Search settings" },
        { value: "--json", label: "Output as JSON" }
      ];
    },
    handler: async (rawArgs, ctx) => {
      const text = typeof rawArgs === "string" ? rawArgs : "";
      const args = text.trim().split(/\s+/).filter(Boolean);
      const sectionArg = args.indexOf("--section") >= 0 ? args[args.indexOf("--section") + 1] : undefined;
      const searchArg = args.indexOf("--search") >= 0 ? args[args.indexOf("--search") + 1] : undefined;
      const wantJson = args.includes("--json");
      const cwd = commandCwd(ctx);
      const layers = loadEquaxisConfigLayers(cwd) as unknown as SettingsLayer;

      if (wantJson) {
        const sections = CONFIG_SECTIONS.map((section) => ({
          id: section.id,
          label: section.label,
          description: section.description,
          icon: section.icon,
          keys: section.keys.map((key) => ({
            key: key.key,
            label: key.label,
            type: key.type,
            description: key.description,
            value: getAtPath(layers.effective, key.key),
            default: getAtPath(layers.defaults, key.key)
          }))
        }));
        ctx.ui.notify(JSON.stringify(sections, null, 2), "info");
        return;
      }

      if (ctx.mode === "tui") {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          return new SettingsViewer(layers, theme, done, () => tui.requestRender(), sectionArg, searchArg);
        });
        return;
      }

      ctx.ui.notify(formatSettingsText(layers, sectionArg, searchArg), "info");
    }
  });

  // Register settings_panel tool for programmatic access
  pi.registerTool({
    name: "settings_panel",
    label: "Settings Panel",
    description: "View Equaxis settings. Use action=list-sections to list categories, or action=view with a section id.",
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: "Action: view, list-sections" })),
      section: Type.Optional(Type.String({ description: "Section ID to view" }))
    }),
    async execute(_toolCallId, params) {
      const cwd = commandCwd({});
      const layers = loadEquaxisConfigLayers(cwd) as unknown as SettingsLayer;
      const details: Record<string, unknown> = { action: params.action ?? "list" };
      let text: string;

      if (params.action === "view") {
        const section = params.section ? sectionMetadataById(params.section) : null;
        if (!section) {
          text = `Unknown section "${params.section ?? ""}". Available: ${CONFIG_SECTIONS.map((s) => s.id).join(", ")}`;
          details.error = "unknown section";
        } else {
          const keys = section.keys.map((key) => ({
            key: key.key,
            label: key.label,
            type: key.type,
            description: key.description,
            value: getAtPath(layers.effective, key.key),
            default: getAtPath(layers.defaults, key.key),
            source: sourceOf(layers, key.key)
          }));
          details.section = section.id;
          details.keys = keys;
          text = JSON.stringify(keys, null, 2);
        }
      } else {
        const sections = CONFIG_SECTIONS.map((s) => ({
          id: s.id,
          label: s.label,
          description: s.description,
          icon: s.icon,
          keyCount: s.keys.length
        }));
        details.sections = sections;
        text = JSON.stringify(sections, null, 2);
      }

      return {
        content: [{ type: "text" as const, text }],
        details
      };
    }
  });

  function formatSettingsText(layers: SettingsLayer, sectionId?: string, search?: string): string {
    const sections = sectionId
      ? CONFIG_SECTIONS.filter((s) => s.id === sectionId)
      : CONFIG_SECTIONS;

    if (search) {
      const query = search.toLowerCase();
      const hits = sections.flatMap((section) =>
        section.keys
          .filter((key) =>
            key.label.toLowerCase().includes(query) ||
            key.description.toLowerCase().includes(query) ||
            key.key.toLowerCase().includes(query)
          )
          .map((key) => `[${section.label}] ${key.label}: ${JSON.stringify(getAtPath(layers.effective, key.key))}`)
      );
      return hits.length ? hits.join("\n") : `No settings matching "${search}"`;
    }

    return sections
      .map((section) => {
        const keys = section.keys
          .map((key) => `  ${key.label}: ${JSON.stringify(getAtPath(layers.effective, key.key))} (${sourceOf(layers, key.key)})`)
          .join("\n");
        return `${section.icon} ${section.label}\n${keys}`;
      })
      .join("\n\n");
  }
}

/**
 * Full-screen settings viewer: scrollable, theme-rendered, with section navigation.
 */
class SettingsViewer {
  private offset = 0;
  private cachedWidth = -1;
  private cachedHeight = -1;
  private cachedLines: string[] = [];
  private selectedSection = 0;
  private readonly sections = CONFIG_SECTIONS;

  constructor(
    private readonly layers: SettingsLayer,
    private readonly theme: ExtensionContext["ui"]["theme"],
    private readonly done: () => void,
    private readonly requestRender: () => void,
    initialSection?: string,
    private readonly search?: string
  ) {
    if (initialSection) {
      const idx = this.sections.findIndex((s) => s.id === initialSection);
      if (idx >= 0) this.selectedSection = idx;
    }
  }

  handleInput(data: string): void {
    const total = this.cachedLines.length;
    if (data === "q" || data === "Q" || data === "\x1b") {
      this.done();
      return;
    }
    if (data === "up" || data === "k") this.offset = Math.max(0, this.offset - 1);
    else if (data === "down" || data === "j") this.offset = Math.min(Math.max(0, total - 1), this.offset + 1);
    else if (data === "pageUp") this.offset = Math.max(0, this.offset - 12);
    else if (data === "pageDown") this.offset = Math.min(Math.max(0, total - 1), this.offset + 12);
    else if (data === "home") this.offset = 0;
    else if (data === "end") this.offset = Math.max(0, total - 1);
    else if (data === "left" || data === "h") {
      this.selectedSection = Math.max(0, this.selectedSection - 1);
      this.offset = 0;
    } else if (data === "right" || data === "l") {
      this.selectedSection = Math.min(this.sections.length - 1, this.selectedSection + 1);
      this.offset = 0;
    }
    this.requestRender();
  }

  render(width: number): string[] {
    const kit = makeUiKit({ theme: this.theme });
    const section = this.sections[this.selectedSection];
    const lines = this.renderSection(section, kit);

    const height = Math.min(32, Math.max(10, lines.length + 6));

    if (this.cachedWidth === width && this.cachedHeight === height && this.cachedLines.length === lines.length) {
      return this.cachedLines;
    }

    const visibleRows = Math.max(1, height - 5);
    this.offset = Math.min(this.offset, Math.max(0, lines.length - visibleRows));
    const page = lines.slice(this.offset, this.offset + visibleRows);

    const sectionNav = this.sections
      .map((s, i) => (i === this.selectedSection ? `[${s.label}]` : s.label))
      .join(" │ ");

    const top = kit.paint("accent", kit.bold(`Equaxis Settings — ${section.label}`)) +
      "\n" + kit.paint("dim", "← → switch sections • ↑ ↓ scroll • Q/Esc close") +
      "\n" + kit.paint("dim", sectionNav);

    const bottom = kit.paint("dim", `rows ${lines.length === 0 ? 0 : this.offset + 1}-${this.offset + page.length} of ${lines.length}`);

    const out = [top, kit.paint("borderMuted", "─".repeat(Math.max(1, width))), ...page, kit.paint("borderMuted", "─".repeat(Math.max(1, width))), bottom];
    this.cachedWidth = width;
    this.cachedHeight = height;
    this.cachedLines = out.map((line) => truncateToWidth(line, Math.max(1, width)));
    return this.cachedLines;
  }

  private renderSection(section: (typeof CONFIG_SECTIONS)[number], kit: ReturnType<typeof makeUiKit>): string[] {
    const lines: string[] = [];
    lines.push(kit.paint("accent", kit.bold(`${section.icon} ${section.label}`)));
    lines.push(kit.paint("dim", section.description));
    lines.push("");

    const keys = this.search
      ? section.keys.filter((key) =>
          key.label.toLowerCase().includes(this.search!.toLowerCase()) ||
          key.description.toLowerCase().includes(this.search!.toLowerCase()) ||
          key.key.toLowerCase().includes(this.search!.toLowerCase())
        )
      : section.keys;

    if (keys.length === 0) {
      lines.push(kit.paint("dim", "No settings match your search."));
      return lines;
    }

    for (const key of keys) {
      const value = getAtPath(this.layers.effective, key.key);
      const defaultValue = getAtPath(this.layers.defaults, key.key);
      const source = sourceOf(this.layers, key.key);
      const valueStr = value !== undefined ? JSON.stringify(value) : "(default)";

      lines.push(kit.kv(key.label, valueStr));
      lines.push(kit.paint("dim", `  ${key.description}`));
      if (value !== undefined && value !== defaultValue) {
        lines.push(kit.paint("dim", `  default: ${JSON.stringify(defaultValue)}`));
      }
      lines.push(kit.paint("dim", `  Source: ${source} • Key: ${key.key}`));
      lines.push("");
    }
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = -1;
  }
}

function truncateToWidth(text: string, width: number): string {
  return text.length > width ? text.slice(0, width - 1) + "…" : text;
}
