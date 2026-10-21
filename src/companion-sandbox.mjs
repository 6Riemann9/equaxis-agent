import { execFile } from "node:child_process";
import path from "node:path";

/**
 * Companion sandbox: confine a teammate's Pi subprocess with bubblewrap.
 *
 * M1 model is a WRITE sandbox, not a read sandbox: the teammate's process can
 * read the system, HOME (provider credentials for Pi itself) and the project
 * tree, but every writable path except its own workspace, a private /tmp and
 * Pi's own state directory (~/.pi — settings lock files, session storage) is
 * gone. Full read isolation (per-teammate HOME with copied credentials,
 * network namespace) is deliberately deferred to M2: it must not silently
 * break provider auth, which would turn every task into a confusing failure.
 */

/** Resolve the bwrap binary path; null when unavailable (non-Linux, missing). */
export function detectBwrap(execFileImpl = execFile) {
  return new Promise((resolve) => {
    if (process.platform !== "linux") return resolve(null);
    execFileImpl("bwrap", ["--version"], (error, stdout) => {
      resolve(error ? null : `bwrap ${String(stdout).trim()}`);
    });
  });
}

/**
 * Build the bwrap argument vector that runs `command args` confined.
 *
 * Two HOME models:
 *
 *  - shared (default): real HOME is read-only except `~/.pi` (Pi's own lock
 *    files and session storage). The teammate can read all of HOME.
 *
 *  - isolated (`homeDir` given): the teammate gets a private HOME, fully
 *    writable, containing nothing but a fresh `.pi/agent` seeded from the
 *    real one with ONLY the credential/config files re-bound read-only
 *    (auth.json, models.json, settings.json). The real HOME is not visible
 *    at all. This is the M2 read-write isolation.
 *
 * Both models keep the system read-only, give the teammate a private tmpfs
 * /tmp, and re-bind the teammate's workspace writable on top of the
 * read-only project root.
 */
export function buildBwrapArgs({ workspace, projectRoot, home = process.env.HOME, homeDir = null }) {
  if (!workspace) throw new Error("buildBwrapArgs: workspace is required");
  if (!projectRoot) throw new Error("buildBwrapArgs: projectRoot is required");
  const args = [
    "--ro-bind", "/usr", "/usr",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/sbin", "/sbin",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind-try", "/etc/hosts", "/etc/hosts",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--unshare-ipc",
    "--die-with-parent",
    "--new-session"
  ];
  if (homeDir) {
    // Isolated HOME: writable, empty except the seeded Pi credential files.
    // Bind order matters: the project root goes read-only FIRST, then the
    // (deeper, inside-project) private HOME is re-bound writable on top,
    // then the workspace last. A later bind always shadows an earlier one.
    const projectRootAbs = path.resolve(projectRoot);
    args.push("--ro-bind", projectRootAbs, projectRootAbs);
    const homeDirAbs = path.resolve(homeDir);
    args.push("--bind", homeDirAbs, homeDirAbs);
    const agentDir = path.join(homeDirAbs, ".pi", "agent");
    for (const file of ["auth.json", "models.json", "settings.json"]) {
      const source = home ? path.join(home, ".pi", "agent", file) : null;
      if (source) args.push("--ro-bind-try", source, path.join(agentDir, file));
    }
  } else {
    if (home) {
      args.push("--ro-bind", home, home);
      // Pi writes its own state (settings lock files, session storage) under
      // ~/.pi even in read-only workflows; keeping it writable is required
      // for provider auth to load at all. Everything else under HOME stays ro.
      const piDir = path.join(home, ".pi");
      args.push("--bind", piDir, piDir);
    }
    args.push("--ro-bind", path.resolve(projectRoot), path.resolve(projectRoot));
  }
  // The workspace is inside the (read-only) project root; re-bind it writable.
  args.push("--bind", path.resolve(workspace), path.resolve(workspace));
  return args;
}

/**
 * Wrap a spawn implementation so every child runs under bwrap.
 * The returned function has the (command, args, options) signature that
 * spawnTracked passes through to the subagent executor.
 */
export function createBwrapSpawnWrapper({ bwrapPath = "bwrap", workspace, projectRoot, home, homeDir, spawnImpl }) {
  if (typeof spawnImpl !== "function") throw new Error("createBwrapSpawnWrapper: spawnImpl is required");
  const bwrapArgs = buildBwrapArgs({ workspace, projectRoot, home, homeDir });
  return function bwrapSpawn(command, args, options) {
    return spawnImpl(bwrapPath, [...bwrapArgs, "--", command, ...(args ?? [])], options);
  };
}
