/**
 * Pluggable teammate execution backends: directory → bwrap → container →
 * microvm, ordered by isolation strength.
 *
 * The point of the registry is honesty: every tier declares how it is
 * detected and what it needs, so a requested-but-unavailable backend fails
 * loudly with the reason instead of silently degrading. Only `auto` is
 * allowed to fall back, and it always reports which tier it chose and why.
 *
 *   directory — the pre-M1 behavior: a plain subprocess in the workspace.
 *               No isolation at all; kept for environments without bwrap.
 *   bwrap     — bubblewrap (M1/M2): system/project read-only, per-teammate
 *               writable workspace + private HOME, private tmpfs /tmp.
 *   container — a rootless/daemon container (docker or podman): read-only
 *               root filesystem, dropped capabilities, no-new-privileges,
 *               only the workspace and the private HOME writable.
 *   microvm   — a real VM boundary. This tier requires a hypervisor binary
 *               (cloud-hypervisor, firecracker, qemu) *and* /dev/kvm; the
 *               registry reports it as unavailable when either is missing
 *               rather than pretending a container is a VM.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBwrapArgs } from "./companion-sandbox.mjs";

/** Ordered weakest → strongest. */
export const BACKEND_ORDER = ["directory", "bwrap", "container", "microvm"];

/**
 * MicroVM hypervisors we can drive with a compatible CLI contract. None are
 * wired to a runner yet — detection is what lets the registry answer
 * truthfully today, and the runner lands with the first host that has one.
 */
const MICROVM_BINARIES = ["cloud-hypervisor", "firecracker", "qemu-system-x86_64"];

function which(binary, execFileImpl) {
  return new Promise((resolve) => {
    execFileImpl("sh", ["-c", `command -v ${binary}`], (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null);
    });
  });
}

function versionOf(binary, execFileImpl) {
  return new Promise((resolve) => {
    execFileImpl(binary, ["--version"], (error, stdout) => {
      resolve(error ? null : String(stdout).split("\n")[0].trim());
    });
  });
}

/**
 * Detect one backend. Resolves with
 * { id, label, isolation, available, detail, binary }.
 * Detection never throws: an unusable environment is a normal outcome.
 */
export async function detectBackend(id, options = {}) {
  const { execFileImpl = execFile, env = process.env } = options;
  const base = BACKEND_LABELS[id];
  if (!base) throw new Error(`unknown backend "${id}" (available: ${BACKEND_ORDER.join(", ")})`);

  if (id === "directory") {
    return { id, ...base, available: true, binary: null, detail: "no isolation (plain subprocess)" };
  }

  if (id === "bwrap") {
    if (process.platform !== "linux") {
      return { id, ...base, available: false, binary: null, detail: "bubblewrap is Linux-only" };
    }
    const binary = await which("bwrap", execFileImpl);
    if (!binary) return { id, ...base, available: false, binary: null, detail: "bwrap not found on PATH" };
    const version = await versionOf("bwrap", execFileImpl);
    return { id, ...base, available: true, binary, detail: version ?? "bwrap available" };
  }

  if (id === "container") {
    if (process.platform !== "linux") {
      return { id, ...base, available: false, binary: null, detail: "container backend is Linux-only" };
    }
    for (const engine of ["docker", "podman"]) {
      const binary = await which(engine, execFileImpl);
      if (!binary) continue;
      // Reachability matters more than presence: a socket the user cannot
      // talk to would fail every task at spawn time.
      const reachable = await new Promise((resolve) => {
        execFileImpl(engine, ["version", "--format", "{{.Server.Version}}"], { timeout: 8000 }, (error, stdout) => {
          resolve(error ? null : String(stdout).trim());
        });
      });
      if (!reachable) {
        return {
          id,
          ...base,
          available: false,
          binary,
          detail: `${engine} found but the daemon is not reachable`
        };
      }
      return { id, ...base, available: true, binary, engine, detail: `${engine} ${reachable}` };
    }
    return { id, ...base, available: false, binary: null, detail: "neither docker nor podman found" };
  }

  // microvm — needs a hypervisor, KVM, AND a bootable image pair. Reporting
  // "available" without images would just move the failure to task time.
  const microvm = options.microvm ?? {};
  const problems = [];
  let binary = null;
  let runtime = null;
  for (const candidate of MICROVM_BINARIES) {
    const found = await which(candidate, execFileImpl);
    if (found) {
      binary = found;
      runtime = candidate;
      break;
    }
  }
  if (!binary) {
    problems.push(`no hypervisor binary found (looked for ${MICROVM_BINARIES.join(", ")})`);
  } else if (!fs.existsSync("/dev/kvm")) {
    problems.push(`${runtime} present, but /dev/kvm is missing`);
  } else if (!microvm.kernel || !fs.existsSync(microvm.kernel)) {
    problems.push("kernel image not configured (--microvm-kernel <vmlinuz>)");
  } else if (!microvm.rootfs || !fs.existsSync(microvm.rootfs)) {
    problems.push("root filesystem image not configured (--microvm-rootfs <disk.img>)");
  }
  if (problems.length) {
    return { id, ...base, available: false, binary, runtime, detail: problems.join("; ") };
  }
  return {
    id,
    ...base,
    available: true,
    binary,
    runtime,
    detail: `${runtime} + /dev/kvm + ${path.basename(microvm.kernel)} + ${path.basename(microvm.rootfs)}`
  };
}

export const BACKEND_LABELS = {
  directory: { label: "Directory sandbox", isolation: "none" },
  bwrap: { label: "Bubblewrap sandbox", isolation: "namespace (mount/pid/ipc)" },
  container: { label: "Container", isolation: "container (rootfs + caps)" },
  microvm: { label: "MicroVM", isolation: "hardware VM" }
};

/** Detect every backend, in isolation order. */
export async function listBackends(options = {}) {
  const entries = [];
  for (const id of BACKEND_ORDER) entries.push(await detectBackend(id, options));
  return entries;
}

/**
 * Choose a backend.
 *   requested: "auto" | a backend id
 * `auto` picks the strongest AVAILABLE tier at or below `ceiling`
 * (default "bwrap": auto must not silently start a container).
 * An explicit request that is unavailable is an error — never a downgrade.
 */
export async function resolveBackend(requested = "auto", { ceiling = "bwrap", ...options } = {}) {
  const detected = await listBackends(options);
  const byId = new Map(detected.map((entry) => [entry.id, entry]));

  if (requested !== "auto") {
    const entry = byId.get(requested);
    if (!entry) throw new Error(`unknown backend "${requested}" (available: ${BACKEND_ORDER.join(", ")})`);
    if (!entry.available) {
      throw new Error(`backend "${requested}" is not available: ${entry.detail}`);
    }
    return { backend: entry, detected, fallbackFrom: null, reason: "explicitly requested" };
  }

  const ceilingIndex = Math.max(0, BACKEND_ORDER.indexOf(ceiling));
  for (let index = ceilingIndex; index >= 0; index -= 1) {
    const entry = byId.get(BACKEND_ORDER[index]);
    if (entry.available) {
      const skipped = detected
        .filter((candidate) => candidate.id !== entry.id && !candidate.available)
        .map((candidate) => `${candidate.id}: ${candidate.detail}`);
      return {
        backend: entry,
        detected,
        fallbackFrom: index < ceilingIndex ? BACKEND_ORDER[ceilingIndex] : null,
        reason: skipped.length ? skipped.join("; ") : "strongest available tier"
      };
    }
  }
  // directory is always available, so this is unreachable in practice.
  throw new Error("no backend is available");
}

/** Human-readable one-liner for logs and `companion backends`. */
export function formatBackendChoice(choice) {
  const { backend, fallbackFrom, reason } = choice;
  const prefix = fallbackFrom ? `degraded from ${fallbackFrom} → ` : "";
  return `${prefix}${backend.id} (${backend.detail}) — ${reason}`;
}

/**
 * Build the container argument vector for `command args`.
 *
 * Isolation: read-only root filesystem with a writable tmpfs workspace
 * scratch, all capabilities dropped, no privilege escalation, and only the
 * private HOME + the teammate workspace bind-mounted writable. The network
 * stays available (the teammate must reach its model provider) but nothing
 * is published.
 */
export function buildContainerArgs({
  engine = "docker",
  image,
  command,
  args = [],
  workspace,
  projectRoot,
  home = process.env.HOME,
  homeDir = null,
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
  gid = typeof process.getgid === "function" ? process.getgid() : 0
}) {
  if (!image) throw new Error("buildContainerArgs: image is required");
  if (!workspace) throw new Error("buildContainerArgs: workspace is required");
  if (!projectRoot) throw new Error("buildContainerArgs: projectRoot is required");
  const workspaceAbs = path.resolve(workspace);
  const projectAbs = path.resolve(projectRoot);
  const argv = [
    "run",
    "--rm",
    "--init",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=512m",
    "--tmpfs", "/run:rw,size=64m",
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    "--user", `${uid}:${gid}`,
    "--workdir", workspaceAbs,
    // The project tree is read-only; the workspace is re-mounted writable on
    // top of it (later mounts shadow earlier ones, same discipline as bwrap).
    "--volume", `${projectAbs}:${projectAbs}:ro`,
    "--volume", `${workspaceAbs}:${workspaceAbs}:rw`
  ];
  if (homeDir) {
    const homeAbs = path.resolve(homeDir);
    argv.push("--volume", `${homeAbs}:${homeAbs}:rw`);
    argv.push("--env", `HOME=${homeAbs}`);
    for (const file of ["auth.json", "models.json", "settings.json"]) {
      const source = home ? path.join(home, ".pi", "agent", file) : null;
      if (source && fs.existsSync(source)) {
        argv.push("--volume", `${source}:${path.join(homeAbs, ".pi", "agent", file)}:ro`);
      }
    }
  } else if (home) {
    argv.push("--volume", `${path.join(home, ".pi")}:${path.join(home, ".pi")}:rw`);
    argv.push("--env", `HOME=${home}`);
  }
  argv.push("--entrypoint", command, image, ...args);
  return argv;
}

/**
 * Create the spawn wrapper for a resolved backend. The returned function has
 * the (command, args, options) signature the subagent executor expects.
 */
export function createBackendSpawnWrapper({
  backend,
  workspace,
  projectRoot,
  home = process.env.HOME,
  homeDir = null,
  image = "docker.io/library/node:22-slim",
  microvm = null,
  spawnImpl
}) {
  if (typeof spawnImpl !== "function") throw new Error("createBackendSpawnWrapper: spawnImpl is required");
  const id = typeof backend === "string" ? backend : backend.id;

  if (id === "directory") {
    return function directSpawn(command, args, options) {
      return spawnImpl(command, args ?? [], options);
    };
  }

  if (id === "bwrap") {
    const wrapper = buildBwrapArgs({ workspace, projectRoot, home, homeDir });
    return function bwrapSpawn(command, args, options) {
      return spawnImpl("bwrap", [...wrapper, "--", command, ...(args ?? [])], options);
    };
  }

  if (id === "container") {
    const engine = (typeof backend === "object" && backend.binary) || "docker";
    return function containerSpawn(command, args, options) {
      // The host passes an absolute interpreter path; inside the container the
      // same path must exist, so the runtime root is bound read-only with the
      // project tree (Pi lives either in the repo or the package).
      const containerArgs = buildContainerArgs({ engine, image, command, args: args ?? [], workspace, projectRoot, home, homeDir });
      return spawnImpl(engine, containerArgs, options);
    };
  }

  if (id === "microvm") {
    if (!microvm?.kernel || !microvm?.rootfs) {
      throw new Error("microvm backend needs a kernel and rootfs image (--microvm-kernel/--microvm-rootfs)");
    }
    const runtime = microvm.runtime ?? (typeof backend === "object" ? backend.runtime : null) ?? "qemu-system-x86_64";
    const binary = (typeof backend === "object" && backend.binary) || runtime;
    return function microvmSpawn(command, args, options) {
      const vmArgs = buildMicrovmArgs({
        runtime,
        kernel: microvm.kernel,
        rootfs: microvm.rootfs,
        workspace,
        projectRoot,
        homeDir,
        command,
        args: args ?? [],
        memoryMb: microvm.memoryMb,
        cpus: microvm.cpus,
        virtiofsSocket: microvm.virtiofsSocket
      });
      return spawnImpl(binary, vmArgs, options);
    };
  }

  throw new Error(`unknown backend "${id}"`);
}

/**
 * Build the hypervisor argv for a microVM run.
 *
 * Guest contract (what an image must provide to be usable here):
 *   - the workspace (and, when isolated, the private HOME) are shared into
 *     the guest over virtiofs/9p under fixed tags (`equaxis_ws`,
 *     `equaxis_home`),
 *   - the init system reads the kernel parameter `equaxis.cmd=<base64 json>`,
 *     mounts those tags, chdirs into the workspace and runs the command,
 *   - console output goes to stdout, so the host sees the same JSON stream it
 *     would see from a local subprocess.
 *
 * The command travels base64-encoded in the kernel cmdline because there is
 * no host→guest channel before the image boots. It is not a secret channel;
 * the guest is single-tenant.
 */
export function buildMicrovmArgs({
  runtime = "qemu-system-x86_64",
  kernel,
  rootfs,
  workspace,
  projectRoot,
  homeDir = null,
  command,
  args = [],
  memoryMb = 2048,
  cpus = 2,
  virtiofsSocket = null
}) {
  if (!kernel) throw new Error("buildMicrovmArgs: kernel is required");
  if (!rootfs) throw new Error("buildMicrovmArgs: rootfs is required");
  if (!workspace) throw new Error("buildMicrovmArgs: workspace is required");
  if (!command) throw new Error("buildMicrovmArgs: command is required");

  const guestCommand = Buffer.from(
    JSON.stringify({ command, args, cwd: path.resolve(workspace) }),
    "utf8"
  ).toString("base64");
  const shares = [
    `equaxis_ws:${path.resolve(workspace)}`,
    ...(homeDir ? [`equaxis_home:${path.resolve(homeDir)}`] : [])
  ].join(",");
  const cmdline = `console=ttyS0 root=/dev/vda rw equaxis.cmd=${guestCommand} equaxis.shares=${shares}`;

  if (runtime.includes("cloud-hypervisor")) {
    if (!virtiofsSocket) {
      throw new Error("cloud-hypervisor needs a virtiofsd socket (--microvm-virtiofs-socket) to share the workspace");
    }
    return [
      "--kernel", path.resolve(kernel),
      "--disk", `path=${path.resolve(rootfs)}`,
      "--cpus", `boot=${cpus}`,
      "--memory", `size=${memoryMb}M`,
      "--fs", `tag=equaxis_ws,socket=${virtiofsSocket}`,
      "--cmdline", cmdline,
      "--serial", "tty",
      "--console", "off"
    ];
  }

  // qemu with virtfs (9p) needs no helper process, so it is the default.
  return [
    "-kernel", path.resolve(kernel),
    "-drive", `file=${path.resolve(rootfs)},format=raw,if=virtio`,
    "-append", cmdline,
    "-m", String(memoryMb),
    "-smp", String(cpus),
    "-virtfs", `local,path=${path.resolve(workspace)},mount_tag=equaxis_ws,security_model=none`,
    ...(homeDir ? ["-virtfs", `local,path=${path.resolve(homeDir)},mount_tag=equaxis_home,security_model=none`] : []),
    "-nographic",
    "-no-reboot",
    "-enable-kvm"
  ];
}
