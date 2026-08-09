const ANSI = Object.freeze({
  cyan: "\u001b[38;5;45m",
  gold: "\u001b[38;5;220m",
  muted: "\u001b[38;5;245m",
  reset: "\u001b[0m"
});

const MARK = [
  "                              _     ",
  "   ___  __ _ _   _  __ ___  *(*)___ ",
  "  / _ \\/ _` | | | |/ _` \\ \\/ / / __|",
  " |  __/ (*| | |*| | (_| |>  <| \\__ \\",
  "  \\___|\\__, |\\__,*|\\_\\_,*/_/_\\_|___/",
  "          |_|                       "
];

export function shouldShowBanner({
  isTTY = process.stdout.isTTY,
  args = process.argv.slice(2)
} = {}) {
  if (!isTTY) return false;
  if (args.includes("--mode") && args[args.indexOf("--mode") + 1] === "json") return false;
  if (args.some((arg) => arg === "--mode=json")) return false;
  return !args.includes("--no-banner");
}

export function formatEquaxisBanner({ color = true } = {}) {
  const paint = color
    ? (value, tone) => `${ANSI[tone]}${value}${ANSI.reset}`
    : (value) => value;

  const lines = MARK.map((line, index) => paint(line, index === 3 ? "gold" : "cyan"));
  lines.push("");
  lines.push(paint("reliable agent runtime", "muted"));
  return `${lines.join("\n")}\n`;
}
