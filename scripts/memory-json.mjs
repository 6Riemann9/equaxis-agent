#!/usr/bin/env node

/**
 * JSONL memory bridge backed by the native Node core — protocol-compatible
 * with bridge/memory_bridge.py (the pi-web memory route and harness snapshot
 * probe can use either; the backend is selected by memory.backend in
 * .pi/equaxis.json).
 *
 * Usage: node scripts/memory-json.mjs --root <memoryRoot>
 * Request/response: {"id","action","payload"} / __EQUAXIS_MEMORY__{...}
 */

import readline from "node:readline";
import path from "node:path";
import { dispatchMemoryAction, NativeMemoryCore } from "../src/memory-core.mjs";

const RESPONSE_PREFIX = "__EQUAXIS_MEMORY__";
const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const rootDir = rootIndex !== -1 && args[rootIndex + 1] ? path.resolve(args[rootIndex + 1]) : null;
if (!rootDir) {
  console.error("--root is required");
  process.exit(1);
}

const core = new NativeMemoryCore({ rootDir });

function emit(requestId, result, error) {
  const payload = error
    ? { id: requestId, ok: false, error: { type: error.constructor?.name ?? "Error", message: error.message ?? String(error) } }
    : { id: requestId, ok: true, result };
  process.stdout.write(`${RESPONSE_PREFIX}${JSON.stringify(payload)}\n`);
}

let pending = 0;

function dispatch(request) {
  const requestId = String(request.id);
  pending += 1;
  return dispatchMemoryAction(core, String(request.action ?? ""), request.payload ?? {})
    .then((result) => {
      pending -= 1;
      emit(requestId, result);
      if (request.action === "close") {
        // Wait for in-flight actions (e.g. first embedding load) to settle
        // before exiting, so a piped batch receives every response.
        const timer = setInterval(() => {
          if (pending <= 1) {
            clearInterval(timer);
            process.exit(0);
          }
        }, 50);
      }
    })
    .catch((error) => {
      pending -= 1;
      emit(requestId, undefined, error);
    });
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (raw) => {
  if (!raw.trim()) return;
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    return;
  }
  void dispatch(request);
});
