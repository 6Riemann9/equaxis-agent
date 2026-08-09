import path from "node:path";
import { loadEquaxisConfig } from "./equaxis-config.mjs";
import { RotatingJsonlTrace } from "./trace-store.mjs";

export const EXTENSION_RUNTIME_SERVICES_VERSION = 1;

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createExtensionRuntimeServices({ cwd, extensionId, pi } = {}) {
  let activeCwd = path.resolve(cwd ?? process.cwd());
  let config = loadEquaxisConfig(activeCwd);
  let traceStore = createTraceStore();

  function createTraceStore() {
    const traceFile = path.resolve(activeCwd, config.reliability.traceDir, "traces.jsonl");
    return new RotatingJsonlTrace(traceFile, config.reliability.trace);
  }

  function configure(nextCwd) {
    activeCwd = path.resolve(nextCwd ?? activeCwd);
    config = loadEquaxisConfig(activeCwd);
    traceStore = createTraceStore();
    return config;
  }

  function record(ctx, event, data = {}) {
    if (!config.runtime.services.trace) return true;
    const recordData = {
      timestamp: new Date().toISOString(),
      sessionId: ctx?.sessionManager?.getSessionId?.(),
      source: extensionId,
      event,
      ...data
    };
    try {
      traceStore.append(recordData);
      return true;
    } catch (error) {
      if (ctx?.hasUI && config.runtime.services.diagnostics) {
        ctx.ui.notify(`${extensionId} trace failed: ${safeMessage(error)}`, "error");
      }
      return false;
    }
  }

  function notify(ctx, message, level = "info") {
    if (config.runtime.services.diagnostics && ctx?.hasUI) ctx.ui.notify(message, level);
  }

  function setStatus(ctx, key, value) {
    if (config.runtime.services.status && ctx?.ui?.setStatus) ctx.ui.setStatus(key, value);
  }

  return {
    version: EXTENSION_RUNTIME_SERVICES_VERSION,
    extensionId,
    pi,
    get cwd() { return activeCwd; },
    get config() { return config; },
    get paths() {
      return {
        workspace: activeCwd,
        traceFile: path.resolve(activeCwd, config.reliability.traceDir, "traces.jsonl"),
        memoryRoot: path.resolve(activeCwd, config.memory.rootDir)
      };
    },
    configure,
    trace: { record },
    diagnostics: { notify, message: safeMessage },
    status: { set: setStatus }
  };
}
