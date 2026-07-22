import { spawn } from "node:child_process";
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
  constructor({ cwd, pythonCommand, rootDir, requestTimeoutMs = 60000, onDiagnostic = (_message) => {} }) {
    this.cwd = cwd;
    this.pythonCommand = pythonCommand;
    this.rootDir = path.resolve(cwd, rootDir);
    this.requestTimeoutMs = requestTimeoutMs;
    this.onDiagnostic = onDiagnostic;
    this.process = null;
    this.started = false;
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
  }

  async start() {
    if (this.process && !this.process.killed && this.started) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise((resolve, reject) => {
      const bridgePath = path.join(this.cwd, "bridge", "memory_bridge.py");
      const child = spawn(this.pythonCommand, ["-u", bridgePath, "--root", this.rootDir], {
        cwd: this.cwd,
        env: buildPythonBridgeEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      this.process = child;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      const lines = readline.createInterface({ input: child.stdout });
      lines.on("line", (line) => this.handleLine(line));
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
    if (!this.process || this.process.killed || !this.process.stdin.writable) {
      throw new Error("Memory bridge is not running");
    }

    const id = String(this.nextId++);
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
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

      this.process.stdin.write(`${JSON.stringify({ id, action, payload })}\n`, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(error);
      });
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
    if (child.exitCode === null && !child.killed) child.kill();
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
    this.process = null;
    this.started = false;
  }
}
