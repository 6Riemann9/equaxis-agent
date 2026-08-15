// Deterministic shell command allowlist (roadmap P0: restricted shell).
// A bash call is classified LOW only when its leading token is a known
// read-only command (or a safe git subcommand). Anything unrecognized
// defaults to MEDIUM so unknown executables are audited and counted
// instead of silently passing as read-only.

const READ_COMMANDS = new Set([
  "ls", "dir", "cat", "type", "head", "tail", "wc", "grep", "rg", "find",
  "where", "which", "sort", "uniq", "cut", "tr", "awk", "sed", "echo", "printf",
  "pwd", "cd", "date", "env", "stat", "file", "du", "df", "free", "basename",
  "dirname", "realpath", "readlink", "expr", "test", "[", "true", "false",
  "node", "npm", "npx", "pnpm", "yarn", "bun", "python", "python3", "pip", "pip3", "tsc"
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files",
  "ls-tree", "describe", "shortlog", "blame", "grep"
]);

/**
 * Read-only forms of git subcommands that also have mutating variants:
 * branch/tag without -d/-D, remote without add/remove/set-url/rename,
 * config limited to --list/--get/--get-all.
 */
function isReadOnlyGit(command) {
  const parts = String(command ?? "").trim().split(/\s+/);
  const sub = (parts[1] ?? "").replace(/^["']|["']$/g, "").toLowerCase();
  const rest = parts.slice(2);
  const joined = rest.join(" ");
  if (sub === "branch" || sub === "tag") return !/-[a-zA-Z]*d/i.test(joined);
  if (sub === "remote") return !rest.some((part) => /^(add|remove|rm|set-url|rename)$/i.test(part));
  if (sub === "config") {
    return rest.length <= 1 || rest.some((part) => part === "--list" || part === "--get" || part === "--get-all");
  }
  return false;
}

/**
 * Extract the leading executable token, normalized to a bare command name.
 * Handles quotes, parentheses, and absolute/relative paths.
 */
export function leadingCommandToken(command) {
  const trimmed = String(command ?? "").trim().replace(/^\s*\(?\s*/, "");
  if (!trimmed) return null;
  let first;
  const quoted = trimmed.match(/^(["'])(.*?)\1/);
  if (quoted) first = quoted[2];
  else first = trimmed.split(/\s+/)[0] ?? "";
  const token = first.replace(/^["']|["']$/g, "");
  if (token.includes("/") || token.includes("\\")) return (token.split(/[\\/]/).pop() ?? token).toLowerCase();
  return token.toLowerCase();
}

/** True when the command's leading token is a known safe read-only command. */
export function isAllowlistedCommand(command, extraCommands = []) {
  // Chained commands (&& || ; |) are not auto-allowlisted: a safe prefix could
  // hide an unsafe suffix. They default to MEDIUM and are audited.
  if (/&&|\|\||[;|]/.test(String(command ?? ""))) return false;
  const token = leadingCommandToken(command);
  if (!token) return false;
  if (READ_COMMANDS.has(token)) return true;
  if (Array.isArray(extraCommands) && extraCommands.some((name) => String(name).toLowerCase() === token)) return true;
  if (token === "git") {
    const parts = String(command ?? "").trim().split(/\s+/);
    const sub = (parts[1] ?? "").replace(/^["']|["']$/g, "").toLowerCase();
    // bare `git` prints help; only read-only subcommands are safe (`git stash` alone
    // mutates and is therefore not allowlisted; branch -D / tag -d / remote remove /
    // config writes fall through to MEDIUM and are audited).
    if (!sub || SAFE_GIT_SUBCOMMANDS.has(sub)) return true;
    if (isReadOnlyGit(command)) return true;
  }
  return false;
}