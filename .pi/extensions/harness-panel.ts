import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

type Level = "info" | "warn" | "error" | "ok";

type FlowEvent = {
	seq: number;
	time: string;
	phase: string;
	detail: string;
	level: Level;
};

const MAX_EVENTS = 240;

export default function harnessPanelExtension(pi: ExtensionAPI) {
	let visible = true;
	let seq = 0;
	let events: FlowEvent[] = [];

	function add(ctx: ExtensionContext, phase: string, detail = "", level: Level = "info") {
		events.push({
			seq: ++seq,
			time: clock(),
			phase,
			detail: compact(detail),
			level,
		});
		if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
		render(ctx);
	}

	function render(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		const last = events[events.length - 1];
		const theme = ctx.ui.theme;
		const status = last
			? `${levelMarker(last.level)} harness ${last.phase}`
			: "harness ready";
		ctx.ui.setStatus("harness-flow", theme.fg(last?.level === "error" ? "error" : last?.level === "warn" ? "warning" : "accent", status));

		if (!visible) {
			ctx.ui.setWidget("harness-flow", undefined);
			return;
		}

		const snapshot = [...events];
		ctx.ui.setWidget(
			"harness-flow",
			(_tui, theme) => ({
				invalidate() {},
				render(width: number) {
					const header = theme.fg("accent", theme.bold("Harness Flow")) + theme.fg("dim", "  /harness-panel toggle · /harness-clear clear");
					const lines = [header, theme.fg("borderMuted", "─".repeat(Math.max(1, width)))];
					for (const event of snapshot.slice(-12)) {
						const marker = colorMarker(theme, event.level);
						const id = theme.fg("dim", `${String(event.seq).padStart(3, "0")} ${event.time}`);
						const phase = theme.fg(event.level === "warn" ? "warning" : event.level === "error" ? "error" : "toolTitle", event.phase.padEnd(24, " "));
						const detail = event.detail ? theme.fg("muted", event.detail) : "";
						lines.push(`${marker} ${id} ${phase} ${detail}`);
					}
					return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
				},
			}),
			{ placement: "belowEditor" },
		);
	}

	pi.registerCommand("harness-flow", {
		description: "Open the full Harness Flow event viewer",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Harness Flow viewer requires interactive TUI mode", "error");
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				return new FlowViewer(() => events, theme, done, () => tui.requestRender());
			});
		},
	});

	pi.registerCommand("harness-panel", {
		description: "Toggle the compact Harness Flow observation panel",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "show" || action === "on") visible = true;
			else if (action === "hide" || action === "off") visible = false;
			else visible = !visible;
			render(ctx);
			ctx.ui.notify(`Harness panel ${visible ? "shown" : "hidden"}`, "info");
		},
	});

	pi.registerCommand("harness-clear", {
		description: "Clear the Harness Flow observation panel",
		handler: async (_args, ctx) => {
			events = [];
			render(ctx);
			ctx.ui.notify("Harness panel cleared", "info");
		},
	});

	pi.on("project_trust", async (event, _ctx) => {
		// Project-local extensions load after trust, so this is mainly useful if copied globally.
		events.push({ seq: ++seq, time: clock(), phase: "project_trust", detail: compact(event.cwd), level: "info" });
		if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
		return { trusted: "undecided" };
	});

	pi.on("session_start", async (event, ctx) => add(ctx, "session_start", event.reason, "ok"));
	pi.on("resources_discover", async (event, ctx) => add(ctx, "resources_discover", event.reason));
	pi.on("session_shutdown", async (event, ctx) => add(ctx, "session_shutdown", event.reason));
	pi.on("session_before_switch", async (event, ctx) => add(ctx, "session_before_switch", event.reason, "warn"));
	pi.on("session_before_fork", async (event, ctx) => add(ctx, "session_before_fork", event.entryId, "warn"));
	pi.on("session_before_compact", async (event, ctx) => add(ctx, "session_before_compact", event.reason, "warn"));
	pi.on("session_compact", async (event, ctx) => add(ctx, "session_compact", event.reason, "ok"));
	pi.on("session_tree", async (_event, ctx) => add(ctx, "session_tree", "branch navigation", "ok"));

	pi.on("input", async (event, ctx) => add(ctx, "input", `${event.source}: ${compact(event.text, 96)}`));
	pi.on("before_agent_start", async (event, ctx) => add(ctx, "before_agent_start", compact(event.prompt, 96)));
	pi.on("agent_start", async (_event, ctx) => add(ctx, "agent_start"));
	pi.on("agent_end", async (_event, ctx) => add(ctx, "agent_end", "model turn finished", "ok"));
	pi.on("agent_settled", async (_event, ctx) => add(ctx, "agent_settled", "idle", "ok"));
	pi.on("turn_start", async (event, ctx) => add(ctx, "turn_start", `turn ${event.turnIndex}`));
	pi.on("turn_end", async (event, ctx) => add(ctx, "turn_end", `turn ${event.turnIndex}`, "ok"));
	pi.on("context", async (event, ctx) => add(ctx, "context", `${event.messages.length} messages`));

	pi.on("before_provider_headers", async (_event, ctx) => add(ctx, "provider_headers", "headers prepared"));
	pi.on("before_provider_request", async (event, ctx) => add(ctx, "provider_request", payloadSummary(event.payload)));
	pi.on("after_provider_response", async (event, ctx) => add(ctx, "provider_response", `status ${event.status}`, event.status >= 400 ? "error" : "ok"));

	pi.on("message_start", async (event, ctx) => add(ctx, "message_start", messageSummary(event)));
	pi.on("message_end", async (event, ctx) => add(ctx, "message_end", messageSummary(event), "ok"));
	pi.on("tool_execution_start", async (event, ctx) => add(ctx, "tool_exec_start", `${event.toolName} ${compact(JSON.stringify(event.args), 80)}`));
	pi.on("tool_call", async (event, ctx) => {
		const risk = riskSummary(event.toolName, event.input);
		add(ctx, risk ? "tool_call_risk" : "tool_call", `${event.toolName}${risk ? `: ${risk}` : ""}`, risk ? "warn" : "info");
	});
	pi.on("tool_result", async (event, ctx) => add(ctx, "tool_result", `${event.toolName}${event.isError ? " error" : " ok"}`, event.isError ? "error" : "ok"));
	pi.on("tool_execution_end", async (event, ctx) => add(ctx, "tool_exec_end", `${event.toolName}${event.isError ? " error" : " ok"}`, event.isError ? "error" : "ok"));

	pi.on("model_select", async (event, ctx) => add(ctx, "model_select", `${event.model.provider}/${event.model.id}`));
	pi.on("thinking_level_select", async (event, ctx) => add(ctx, "thinking_select", event.level));
}

class FlowViewer {
	private offset = 0;
	private cachedWidth = -1;
	private cachedHeight = -1;
	private cachedCount = -1;
	private cachedOffset = -1;
	private cachedLines: string[] = [];

	constructor(
		private readonly getEvents: () => FlowEvent[],
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly done: () => void,
		private readonly requestRender: () => void,
	) {}

	handleInput(data: string): void {
		const total = this.getEvents().length;
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.done();
			return;
		}
		if (matchesKey(data, "up") || data === "k") this.offset = Math.max(0, this.offset - 1);
		else if (matchesKey(data, "down") || data === "j") this.offset = Math.min(Math.max(0, total - 1), this.offset + 1);
		else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - 10);
		else if (matchesKey(data, "pageDown")) this.offset = Math.min(Math.max(0, total - 1), this.offset + 10);
		else if (matchesKey(data, "home")) this.offset = 0;
		else if (matchesKey(data, "end")) this.offset = Math.max(0, total - 1);
		this.invalidate();
		this.requestRender();
	}

	render(width: number): string[] {
		const events = this.getEvents();
		const height = Math.min(28, Math.max(8, events.length + 5));
		if (
			this.cachedWidth === width &&
			this.cachedHeight === height &&
			this.cachedCount === events.length &&
			this.cachedOffset === this.offset
		) {
			return this.cachedLines;
		}

		const visibleRows = Math.max(1, height - 4);
		this.offset = Math.min(this.offset, Math.max(0, events.length - visibleRows));
		const page = events.slice(this.offset, this.offset + visibleRows);
		const top = this.theme.fg("accent", this.theme.bold("Harness Flow - Full Timeline"));
		const hint = this.theme.fg("dim", "  Up/Down PgUp/PgDn Home/End scroll | Q/Esc close");
		const lines = [top + hint];
		lines.push(this.theme.fg("dim", `events ${events.length}  showing ${events.length === 0 ? 0 : this.offset + 1}-${this.offset + page.length}`));
		lines.push(this.theme.fg("dim", "-".repeat(Math.max(1, width))));

		for (const event of page) {
			const marker = colorMarker(this.theme, event.level);
			const id = this.theme.fg("dim", `${String(event.seq).padStart(3, "0")} ${event.time}`);
			const phase = this.theme.fg(event.level === "warn" ? "warning" : event.level === "error" ? "error" : "toolTitle", event.phase.padEnd(24, " "));
			const detail = event.detail ? this.theme.fg("muted", event.detail) : "";
			lines.push(`${marker} ${id} ${phase} ${detail}`);
		}

		if (page.length === 0) lines.push(this.theme.fg("dim", "No harness events yet."));
		lines.push(this.theme.fg("dim", "-".repeat(Math.max(1, width))));

		this.cachedWidth = width;
		this.cachedHeight = height;
		this.cachedCount = events.length;
		this.cachedOffset = this.offset;
		this.cachedLines = lines.map((line) => truncateToWidth(line, Math.max(1, width)));
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = -1;
	}
}

function clock(): string {
	return new Date().toISOString().slice(11, 19);
}

function compact(value: unknown, max = 140): string {
	const text = typeof value === "string" ? value : safeJson(value);
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}...` : oneLine;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function payloadSummary(payload: unknown): string {
	if (!payload || typeof payload !== "object") return typeof payload;
	const keys = Object.keys(payload as Record<string, unknown>).slice(0, 8);
	return `payload keys: ${keys.join(", ")}`;
}

function messageSummary(event: { message?: { role?: string; customType?: string } }): string {
	const role = event.message?.role ?? "unknown";
	const custom = event.message?.customType ? `:${event.message.customType}` : "";
	return `${role}${custom}`;
}

function riskSummary(toolName: string, input: unknown): string | undefined {
	if (toolName === "bash" && input && typeof input === "object") {
		const command = (input as { command?: unknown }).command;
		if (typeof command !== "string") return undefined;
		if (/\brm\s+(-rf?|--recursive)\b/i.test(command)) return "recursive delete";
		if (/\bsudo\b/i.test(command)) return "sudo command";
		if (/\bgit\s+reset\s+--hard\b/i.test(command)) return "hard reset";
		if (/\bchmod\b.*\b777\b/i.test(command)) return "wide permission change";
	}
	if ((toolName === "write" || toolName === "edit") && input && typeof input === "object") {
		const path = (input as { path?: unknown }).path;
		if (typeof path === "string" && /(^|[\\/])\.env(\.|$)?/.test(path)) return "secret-like path";
	}
	return undefined;
}

function levelMarker(level: Level): string {
	if (level === "ok") return "ok";
	if (level === "warn") return "warn";
	if (level === "error") return "error";
	return "info";
}

function colorMarker(theme: ExtensionContext["ui"]["theme"], level: Level): string {
	if (level === "ok") return theme.fg("success", "✓");
	if (level === "warn") return theme.fg("warning", "!");
	if (level === "error") return theme.fg("error", "✗");
	return theme.fg("accent", "›");
}
