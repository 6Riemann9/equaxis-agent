import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BACKEND_ORDER,
  buildContainerArgs,
  createBackendSpawnWrapper,
  detectBackend,
  formatBackendChoice,
  listBackends,
  resolveBackend
} from "../src/companion-backends.mjs";

/** A fake execFile that answers `command -v`/`--version` from a table. */
function fakeExecFile({ present = [], versions = {}, daemon = null }) {
  return (command, args, optionsOrCb, maybeCb) => {
    const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
    if (command === "sh") {
      // `command -v <binary>`
      const binary = String(args?.[1] ?? "").split(" ").pop();
      return present.includes(binary) ? cb(null, `/usr/bin/${binary}\n`) : cb(new Error("not found"));
    }
    if (args?.includes("--version")) {
      const version = versions[command];
      return version ? cb(null, `${version}\n`) : cb(new Error("no version"));
    }
    if (args?.includes("version")) {
      // container engine daemon probe: `version --format ...`
      return daemon ? cb(null, `${daemon}\n`) : cb(new Error("daemon unreachable"));
    }
    return cb(new Error(`unexpected call: ${command} ${JSON.stringify(args)}`));
  };
}

// ---- detection ----

test("m6 backends: directory is always available and is the only isolation-free tier", async () => {
  const entry = await detectBackend("directory", { execFileImpl: fakeExecFile({}) });
  assert.equal(entry.available, true);
  assert.equal(entry.isolation, "none");
  assert.equal(BACKEND_ORDER[0], "directory");
  assert.equal(BACKEND_ORDER.at(-1), "microvm");
});

test("m6 backends: bwrap detection reports missing binary and version honestly", async () => {
  const missing = await detectBackend("bwrap", { execFileImpl: fakeExecFile({ present: [] }) });
  assert.equal(missing.available, false);
  assert.match(missing.detail, /not found on PATH/);

  const present = await detectBackend("bwrap", {
    execFileImpl: fakeExecFile({ present: ["bwrap"], versions: { bwrap: "bubblewrap 0.13.0" } })
  });
  assert.equal(present.available, true);
  assert.equal(present.detail, "bubblewrap 0.13.0");
});

test("m6 backends: container requires a reachable daemon, not just a binary", async () => {
  const noEngine = await detectBackend("container", { execFileImpl: fakeExecFile({ present: [] }) });
  assert.equal(noEngine.available, false);
  assert.match(noEngine.detail, /neither docker nor podman/);

  const binaryOnly = await detectBackend("container", {
    execFileImpl: fakeExecFile({ present: ["docker"], daemon: null })
  });
  assert.equal(binaryOnly.available, false);
  assert.match(binaryOnly.detail, /daemon is not reachable/);

  const reachable = await detectBackend("container", {
    execFileImpl: fakeExecFile({ present: ["docker"], daemon: "29.8.1" })
  });
  assert.equal(reachable.available, true);
  assert.equal(reachable.engine, "docker");
  assert.match(reachable.detail, /docker 29\.8\.1/);
});

test("m6 backends: microvm is reported unavailable with a reason, never faked", async () => {
  const noBinary = await detectBackend("microvm", { execFileImpl: fakeExecFile({ present: [] }) });
  assert.equal(noBinary.available, false);
  assert.match(noBinary.detail, /no hypervisor binary found/);

  // M10 added the runner; a hypervisor alone still must not claim availability —
  // bootable images are part of the prerequisite set.
  const binaryWithoutImages = await detectBackend("microvm", {
    execFileImpl: fakeExecFile({ present: ["cloud-hypervisor"], versions: { "cloud-hypervisor": "v44" } })
  });
  assert.equal(binaryWithoutImages.available, false, "a hypervisor alone must not claim availability");
  assert.match(binaryWithoutImages.detail, /kernel image not configured/);
});

test("m6 backends: unknown backend ids are rejected", async () => {
  await assert.rejects(() => detectBackend("quantum", { execFileImpl: fakeExecFile({}) }), /unknown backend "quantum"/);
  await assert.rejects(() => resolveBackend("quantum", { execFileImpl: fakeExecFile({}) }), /unknown backend/);
});

// ---- resolution ----

test("m6 backends: explicit unavailable request is an error, auto degrades and says why", async () => {
  const noBwrap = { execFileImpl: fakeExecFile({ present: [] }) };

  await assert.rejects(
    () => resolveBackend("bwrap", noBwrap),
    /backend "bwrap" is not available: bwrap not found on PATH/
  );

  const auto = await resolveBackend("auto", noBwrap);
  assert.equal(auto.backend.id, "directory");
  assert.equal(auto.fallbackFrom, "bwrap");
  assert.match(auto.reason, /bwrap: bwrap not found on PATH/);
});

test("m6 backends: auto respects the ceiling (never silently starts a container)", async () => {
  const dockerOnly = { execFileImpl: fakeExecFile({ present: ["docker"], daemon: "29.8.1" }) };
  const capped = await resolveBackend("auto", dockerOnly);
  assert.equal(capped.backend.id, "directory", "default ceiling is bwrap");

  const raised = await resolveBackend("auto", { ...dockerOnly, ceiling: "container" });
  assert.equal(raised.backend.id, "container");
  assert.equal(raised.fallbackFrom, null, "picking the ceiling itself is not a degradation");

  const both = { execFileImpl: fakeExecFile({ present: ["bwrap", "docker"], daemon: "29.8.1" }) };
  assert.equal((await resolveBackend("auto", both)).backend.id, "bwrap", "bwrap wins over container at the same ceiling");
  assert.equal((await resolveBackend("auto", { ...both, ceiling: "container" })).backend.id, "container");
});

test("m6 backends: formatBackendChoice marks degraded choices", async () => {
  const choice = await resolveBackend("auto", { execFileImpl: fakeExecFile({ present: [] }) });
  const text = formatBackendChoice(choice);
  assert.match(text, /degraded from bwrap → directory/);
});

test("m6 backends: listBackends returns every tier in isolation order", async () => {
  const entries = await listBackends({ execFileImpl: fakeExecFile({}) });
  assert.deepEqual(entries.map((e) => e.id), BACKEND_ORDER);
  assert.ok(entries.every((e) => typeof e.detail === "string" && e.detail.length > 0));
});

// ---- container argv ----

test("m6 container: argv locks down caps, rootfs and privilege escalation", () => {
  const argv = buildContainerArgs({
    image: "node:22-slim",
    command: "node",
    args: ["/app/cli.js"],
    workspace: "/proj/.pi/companion/workspaces/scout",
    projectRoot: "/proj",
    uid: 1000,
    gid: 1000
  });
  const joined = argv.join(" ");
  assert.equal(argv[0], "run");
  assert.ok(argv.includes("--rm"));
  assert.ok(argv.includes("--read-only"), "root filesystem must be read-only");
  assert.match(joined, /--cap-drop ALL/);
  assert.match(joined, /--security-opt no-new-privileges/);
  assert.match(joined, /--user 1000:1000/);
  assert.match(joined, /--volume \/proj:\/proj:ro/, "project tree read-only");
  assert.match(joined, /--volume \/proj\/\.pi\/companion\/workspaces\/scout:\/proj\/\.pi\/companion\/workspaces\/scout:rw/);
  assert.equal(argv.at(-2), "node:22-slim");
  assert.equal(argv.at(-1), "/app/cli.js");
  assert.ok(!joined.includes("--privileged"));
  assert.ok(!joined.includes("--publish"), "no ports are published");
});

test("m6 container: isolated HOME is writable and credentials are seeded read-only", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "m6-home-"));
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  for (const file of ["auth.json", "models.json", "settings.json"]) {
    fs.writeFileSync(path.join(home, ".pi", "agent", file), "{}", "utf8");
  }
  const homeDir = "/proj/.pi/companion/home/scout";
  const argv = buildContainerArgs({
    image: "node:22-slim",
    command: "node",
    args: [],
    workspace: "/proj/w",
    projectRoot: "/proj",
    home,
    homeDir,
    uid: 1000,
    gid: 1000
  });
  const joined = argv.join(" ");
  assert.match(joined, new RegExp(`--volume ${homeDir}:${homeDir}:rw`));
  assert.match(joined, new RegExp(`--env HOME=${homeDir}`));
  for (const file of ["auth.json", "models.json", "settings.json"]) {
    assert.match(joined, new RegExp(`${path.join(home, ".pi", "agent", file)}:${homeDir}/\\.pi/agent/${file}:ro`));
  }
});

test("m6 container: required inputs are validated", () => {
  assert.throws(() => buildContainerArgs({ command: "node", workspace: "/w", projectRoot: "/p" }), /image is required/);
  assert.throws(() => buildContainerArgs({ image: "i", command: "node", projectRoot: "/p" }), /workspace is required/);
  assert.throws(() => buildContainerArgs({ image: "i", command: "node", workspace: "/w" }), /projectRoot is required/);
});

// ---- spawn wrappers ----

function captureSpawn() {
  const calls = [];
  const impl = (command, args, options) => {
    calls.push({ command, args, options });
    return { pid: 1 };
  };
  return { calls, impl };
}

test("m6 spawn: directory backend runs the command unchanged", () => {
  const { calls, impl } = captureSpawn();
  const wrap = createBackendSpawnWrapper({ backend: "directory", workspace: "/w", projectRoot: "/p", spawnImpl: impl });
  wrap("node", ["/app/cli.js"], { cwd: "/w" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "node");
  assert.deepEqual(calls[0].args, ["/app/cli.js"]);
});

test("m6 spawn: bwrap backend prefixes the sandbox argv", () => {
  const { calls, impl } = captureSpawn();
  const wrap = createBackendSpawnWrapper({ backend: "bwrap", workspace: "/p/w", projectRoot: "/p", spawnImpl: impl });
  wrap("node", ["/app/cli.js"], {});
  assert.equal(calls[0].command, "bwrap");
  assert.ok(calls[0].args.includes("--unshare-ipc"));
  assert.deepEqual(calls[0].args.slice(-3), ["--", "node", "/app/cli.js"]);
});

test("m6 spawn: container backend runs the engine with the locked-down argv", () => {
  const { calls, impl } = captureSpawn();
  const wrap = createBackendSpawnWrapper({
    backend: { id: "container", binary: "docker" },
    workspace: "/p/w",
    projectRoot: "/p",
    image: "node:22-slim",
    spawnImpl: impl
  });
  wrap("node", ["/app/cli.js"], {});
  assert.equal(calls[0].command, "docker");
  assert.equal(calls[0].args[0], "run");
  assert.ok(calls[0].args.includes("--read-only"));
});

test("m6 spawn: microvm refuses to build a wrapper without bootable images", () => {
  const { impl } = captureSpawn();
  assert.throws(
    () => createBackendSpawnWrapper({ backend: "microvm", workspace: "/w", projectRoot: "/p", spawnImpl: impl }),
    /needs a kernel and rootfs image/
  );
});
