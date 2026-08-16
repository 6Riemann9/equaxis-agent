// Unified terminal styling for Equaxis (CLI text output + Pi TUI full-screen
// dashboard). One small kit keeps color semantics in a single place: paint by
// semantic name, render either through ANSI 256-color codes, raw text, or the
// Pi theme (fg/bold) supplied by the TUI runtime.
//
// NOTE: reconstructed from tests/ui-kit.test.mjs after an untracked working-
// tree file was lost to an external src/ wipe; contract identical, internals
// regenerated.

export const STATUS_SYMBOLS = Object.freeze({ ok: "✓", warn: "!", error: "✗", info: "›" });

/** Semantic color names shared by the ANSI backend and the Pi theme. */
export const SEMANTIC_COLORS = Object.freeze([
  "accent", "success", "warning", "error", "info", "dim", "borderMuted"
]);

// ANSI 256-color palette for xterm-256color terminals.
const ANSI_256 = Object.freeze({
  accent: 39, success: 118, warning: 214, error: 196, info: 45, dim: 240, borderMuted: 245
});

function symbolFor(level) {
  return STATUS_SYMBOLS[String(level ?? "")] ?? STATUS_SYMBOLS.info;
}

function colorFor(level) {
  return level === "ok" ? "success" : level === "warn" ? "warning" : level === "error" ? "error" : "info";
}

/**
 * Build a UI kit.
 * @param {{ color?: boolean, theme?: object | null }} [options] color = ANSI
 *   256-color output (default true); theme = optional Pi TUI theme (fg/bold)
 *   that takes precedence over ANSI when provided.
 */
export function makeUiKit({ color = true, theme = null } = {}) {
  const ansi = (name, text) => `\x1b[38;5;${ANSI_256[name] ?? ANSI_256.info}m${text}\x1b[0m`;
  const paint = (name, text) => {
    if (theme) return theme.fg(name, text);
    return color ? ansi(name, text) : String(text);
  };
  return {
    colored: color,
    theme: theme ?? null,
    paint,
    bold: (text) => (theme ? theme.bold(text) : color ? `\x1b[1m${text}\x1b[0m` : String(text)),
    section: (title) => paint("accent", `── ${title}`),
    badge: (label, level) => paint(colorFor(level), `[ ${label} ]`),
    status: (level, text) => `${paint(colorFor(level), symbolFor(level))} ${text}`,
    symbol: symbolFor,
    kv: (key, value) => `${String(key).padEnd(12)}${value}`,
    rule: (char, width) => String(char).repeat(Math.max(0, Number(width) || 0)),
    onOff: (enabled) => `[ ${enabled ? "ON" : "OFF"} ]`,
    healthBadge: (ok) => `[ ${ok ? "READY" : "FAIL"} ]`
  };
}

/** Convenience factory: ansiKit(colored) -> makeUiKit({ color: colored }). */
export function ansiKit(colored) {
  return makeUiKit({ color: Boolean(colored) });
}
