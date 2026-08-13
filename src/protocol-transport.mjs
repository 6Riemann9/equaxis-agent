import net from "node:net";
import { killProcessTree, spawnTracked } from "./process-cleanup.mjs";

function parseHeaders(text) {
  const headers = new Map();
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return headers;
}

function createFrameParser(onMessage, onError) {
  let buffer = Buffer.alloc(0);
  const parser = (chunk) => {
    if (chunk === undefined || chunk === null) return;
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8")]);
    while (true) {
      const separator = buffer.indexOf(Buffer.from("\r\n\r\n"));
      const alternateSeparator = separator === -1 ? buffer.indexOf(Buffer.from("\n\n")) : -1;
      const headerEnd = separator >= 0 ? separator : alternateSeparator;
      const delimiterLength = separator >= 0 ? 4 : 2;
      if (headerEnd === -1) return;
      const headers = parseHeaders(buffer.subarray(0, headerEnd).toString("utf8"));
      const length = Number(headers.get("content-length"));
      if (!Number.isInteger(length) || length < 0) {
        onError(new Error("protocol frame is missing a valid Content-Length header"));
        buffer = buffer.subarray(headerEnd + delimiterLength);
        continue;
      }
      const bodyStart = headerEnd + delimiterLength;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      try {
        onMessage(JSON.parse(body));
      } catch (error) {
        onError(new Error(`protocol frame body is not valid JSON: ${error.message}`));
      }
    }
  };
  Object.defineProperty(parser, "bufferedBytes", { get: () => buffer.length });
  return parser;
}

export function createStdioTransport(streams, options = {}) {
  const input = streams.input;
  const output = streams.output;
  const errorOutput = streams.error;
  const messageHandlers = new Set();
  const errorHandlers = new Set();
  const parser = createFrameParser(
    (message) => {
      for (const handler of messageHandlers) handler(message);
    },
    (error) => {
      for (const handler of errorHandlers) handler(error);
    }
  );

  output?.on("data", parser);
  errorOutput?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (!text) return;
    const error = new Error(text);
    for (const handler of errorHandlers) handler(error);
  });

  return {
    send(frame) {
      if (!input || input.destroyed || input.writableEnded) throw new Error("protocol transport input is closed");
      input.write(frame);
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onError(handler) {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    close() {
      if (typeof input?.end === "function" && !input.writableEnded) input.end();
      if (options.destroyOutput && typeof output?.destroy === "function" && !output.destroyed) output.destroy();
    },
    get bufferedBytes() {
      return parser.bufferedBytes ?? 0;
    }
  };
}

export function spawnProtocolProcess(command, args = [], options = {}) {
  const child = spawnTracked({
    command,
    args,
    options: {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: options.windowsHide ?? true,
      shell: false
    },
    label: `protocol:${String(command).split(/[\\/]/).pop()}`
  });
  const transport = createStdioTransport({
    input: child.stdin,
    output: child.stdout,
    error: child.stderr
  });
  const close = () => {
    transport.close();
    if (child?.pid) {
      // Direct kill first (keeps child.killed semantics for callers), then
      // sweep the whole tree so grandchildren cannot linger.
      if (!child.killed) child.kill(options.signal ?? "SIGTERM");
      void killProcessTree(child.pid, { signal: options.signal ?? "SIGKILL" });
    }
  };
  return { process: child, transport, close };
}

/**
 * Connect to an external protocol adapter over TCP (e.g. debugpy.adapter,
 * which is a TCP server rather than a stdio process). Returns the same
 * transport interface as spawnProtocolProcess so callers are interchangeable.
 */
export function connectProtocolSocket(host, port, options = {}) {
  const socket = net.createConnection({ host, port });
  const transport = createStdioTransport({
    input: socket,
    output: socket,
    error: undefined
  }, { destroyOutput: true });
  const close = () => {
    transport.close();
    if (!socket.destroyed) socket.destroy();
  };
  return { socket, transport, close, kind: "tcp" };
}
