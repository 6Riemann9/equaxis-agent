/**
 * Parse a human duration into milliseconds: "30m", "2h", "1d", "90s", or a
 * bare number of milliseconds. Returns NaN for anything else.
 *
 * Kept dependency-free and pure so the CLI and tests share one parser.
 */

const UNITS = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
};

export function parseDurationMs(input) {
  const match = String(input ?? "").trim().match(/^(\d+(?:\.\d+)?)([smhd]?)$/i);
  if (!match) return NaN;
  const value = Number(match[1]);
  const unit = (match[2] || "ms").toLowerCase();
  if (unit === "ms") return value;
  return Math.round(value * UNITS[unit]);
}
