import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { matchesKey } from "@earendil-works/pi-tui";
import { CONFIG_SECTIONS, getAtPath, sectionMetadataById } from "../../src/config-sections.mjs";
import { loadEquaxisConfigLayers } from "../../src/equaxis-config.mjs";
import { makeUiKit } from "../../src/ui-kit.mjs";

interface SettingsLayer {
  global?: Record<string, unknown>;
  project?: Record<string, unknown>;
  effective: Record<string, unknown>;
  defaults: Record<string, unknown>;
}

interface SettingsKeyMeta {
  key: string;
  path?: string;
  file?: string;
  label?: string;
  type?: string;
  options?: string[];
  description?: string;
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

/** Full dot-path for a key, mirroring config-edit view normalization. */
function keyPath(section: { id: string; file: string }, key: SettingsKeyMeta): string {
  if (key.path) return key.path;
  const file = key.file ?? section.file;
  if (file === "settings") return key.key;
  return key.key.includes(".") ? key.key : `${section.id}.${key.key}`;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Persist a key to the project layer through config-edit.mjs, which reuses
 * the same merge + validate + write path as the CLI and pi-web API.
 * Returns an error string on failure, or null on success.
 */
function persistKey(cwd: string, key: string, value: unknown | null): string | null {
  const args = value === null
    ? ["unset", "--cwd", cwd, "--layer", "project", "--key", key]
    : ["set", "--cwd", cwd, "--layer", "project", "--key", key, "--value", JSON.stringify(value)];
  const result = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "config-edit.mjs"), ...args], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    return (result.stderr ?? result.stdout ?? "").trim() || `config-edit exited ${result.status}`;
  }
  return null;
}

export default function settingsPanelExtension(pi: ExtensionAPI) {
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
          keys: section.keys.map((key) => {
            const meta = key as SettingsKeyMeta;
            return {
              key: meta.key,
              path: keyPath(section, meta),
              file: meta.file ?? section.file,
              label: meta.label,
              type: meta.type,
              description: meta.description,
              value: getAtPath(layers.effective, keyPath(section, meta)),
              default: getAtPath(layers.defaults, keyPath(section, meta))
            };
          })
        }));
        ctx.ui.notify(JSON.stringify(sections, null, 2), "info");
        return;
      }

      if (ctx.mode === "tui") {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          return new SettingsViewer(layers, theme, done, () => tui.requestRender(), ctx.ui, sectionArg, searchArg);
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
          const keys = section.keys.map((key) => {
            const meta = key as SettingsKeyMeta;
            const path = keyPath(section, meta);
            return {
              key: meta.key,
              path,
              file: meta.file ?? section.file,
              label: meta.label,
              type: meta.type,
              description: meta.description,
              value: getAtPath(layers.effective, path),
              default: getAtPath(layers.defaults, path),
              source: sourceOf(layers, path)
            };
          });
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
            (key.label ?? key.key).toLowerCase().includes(query) ||
            (key.description ?? "").toLowerCase().includes(query) ||
            key.key.toLowerCase().includes(query)
          )
          .map((key) => `[${section.label}] ${key.label ?? key.key}: ${JSON.stringify(getAtPath(layers.effective, keyPath(section, key as SettingsKeyMeta)))}`)
      );
      return hits.length ? hits.join("\n") : `No settings matching "${search}"`;
    }

    return sections
      .map((section) => {
        const keys = section.keys
          .map((key) => {
            const meta = key as SettingsKeyMeta;
            const path = keyPath(section, meta);
            return `  ${meta.label ?? meta.key}: ${JSON.stringify(getAtPath(layers.effective, path))} (${sourceOf(layers, path)})`;
          })
          .join("\n");
        return `${section.icon} ${section.label}\n${keys}`;
      })
      .join("\n\n");
  }
}

/**
 * Full-screen settings viewer with inline editing:
 * ↑↓ select a key, Enter edit, ←→ switch section, q/Esc close.
 * Booleans toggle on Enter; enums cycle their options; other types open the
 * built-in editor. Saving persists to the project layer via config-edit.mjs.
 */
class SettingsViewer {
  private offset = 0;
  private selectedIndex = 0;
  private editing = false;
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
    private readonly ui: ExtensionContext["ui"],
    initialSection?: string,
    private readonly search?: string
  ) {
    if (initialSection) {
      const idx = this.sections.findIndex((s) => s.id === initialSection);
      if (idx >= 0) this.selectedSection = idx;
    }
  }

  private visibleKeys(section: (typeof CONFIG_SECTIONS)[number]): SettingsKeyMeta[] {
    const all = section.keys.map((key) => key as SettingsKeyMeta);
    if (!this.search) return all;
    const query = this.search.toLowerCase();
    return all.filter((key) =>
      (key.label ?? key.key).toLowerCase().includes(query) ||
      (key.description ?? "").toLowerCase().includes(query) ||
      key.key.toLowerCase().includes(query)
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.done();
      return;
    }
    if (this.editing) return; // awaiting the editor result

    if (matchesKey(data, "enter")) {
      void this.beginEdit();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      const keys = this.visibleKeys(this.sections[this.selectedSection]);
      this.selectedIndex = Math.max(0, Math.min(keys.length - 1, this.selectedIndex - 1));
    } else if (matchesKey(data, "down") || data === "j") {
      const keys = this.visibleKeys(this.sections[this.selectedSection]);
      this.selectedIndex = Math.max(0, Math.min(keys.length - 1, this.selectedIndex + 1));
    } else if (matchesKey(data, "left") || data === "h") {
      this.selectedSection = Math.max(0, this.selectedSection - 1);
      this.selectedIndex = 0;
      this.offset = 0;
    } else if (matchesKey(data, "right") || data === "l") {
      this.selectedSection = Math.min(this.sections.length - 1, this.selectedSection + 1);
      this.selectedIndex = 0;
      this.offset = 0;
    } else if (matchesKey(data, "pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 8);
    } else if (matchesKey(data, "pageDown")) {
      const keys = this.visibleKeys(this.sections[this.selectedSection]);
      this.selectedIndex = Math.max(0, Math.min(keys.length - 1, this.selectedIndex + 8));
    } else if (matchesKey(data, "home")) {
      this.selectedIndex = 0;
    } else if (matchesKey(data, "end")) {
      this.selectedIndex = Math.max(0, this.visibleKeys(this.sections[this.selectedSection]).length - 1);
    }
    this.requestRender();
  }

  private async beginEdit(): Promise<void> {
    const section = this.sections[this.selectedSection];
    const keys = this.visibleKeys(section);
    const meta = keys[this.selectedIndex];
    if (!meta) return;
    const path = keyPath(section, meta);
    const file = meta.file ?? section.file;

    if (file === "settings") {
      this.ui.notify(`${meta.label ?? meta.key} is managed in .pi/settings.json — edit it directly or use /settings --json`, "info");
      return;
    }

    const current = getAtPath(this.layers.effective, path);

    if (meta.type === "boolean") {
      const next = !Boolean(current);
      this.save(path, next, meta.label ?? meta.key);
      return;
    }

    if (meta.type === "enum" && meta.options && meta.options.length > 0) {
      const idx = meta.options.indexOf(String(current));
      const next = meta.options[(idx + 1) % meta.options.length];
      this.save(path, next, meta.label ?? meta.key);
      return;
    }

    // Text, number, array, or object: use the built-in editor.
    this.editing = true;
    const prefill = current === undefined ? "" : JSON.stringify(current);
    const result = await this.ui.editor(`Edit ${meta.label ?? meta.key} (${path})`, prefill);
    this.editing = false;
    if (result !== undefined) {
      const trimmed = result.trim();
      if (trimmed === "") {
        this.save(path, null, meta.label ?? meta.key);
      } else {
        let parsed: unknown = trimmed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // keep as plain string
        }
        this.save(path, parsed, meta.label ?? meta.key);
      }
    }
    this.requestRender();
  }

  private save(path: string, value: unknown | null, label: string): void {
    const cwd = commandCwd({});
    const error = persistKey(cwd, path, value);
    if (error) {
      this.ui.notify(`Failed to save ${label}: ${error}`, "error");
    } else {
      this.ui.notify(`${label} ${value === null ? "reset" : `set to ${JSON.stringify(value)}`} (project)`, "info");
    }
    this.requestRender();
  }

  render(width: number): string[] {
    const kit = makeUiKit({ theme: this.theme });
    const section = this.sections[this.selectedSection];
    const keys = this.visibleKeys(section);
    const lines = this.renderSection(section, keys, kit);

    const height = Math.min(32, Math.max(10, lines.length + 6));

    if (this.cachedWidth === width && this.cachedHeight === height && this.cachedLines.length === lines.length) {
      return this.cachedLines;
    }

    const visibleRows = Math.max(1, height - 5);
    const itemOffset = this.selectedIndex >= visibleRows ? this.selectedIndex - visibleRows + 1 : this.offset;
    const page = lines.slice(itemOffset, itemOffset + visibleRows);
    this.offset = itemOffset;

    const sectionNav = this.sections
      .map((s, i) => (i === this.selectedSection ? `[${s.label}]` : s.label))
      .join(" │ ");

    const top = kit.paint("accent", kit.bold(`Equaxis Settings — ${section.label}`)) +
      "\n" + kit.paint("dim", "↑ ↓ select • Enter edit • ← → section • Q/Esc close") +
      "\n" + kit.paint("dim", sectionNav);

    const bottom = kit.paint("dim", `key ${this.selectedIndex + 1} of ${keys.length} • rows ${page.length ? itemOffset + 1 : 0}-${itemOffset + page.length}`);

    const out = [top, kit.paint("borderMuted", "─".repeat(Math.max(1, width))), ...page, kit.paint("borderMuted", "─".repeat(Math.max(1, width))), bottom];
    this.cachedWidth = width;
    this.cachedHeight = height;
    this.cachedLines = out.map((line) => truncateToWidth(line, Math.max(1, width)));
    return this.cachedLines;
  }

  private renderSection(
    section: (typeof CONFIG_SECTIONS)[number],
    keys: SettingsKeyMeta[],
    kit: ReturnType<typeof makeUiKit>
  ): string[] {
    const lines: string[] = [];
    lines.push(kit.paint("accent", kit.bold(`${section.icon} ${section.label}`)));
    lines.push(kit.paint("dim", section.description));
    lines.push("");

    if (keys.length === 0) {
      lines.push(kit.paint("dim", "No settings match your search."));
      return lines;
    }

    keys.forEach((meta, index) => {
      const path = keyPath(section, meta);
      const file = meta.file ?? section.file;
      const value = getAtPath(this.layers.effective, path);
      const defaultValue = getAtPath(this.layers.defaults, path);
      const source = sourceOf(this.layers, path);
      const valueStr = value !== undefined ? JSON.stringify(value) : "(default)";
      const marker = index === this.selectedIndex ? "› " : "  ";
      const readOnly = file === "settings" ? " [settings.json]" : "";

      lines.push(kit.paint("accent", kit.bold(`${marker}${meta.label ?? meta.key}`)) + kit.kv("", valueStr) + kit.paint("dim", readOnly));
      lines.push(kit.paint("dim", `    ${meta.description ?? ""}`));
      if (value !== undefined && value !== defaultValue) {
        lines.push(kit.paint("dim", `    default: ${JSON.stringify(defaultValue)}`));
      }
      lines.push(kit.paint("dim", `    Source: ${source} • ${path}`));
      lines.push("");
    });
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = -1;
  }
}

function truncateToWidth(text: string, width: number): string {
  return text.length > width ? text.slice(0, width - 1) + "…" : text;
}
