// Deterministic shell command allowlist (roadmap P0: restricted shell).
// A bash call is classified LOW only when its leading token is a known
// read-only command (or a safe git subcommand). Anything unrecognized
// defaults to MEDIUM so unknown executables are audited and counted
// instead of silently passing as read-only.

const READ_COMMANDS = new Set([
  "ls", "dir", "cat", "type", "head", "tail", "wc", "grep", "rg",
  "where", "which", "uniq", "cut", "tr", "echo", "printf",
  "pwd", "cd", "date", "stat", "file", "du", "df", "free", "basename",
  "dirname", "realpath", "readlink", "expr", "test", "[", "true", "false"
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

/** `find` is read-only unless it uses -delete, -exec, -execdir, -ok, -okdir, -fprint*, or output redirects. */
function isReadOnlyFind(command) {
  const args = String(command ?? "").trim();
  return !/-delete\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint\b/.test(args);
}

/** `sort` is read-only unless -o/--output is present (which writes to a file). */
function isReadOnlySort(command) {
  const args = String(command ?? "").trim();
  return !/(?:^|\s)-(?:o\b|-output\b)/.test(args);
}

/**
 * Detect shell metacharacters that imply execution of arbitrary sub-commands
 * or output redirection, making the command unsafe to classify as read-only.
 * Covers: &&, ||, ;, |, newline, backtick, $(), <(), >, >>
 */
const CHAIN_OR_REDIRECT_RE = /&&|\|\||[;|]|\n|`|\$\(|<\(|[^0-9&]>>(?!&)|[^0-9&]>(?!&)/;

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
  // Chained commands, redirects, and shell metacharacters are not auto-allowlisted:
  // a safe prefix could hide an unsafe suffix or write to a file. They default to
  // MEDIUM and are audited.
  if (CHAIN_OR_REDIRECT_RE.test(String(command ?? ""))) return false;
  const token = leadingCommandToken(command);
  if (!token) return false;
  if (READ_COMMANDS.has(token)) return true;
  // Commands with mutating variants: only allowlisted in their read-only forms.
  if (token === "find" && isReadOnlyFind(command)) return true;
  if (token === "sort" && isReadOnlySort(command)) return true;
  // `env` without arguments prints the environment (read-only);
  // `env VAR=val cmd` or `env cmd args` executes a command — not read-only.
  if (token === "env" && String(command ?? "").trim().split(/\s+/).length <= 1) return true;
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