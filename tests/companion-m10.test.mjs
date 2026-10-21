import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildMicrovmArgs,
  createBackendSpawnWrapper,
  detectBackend,
  resolveBackend
} from "../src/companion-backends.mjs";
import { execFile } from "node:child_process";

/** A fake execFile answering `command -v`/`--version` from a table. */
function fakeExecFile({ present = [] }) {
  return (command, args, optionsOrCb, maybeCb) => {
    const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
    if (command === "sh") {
      const binary = String(args?.[1] ?? "").split(" ").pop();
      return present.includes(binary) ? cb(null, `/usr/bin/${binary}\n`) : cb(new Error("not found"));
    }
    if (args?.includes("--version")) return cb(null, `${command} version\n`);
    if (args?.includes("version")) return cb(new Error("no daemon"));
    return cb(new Error("unexpected"));
  };
}

function images() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m10-images-"));
  const kernel = path.join(dir, "vmlinuz");
  const rootfs = path.join(dir, "rootfs.img");
  fs.writeFileSync(kernel, "kernel", "utf8");
  fs.writeFileSync(rootfs, "rootfs", "utf8");
  return { dir, kernel, rootfs };
}

const HAS_KVM = fs.existsSync("/dev/kvm");

// ---- prerequisite gating: "available" must mean "can actually run" ----

test("m10 microvm: a hypervisor alone is not enough — images and KVM are required", async () => {
  const bare = await detectBackend("microvm", { execFileImpl: fakeExecFile({ present: [] }) });
  assert.equal(bare.available, false);
  assert.match(bare.detail, /no hypervisor binary found/);

  const noImages = await detectBackend("microvm", {
    execFileImpl: fakeExecFile({ present: ["qemu-system-x86_64"] })
  });
  assert.equal(noImages.available, false);
  assert.match(noImages.detail, /kernel image not configured/);

  const onlyKernel = await detectBackend("microvm", {
    execFileImpl: fakeExecFile({ present: ["qemu-system-x86_64"] }),
    microvm: { kernel: images().kernel }
  });
  assert.equal(onlyKernel.available, false);
  assert.match(onlyKernel.detail, /root filesystem image not configured/);
});

test("m10 microvm: configured hypervisor + kernel + rootfs still needs /dev/kvm", async () => {
  const { kernel, rootfs } = images();
  const entry = await detectBackend("microvm", {
    execFileImpl: fakeExecFile({ present: ["qemu-system-x86_64"] }),
    microvm: { kernel, rootfs }
  });
  if (HAS_KVM) {
    assert.equal(entry.available, true);
    assert.match(entry.detail, /qemu-system-x86_64 \+ \/dev\/kvm/);
  } else {
    assert.equal(entry.available, false);
    assert.match(entry.detail, /\/dev\/kvm is missing/);
  }
});

test("m10 microvm: an explicit request for an unavailable tier is still an error", async () => {
  await assert.rejects(
    () => resolveBackend("microvm", { execFileImpl: fakeExecFile({ present: [] }) }),
    /backend "microvm" is not available/
  );
  // auto with a microvm ceiling still stops at the strongest available tier.
  const auto = await resolveBackend("auto", {
    execFileImpl: fakeExecFile({ present: [] }),
    ceiling: "microvm"
  });
  assert.equal(auto.backend.id, "directory");
  assert.equal(auto.fallbackFrom, "microvm");
  assert.match(auto.reason, /microvm: no hypervisor binary found/);
});

// ---- argv ----

test("m10 microvm: qemu argv shares the workspace and carries the command in the cmdline", () => {
  const { kernel, rootfs } = images();
  const argv = buildMicrovmArgs({
    runtime: "qemu-system-x86_64",
    kernel,
    rootfs,
    workspace: "/proj/.pi/companion/workspaces/scout",
    projectRoot: "/proj",
    homeDir: "/proj/.pi/companion/home/scout",
    command: "/usr/bin/node",
    args: ["/app/cli.js", "--json"],
    memoryMb: 1024,
    cpus: 4
  });
  const joined = argv.join(" ");

  assert.equal(argv[0], "-kernel");
  assert.equal(argv[1], path.resolve(kernel));
  assert.match(joined, /-drive file=.*rootfs\.img,format=raw,if=virtio/);
  assert.match(joined, /-m 1024/);
  assert.match(joined, /-smp 4/);
  assert.match(joined, /-enable-kvm/, "a microVM without KVM acceleration is not the point of this tier");
  assert.match(joined, /-nographic/, "console must reach stdout so the host sees the JSON stream");
  assert.match(joined, /mount_tag=equaxis_ws/);
  assert.match(joined, /mount_tag=equaxis_home/);
  assert.match(joined, /console=ttyS0 root=\/dev\/vda rw/);

  // The command is encoded, not spliced raw into the cmdline.
  const cmdParam = joined.match(/equaxis\.cmd=([A-Za-z0-9+/=]+)/);
  assert.ok(cmdParam, "cmdline must carry equaxis.cmd");
  const decoded = JSON.parse(Buffer.from(cmdParam[1], "base64").toString("utf8"));
  assert.equal(decoded.command, "/usr/bin/node");
  assert.deepEqual(decoded.args, ["/app/cli.js", "--json"]);
  assert.equal(decoded.cwd, path.resolve("/proj/.pi/companion/workspaces/scout"));
});

test("m10 microvm: cloud-hypervisor argv needs a virtiofs socket and says so", () => {
  const { kernel, rootfs } = images();
  const base = {
    runtime: "cloud-hypervisor",
    kernel,
    rootfs,
    workspace: "/w",
    projectRoot: "/p",
    command: "/usr/bin/node"
  };
  assert.throws(() => buildMicrovmArgs(base), /needs a virtiofsd socket/);

  const argv = buildMicrovmArgs({ ...base, virtiofsSocket: "/run/virtiofsd.sock" });
  const joined = argv.join(" ");
  assert.match(joined, /--kernel /);
  assert.match(joined, /--disk path=/);
  assert.match(joined, /--fs tag=equaxis_ws,socket=\/run\/virtiofsd\.sock/);
  assert.match(joined, /--memory size=2048M/);
  assert.match(joined, /--console off/);
});

test("m10 microvm: required inputs are validated", () => {
  const { kernel, rootfs } = images();
  assert.throws(() => buildMicrovmArgs({ rootfs, workspace: "/w", command: "n" }), /kernel is required/);
  assert.throws(() => buildMicrovmArgs({ kernel, workspace: "/w", command: "n" }), /rootfs is required/);
  assert.throws(() => buildMicrovmArgs({ kernel, rootfs, command: "n" }), /workspace is required/);
  assert.throws(() => buildMicrovmArgs({ kernel, rootfs, workspace: "/w" }), /command is required/);
});

test("m10 microvm: the spawn wrapper refuses without images and builds argv with them", () => {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    return { pid: 1 };
  };
  assert.throws(
    () => createBackendSpawnWrapper({ backend: "microvm", workspace: "/w", projectRoot: "/p", spawnImpl }),
    /needs a kernel and rootfs image/
  );

  const { kernel, rootfs } = images();
  const wrap = createBackendSpawnWrapper({
    backend: { id: "microvm", binary: "/usr/bin/qemu-system-x86_64", runtime: "qemu-system-x86_64" },
    workspace: "/w",
    projectRoot: "/p",
    microvm: { kernel, rootfs },
    spawnImpl
  });
  wrap("/usr/bin/node", ["-e", "1"], {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/qemu-system-x86_64");
  assert.equal(calls[0].args[0], "-kernel");
});

// A live probe only runs where the tier is genuinely available; otherwise the
// honest answer is that it cannot be verified here.
test("m10 microvm: availability on this host is reported, not assumed", async () => {
  const { kernel, rootfs } = images();
  const entry = await detectBackend("microvm", { execFileImpl: execFile, microvm: { kernel, rootfs } });
  assert.equal(typeof entry.available, "boolean");
  assert.ok(entry.detail.length > 0);
  if (!entry.available) {
    // Document what is missing rather than failing: this test asserts the
    // contract (a reason is always given), not the host's capability.
    assert.match(entry.detail, /hypervisor|kernel|rootfs|\/dev\/kvm/);
  }
});
