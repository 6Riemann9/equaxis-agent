import { killProcessTree, spawnTracked } from "./process-cleanup.mjs";
import path from "node:path";
import readline from "node:readline";

const RESPONSE_PREFIX = "__EQUAXIS_MEMORY__";

export function buildPythonBridgeEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1"
  };
}

export class MemoryBridge {
  constructor({ cwd, pythonCommand, rootDir, bridgePath, requestTimeoutMs = 60000, onDiagnostic = (_message) => {}, autoRestart = false, maxRestarts = 5 }) {
    this.cwd = cwd;
    this.pythonCommand = pythonCommand;
    this.rootDir = path.resolve(cwd, rootDir);
    this.bridgePath = bridgePath ? path.resolve(bridgePath) : path.join(this.cwd, "bridge", "memory_bridge.py");
    this.requestTimeoutMs = requestTimeoutMs;
    this.onDiagnostic = onDiagnostic;
    this.autoRestart = autoRestart;
    this.maxRestarts = maxRestarts;
    this.process = null;
    this.started = false;
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
    this.stopRequested = false;
    this.restartCount = 0;
    this.restartTimer = null;
  }

  async start() {
    if (this.process && !this.process.killed && this.started) return;
    if (this.startPromise) return this.startPromise;
    this.stopRequested = false;
    this.restartCount = 0;

    this.startPromise = new Promise((resolve, reject) => {
      const child = spawnTracked({
        command: this.pythonCommand,
        args: ["-u", this.bridgePath, "--root", this.rootDir],
        options: {
          cwd: this.cwd,
          env: buildPythonBridgeEnv(),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32"
        },
        label: "memory-bridge"
      });
      this.process = child;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      // A dead bridge makes the next stdin.write() fail with EPIPE, which Node
      // surfaces as an 'error' event on the socket. Without a listener that
      // becomes an uncaughtException and kills the whole process. Route stream
      // errors to rejectAll so in-flight requests fail cleanly instead.
      child.stdin.on("error", (error) => this.rejectAll(error));
      child.stdout.on("error", (error) => this.rejectAll(error));
      child.stderr.on("error", (error) => this.rejectAll(error));

      const lines = readline.createInterface({ input: child.stdout });
      lines.on("line", (line) => this.handleLine(line));
      lines.on("error", (error) => this.rejectAll(error));
      child.stderr.on("data", (chunk) => {
        const message = String(chunk).trim();
        if (message) this.onDiagnostic(message);
      });
      child.once("error", (error) => {
        this.rejectAll(error);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        const error = new Error(`Memory bridge exited (code=${code ?? "null"}, signal=${signal ?? "none"})`);
        this.rejectAll(error);
        this.process = null;
        this.started = false;
        if (this.autoRestart && !this.stopRequested && this.restartCount < this.maxRestarts) {
          const delayMs = 1000 * 2 ** this.restartCount;
          this.restartCount += 1;
          this.onDiagnostic(`Memory bridge exited unexpectedly; restarting in ${delayMs}ms (attempt ${this.restartCount}/${this.maxRestarts})`);
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            void this.start().catch(() => {});
          }, delayMs);
        }
      });

      this.request("ping", {}, { timeoutMs: this.requestTimeoutMs, skipStart: true })
        .then(() => {
          this.started = true;
          resolve();
        })
        .catch((error) => {
          if (child.exitCode === null && !child.killed) child.kill();
          this.process = null;
          this.started = false;
          reject(error);
        });
    }).finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  async request(action, payload = {}, options = {}) {
    if (!options.skipStart) await this.start();
    const stdin = this.process?.stdin;
    if (!this.process || this.process.killed || !stdin || !stdin.writable || stdin.destroyed) {
      throw new Error("Memory bridge is not running");
    }

    const id = String(this.nextId++);
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        options.signal?.removeEventListener("abort", abort);
        reject(new Error(`Memory request timed out: ${action}`));
      }, timeoutMs);

      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Memory request aborted: ${action}`));
      };
      options.signal?.addEventListener("abort", abort, { once: true });

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          reject(error);
        }
      });
      try {
        stdin.write(`${JSON.stringify({ id, action, payload })}\n`, "utf8", (error) => {
          if (error) {
            const pending = this.pending.get(id);
            if (pending) {
              this.pending.delete(id);
              pending.reject(error);
            }
          }
        });
      } catch (error) {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.reject(error);
        }
      }
    });
  }

  handleLine(line) {
    if (!line.startsWith(RESPONSE_PREFIX)) {
      if (line.trim()) this.onDiagnostic(line.trim());
      return;
    }
    let response;
    try {
      response = JSON.parse(line.slice(RESPONSE_PREFIX.length));
    } catch (error) {
      this.onDiagnostic(`Invalid memory response: ${String(error)}`);
      return;
    }
    const pending = this.pending.get(String(response.id));
    if (!pending) return;
    this.pending.delete(String(response.id));
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error?.message ?? "Memory request failed"));
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async stop() {
    this.stopRequested = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.process;
    if (!child) return;
    const exited = child.exitCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("exit", resolve));
    try {
      await this.request("close", {}, { timeoutMs: 5000, skipStart: true });
    } catch {
      // Best-effort shutdown; the process is terminated below.
    }
    // Terminate the whole process tree so the Python bridge and any children
    // it spawned cannot linger after stop.
    if (child?.pid && child.exitCode === null && !child.killed) void killProcessTree(child.pid);
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
    this.process = null;
    this.started = false;
  }
}
