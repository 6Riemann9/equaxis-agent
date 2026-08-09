import { pathToFileURL } from "node:url";

function encodeMessage(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function fileUri(path) {
  if (/^file:/.test(String(path))) return String(path);
  return pathToFileURL(String(path)).href;
}

export class LspClient {
  constructor(transport, options = {}) {
    this.transport = transport;
    this.rootUri = options.rootUri ?? fileUri(options.rootPath ?? process.cwd());
    this.name = options.name ?? "equaxis-lsp";
    this.version = options.version ?? "0.1.0";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.nextId = 1;
    this.pending = new Map();
    this.diagnostics = new Map();
    this.capabilities = null;
    this.transport.onMessage?.((message) => this.handleMessage(message));
  }

  send(payload) {
    this.transport.send(encodeMessage(payload));
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("LSP request timed out after " + this.requestTimeoutMs + "ms: " + method));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
    });
    this.send(payload);
    return promise;
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async initialize(options = {}) {
    const result = await this.request("initialize", {
      processId: options.processId ?? process.pid,
      rootUri: options.rootUri ?? this.rootUri,
      clientInfo: { name: this.name, version: this.version },
      capabilities: options.capabilities ?? {}
    });
    this.capabilities = result?.capabilities ?? {};
    this.notify("initialized", {});
    return result;
  }

  openDocument(path, text, languageId = "plaintext", version = 1) {
    const uri = fileUri(path);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text: String(text) }
    });
    return uri;
  }

  definition(path, position) {
    return this.request("textDocument/definition", {
      textDocument: { uri: fileUri(path) },
      position
    });
  }

  handleMessage(message) {
    if (message?.method === "textDocument/publishDiagnostics") {
      const uri = message.params?.uri;
      if (uri) this.diagnostics.set(uri, message.params?.diagnostics ?? []);
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(message ?? {}, "id")) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message ?? `LSP error ${message.error.code}`));
    else pending.resolve(message.result);
  }

  getDiagnostics(pathOrUri) {
    return this.diagnostics.get(fileUri(pathOrUri)) ?? [];
  }
}

export function createMemoryLspTransport(server) {
  let onClientMessage = null;
  let onServerMessage = null;
  return {
    client: {
      send(frame) {
        const body = String(frame).split("\r\n\r\n").slice(1).join("\r\n\r\n");
        onClientMessage?.(JSON.parse(body));
      },
      onMessage(handler) { onServerMessage = handler; }
    },
    server: {
      onMessage(handler) { onClientMessage = handler; },
      send(message) { onServerMessage?.(message); },
      implementation: server
    }
  };
}
