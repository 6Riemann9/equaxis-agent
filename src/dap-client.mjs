import { fileURLToPath, pathToFileURL } from "node:url";

function encodeMessage(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function parseFrame(frame) {
  const text = String(frame ?? "");
  const body = text.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  if (!body.trim()) throw new Error("invalid DAP frame");
  return JSON.parse(body);
}

function fileUri(value) {
  if (typeof value !== "string") return String(value ?? "");
  if (/^file:/.test(value)) return value;
  return pathToFileURL(value).href;
}

function filePathOrUri(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("source path is required");
  if (/^file:/.test(text)) return { path: fileURLToPath(text) };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return { uri: text };
  return { path: text };
}

function normalizeBreakpoints(breakpoints = []) {
  return breakpoints.map((breakpoint) => ({
    line: breakpoint.line,
    column: breakpoint.column,
    condition: breakpoint.condition,
    hitCondition: breakpoint.hitCondition,
    logMessage: breakpoint.logMessage
  }));
}

function sourceKey(source) {
  if (!source) return "";
  if (typeof source === "string") return /^file:/.test(source) ? source : fileUri(source);
  if (typeof source === "object") {
    if (typeof source.uri === "string" && source.uri.trim()) return source.uri;
    if (typeof source.path === "string" && source.path.trim()) return fileUri(source.path);
    if (typeof source.sourceReference !== "undefined") return `sourceReference:${String(source.sourceReference)}`;
  }
  return String(source);
}

function normalizeThread(event) {
  const threadId = Number(event?.body?.threadId ?? event?.body?.id ?? 0);
  return {
    id: threadId,
    name: String(event?.body?.name ?? `thread-${threadId}`),
    reason: String(event?.body?.reason ?? event?.event ?? "updated")
  };
}

export class DapClient {
  constructor(transport, options = {}) {
    this.transport = transport;
    this.name = options.name ?? "equaxis-dap";
    this.adapterId = options.adapterId ?? this.name;
    this.version = options.version ?? "0.1.0";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.rootPath = options.rootPath ?? process.cwd();
    this.rootUri = options.rootUri ?? fileUri(this.rootPath);
    this.seq = 1;
    this.pending = new Map();
    this.capabilities = null;
    this.initialized = false;
    this.terminated = false;
    this.exitedCode = null;
    this.stopped = null;
    this.events = [];
    this.outputs = [];
    this.threads = new Map();
    this.stackFrames = new Map();
    this.scopeCache = new Map();
    this.variableCache = new Map();
    this.breakpoints = new Map();
    this.lastEvaluation = null;
    this.transport.onMessage?.((message) => this.handleMessage(message));
  }

  send(payload) {
    this.transport.send(encodeMessage(payload));
  }

  request(command, args = {}) {
    const seq = this.seq++;
    const payload = { seq, type: "request", command, arguments: args };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error("DAP request timed out after " + this.requestTimeoutMs + "ms: " + command));
      }, this.requestTimeoutMs);
      this.pending.set(seq, { resolve, reject, command, args, timer });
    });
    this.send(payload);
    return promise;
  }

  sendResponse(request, body = {}) {
    this.send({ seq: this.seq++, type: "response", request_seq: request.seq, command: request.command, success: true, body });
  }

  async initialize(options = {}) {
    const result = await this.request("initialize", {
      clientID: options.clientID ?? this.name,
      clientName: options.clientName ?? this.name,
      adapterID: options.adapterID ?? this.adapterId,
      locale: options.locale,
      linesStartAt1: options.linesStartAt1 ?? true,
      columnsStartAt1: options.columnsStartAt1 ?? true,
      pathFormat: options.pathFormat ?? "path",
      supportsVariableType: options.supportsVariableType ?? true,
      supportsVariablePaging: options.supportsVariablePaging ?? true,
      supportsRunInTerminalRequest: options.supportsRunInTerminalRequest ?? false,
      supportsMemoryReferences: options.supportsMemoryReferences ?? false,
      supportsProgressReporting: options.supportsProgressReporting ?? false,
      supportsInvalidatedEvent: options.supportsInvalidatedEvent ?? false,
      supportsExceptionFilterOptions: options.supportsExceptionFilterOptions ?? true,
      supportsValueFormattingOptions: options.supportsValueFormattingOptions ?? true,
      supportsSingleThreadExecutionRequests: options.supportsSingleThreadExecutionRequests ?? false,
      ...options.capabilities
    });
    this.capabilities = result ?? {};
    return result;
  }

  launch(args = {}) {
    return this.request("launch", args);
  }

  attach(args = {}) {
    return this.request("attach", args);
  }

  configurationDone(args = {}) {
    return this.request("configurationDone", args);
  }

  disconnect(args = {}) {
    return this.request("disconnect", args);
  }

  continue(threadId, args = {}) {
    return this.request("continue", { threadId, singleThread: args.singleThread ?? false, ...args });
  }

  pause(threadId) {
    return this.request("pause", { threadId });
  }

  next(threadId) {
    return this.request("next", { threadId });
  }

  stepIn(threadId, args = {}) {
    return this.request("stepIn", { threadId, ...args });
  }

  stepOut(threadId, args = {}) {
    return this.request("stepOut", { threadId, ...args });
  }

  setBreakpoints(source, breakpoints = [], args = {}) {
    const descriptor = typeof source === "string" ? filePathOrUri(source) : source;
    const key = sourceKey(descriptor);
    return this.request("setBreakpoints", {
      source: descriptor,
      breakpoints: normalizeBreakpoints(breakpoints),
      sourceModified: Boolean(args.sourceModified)
    }).then((result) => {
      this.breakpoints.set(key, result?.breakpoints ?? []);
      return result;
    });
  }

  setExceptionBreakpoints(filters = [], args = {}) {
    return this.request("setExceptionBreakpoints", {
      filters: [...filters],
      filterOptions: args.filterOptions ?? [],
      exceptionOptions: args.exceptionOptions ?? []
    });
  }

  threadsRequest() {
    return this.request("threads").then((result) => {
      const threads = result?.threads ?? [];
      for (const thread of threads) this.threads.set(Number(thread.id), { ...thread });
      return result;
    });
  }

  stackTrace(threadId, args = {}) {
    return this.request("stackTrace", {
      threadId,
      startFrame: args.startFrame ?? 0,
      levels: args.levels ?? 20,
      format: args.format
    }).then((result) => {
      this.stackFrames.set(Number(threadId), result?.stackFrames ?? []);
      return result;
    });
  }

  scopes(frameId) {
    return this.request("scopes", { frameId }).then((result) => {
      this.scopeCache.set(Number(frameId), result?.scopes ?? []);
      return result;
    });
  }

  variables(variablesReference, args = {}) {
    return this.request("variables", {
      variablesReference,
      filter: args.filter,
      start: args.start ?? 0,
      count: args.count ?? 100,
      format: args.format
    }).then((result) => {
      this.variableCache.set(Number(variablesReference), result?.variables ?? []);
      return result;
    });
  }

  evaluate(expression, args = {}) {
    return this.request("evaluate", {
      expression,
      frameId: args.frameId,
      context: args.context ?? "repl",
      format: args.format
    }).then((result) => {
      this.lastEvaluation = result ?? null;
      return result;
    });
  }

  handleMessage(message) {
    if (message?.type === "event") {
      this.events.push(message);
      if (message.event === "initialized") {
        this.initialized = true;
      } else if (message.event === "stopped") {
        this.stopped = {
          reason: String(message.body?.reason ?? "stopped"),
          threadId: message.body?.threadId ?? null,
          allThreadsStopped: Boolean(message.body?.allThreadsStopped)
        };
      } else if (message.event === "continued") {
        this.stopped = null;
      } else if (message.event === "thread") {
        const thread = normalizeThread(message);
        if (thread.reason === "started") {
          this.threads.set(thread.id, thread);
        } else if (thread.reason === "exited") {
          this.threads.delete(thread.id);
        }
      } else if (message.event === "output") {
        this.outputs.push({ category: String(message.body?.category ?? "console"), output: String(message.body?.output ?? "") });
      } else if (message.event === "breakpoint") {
        this.events.push({ type: "breakpoint", body: message.body ?? {} });
      } else if (message.event === "terminated") {
        this.terminated = true;
      } else if (message.event === "exited") {
        this.exitedCode = Number(message.body?.exitCode ?? 0);
      }
      return;
    }
    if (message?.type !== "response") return;
    const pending = this.pending.get(message.request_seq);
    if (!pending) return;
    this.pending.delete(message.request_seq);
    clearTimeout(pending.timer);
    if (message.success === false || message.error) {
      pending.reject(new Error(message.message ?? message.error?.message ?? `${message.command} failed`));
      return;
    }
    pending.resolve(message.body ?? null);
  }

  getThreads() {
    return [...this.threads.values()];
  }

  getThread(threadId) {
    return this.threads.get(Number(threadId)) ?? null;
  }

  getBreakpoints(source) {
    return this.breakpoints.get(sourceKey(source)) ?? [];
  }

  getStackFrames(threadId) {
    return this.stackFrames.get(Number(threadId)) ?? [];
  }

  getScopes(frameId) {
    return this.scopeCache.get(Number(frameId)) ?? [];
  }

  getVariables(variablesReference) {
    return this.variableCache.get(Number(variablesReference)) ?? [];
  }

  getOutput() {
    return [...this.outputs];
  }

  getStoppedEvent() {
    return this.stopped;
  }

  getSessionState() {
    const phase = this.terminated
      ? "terminated"
      : this.exitedCode !== null
        ? "exited"
        : this.stopped
          ? "stopped"
          : this.threads.size
            ? "running"
            : this.initialized
              ? "initialized"
              : "created";
    return {
      phase,
      initialized: this.initialized,
      terminated: this.terminated,
      exitedCode: this.exitedCode,
      stopped: this.stopped,
      threadCount: this.threads.size,
      eventCount: this.events.length,
      outputCount: this.outputs.length
    };
  }
}

export function createMemoryDapTransport() {
  let onClientMessage = null;
  let onServerMessage = null;
  return {
    client: {
      send(frame) {
        onClientMessage?.(parseFrame(frame));
      },
      onMessage(handler) {
        onServerMessage = handler;
      }
    },
    server: {
      onMessage(handler) {
        onClientMessage = handler;
      },
      send(message) {
        onServerMessage?.(message);
      }
    }
  };
}
