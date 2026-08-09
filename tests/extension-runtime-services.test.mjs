import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createExtensionRuntimeServices, EXTENSION_RUNTIME_SERVICES_VERSION } from "../src/extension-runtime-services.mjs";

function context() {
  return {
    hasUI: true,
    sessionManager: { getSessionId: () => "runtime-service-test" },
    ui: {
      notifications: [],
      statuses: new Map(),
      notify(message, level) { this.notifications.push({ message, level }); },
      setStatus(key, value) { this.statuses.set(key, value); }
    }
  };
}

test("provides shared config, trace, diagnostics and status services", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-runtime-services-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const services = createExtensionRuntimeServices({ cwd: root, extensionId: "test-extension" });
  const ctx = context();

  assert.equal(services.version, EXTENSION_RUNTIME_SERVICES_VERSION);
  assert.equal(services.config.schemaVersion, 1);
  services.status.set(ctx, "test", "ready");
  services.diagnostics.notify(ctx, "diagnostic", "warning");
  services.trace.record(ctx, "test_event", { ok: true });

  assert.equal(ctx.ui.statuses.get("test"), "ready");
  assert.deepEqual(ctx.ui.notifications, [{ message: "diagnostic", level: "warning" }]);
  const trace = fs.readFileSync(services.paths.traceFile, "utf8");
  assert.match(trace, /"source":"test-extension"/);
  assert.match(trace, /"event":"test_event"/);
  assert.match(trace, /"ok":true/);
});

test("reconfigures services for a replacement session workspace", (t) => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-runtime-first-"));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-runtime-second-"));
  t.after(() => {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });
  const services = createExtensionRuntimeServices({ cwd: first, extensionId: "test-extension" });
  services.configure(second);
  assert.equal(services.paths.workspace, path.resolve(second));
  services.trace.record(context(), "replacement_session");
  assert.equal(fs.existsSync(services.paths.traceFile), true);
  assert.equal(fs.existsSync(path.join(first, ".pi", "runtime", "traces.jsonl")), false);
});
