import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildAdvisorRequest } from "../../src/advisor.mjs";
import { DapClient, createMemoryDapTransport } from "../../src/dap-client.mjs";
import { createExtensionRuntimeServices } from "../../src/extension-runtime-services.mjs";
import { LspClient, createMemoryLspTransport } from "../../src/lsp-client.mjs";
import { spawnProtocolProcess } from "../../src/protocol-transport.mjs";

interface ToolContextState {
  ctx?: ExtensionContext;
}

interface LspProbeMessage {
  id?: number;
  method?: string;
  params?: {
    textDocument?: { uri?: string };
  };
}

interface DapProbeMessage {
  seq: number;
  command: string;
  arguments?: {
    breakpoints?: Array<{ line?: number }>;
  };
}

interface ProtocolProcessParams {
  mode?: "memory" | "process";
  command?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

const PositionSchema = Type.Object({
  line: Type.Integer({ minimum: 0 }),
  character: Type.Integer({ minimum: 0 })
});

const BreakpointSchema = Type.Object({
  line: Type.Integer({ minimum: 1 }),
  column: Type.Optional(Type.Integer({ minimum: 1 })),
  condition: Type.Optional(Type.String()),
  hitCondition: Type.Optional(Type.String()),
  logMessage: Type.Optional(Type.String())
});

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function evidenceFromText(text: string | undefined): Record<string, unknown> {
  const trimmed = String(text ?? "").trim();
  return trimmed ? { summary: trimmed } : {};
}

function resolveProtocolProcessParams(
  params: ProtocolProcessParams,
  configured: ProtocolProcessParams & { requestTimeoutMs?: number; allowCommandOverride?: boolean },
  label: "LSP" | "DAP"
): ProtocolProcessParams {
  const timeoutMs = params.timeoutMs ?? configured.requestTimeoutMs ?? 15_000;
  if (params.mode !== "process") return { ...params, timeoutMs };
  const allowOverride = configured.allowCommandOverride === true;
  const hasLaunchOverride = params.command !== undefined || params.args !== undefined || params.cwd !== undefined;
  if (hasLaunchOverride && !allowOverride) {
    throw new Error(`${label} process command override is disabled by configuration`);
  }
  return {
    ...params,
    command: allowOverride && params.command !== undefined ? params.command : configured.command,
    args: allowOverride && params.args !== undefined ? params.args : configured.args,
    cwd: allowOverride && params.cwd !== undefined ? params.cwd : (configured.cwd || undefined),
    timeoutMs
  };
}

function lspResponse(request: LspProbeMessage, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: request.id, result };
}

function dapResponse(request: DapProbeMessage, body: Record<string, unknown> = {}): Record<string, unknown> {
  return { seq: 10_000 + request.seq, type: "response", request_seq: request.seq, command: request.command, success: true, body };
}

async function runLspProbe(params: ProtocolProcessParams & {
  rootPath?: string;
  documentPath?: string;
  text?: string;
  languageId?: string;
  position?: { line: number; character: number };
  includeDiagnostics?: boolean;
}) {
  if (params.mode === "process" && !String(params.command ?? "").trim()) {
    throw new Error("LSP process command is required");
  }
  const processHandle = params.mode === "process"
    ? spawnProtocolProcess(String(params.command ?? ""), params.args ?? [], { cwd: params.cwd ?? params.rootPath ?? process.cwd() })
    : undefined;
  const memoryTransport = processHandle ? undefined : createMemoryLspTransport({ name: "equaxis-memory-lsp" });
  const transport = processHandle?.transport ?? memoryTransport!.client;
  const documentPath = params.documentPath ?? "probe.js";
  const text = String(params.text ?? "const value = 1;\nvalue;\n");
  const languageId = params.languageId ?? "javascript";
  const position = params.position ?? { line: 0, character: 0 };
  let openedUri = "";
  const transportErrors: string[] = [];
  if ("onError" in transport && typeof transport.onError === "function") {
    transport.onError((error: Error) => transportErrors.push(error.message));
  }

  if (!processHandle) {
    memoryTransport!.server.onMessage((message: LspProbeMessage) => {
      if (message.method === "initialize") {
        memoryTransport!.server.send(lspResponse(message, {
          capabilities: {
            textDocumentSync: 1,
            definitionProvider: true,
            diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false }
          },
          serverInfo: { name: "equaxis-memory-lsp", version: "0.1.0" }
        }));
        return;
      }
      if (message.method === "textDocument/didOpen") {
        openedUri = String(message.params?.textDocument?.uri ?? "");
        if (params.includeDiagnostics !== false) {
          const diagnostics = text.includes("TODO")
            ? [{ severity: 3, message: "TODO marker found by Equaxis LSP probe", range: { start: position, end: position } }]
            : [];
          memoryTransport!.server.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: openedUri, diagnostics } });
        }
        return;
      }
      if (message.method === "textDocument/definition") {
        const uri = String(message.params?.textDocument?.uri ?? openedUri);
        memoryTransport!.server.send(lspResponse(message, {
          uri,
          range: { start: position, end: position }
        }));
      }
    });
  }

  try {
    const client = new LspClient(transport, {
      rootPath: params.rootPath ?? params.cwd ?? process.cwd(),
      requestTimeoutMs: params.timeoutMs
    });
    const initialize = await client.initialize();
    const uri = client.openDocument(documentPath, text, languageId, 1);
    const definition = await client.definition(documentPath, position);
    return {
      mode: params.mode === "process" ? "process" : "in-memory-probe",
      initialized: Boolean(client.capabilities),
      capabilities: initialize?.capabilities ?? {},
      uri,
      definition,
      diagnostics: client.getDiagnostics(uri),
      transportErrors
    };
  } finally {
    processHandle?.close();
  }
}


async function runDapProbe(params: ProtocolProcessParams & {
  source?: string;
  breakpoints?: Array<{ line: number; column?: number; condition?: string; hitCondition?: string; logMessage?: string }>;
  expression?: string;
  request?: "launch" | "attach";
  program?: string;
  host?: string;
  port?: number;
}) {
  const request = params.request ?? "launch";
  if (params.mode === "process" && !String(params.command ?? "").trim()) {
    throw new Error("DAP process command is required");
  }
  if (params.mode === "process" && request === "launch" && !String(params.program ?? "").trim()) {
    throw new Error("DAP process program is required for launch");
  }
  if (params.mode === "process" && request === "attach" && (!String(params.host ?? "").trim() || !Number.isInteger(params.port))) {
    throw new Error("DAP process host and port are required for attach");
  }
  const processHandle = params.mode === "process"
    ? spawnProtocolProcess(String(params.command ?? ""), params.args ?? [], { cwd: params.cwd ?? process.cwd() })
    : undefined;
  const memoryTransport = processHandle ? undefined : createMemoryDapTransport();
  const transport = processHandle?.transport ?? memoryTransport!.client;
  const source = params.source ?? "probe.js";
  const breakpoints = params.breakpoints?.length ? params.breakpoints : [{ line: 1 }];
  const expression = params.expression ?? "1 + 1";
  const transportErrors: string[] = [];
  if ("onError" in transport && typeof transport.onError === "function") {
    transport.onError((error: Error) => transportErrors.push(error.message));
  }

  if (!processHandle) {
    memoryTransport!.server.onMessage((message: DapProbeMessage) => {
      if (message.command === "initialize") {
        memoryTransport!.server.send(dapResponse(message, { supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true }));
        memoryTransport!.server.send({ seq: 20_000, type: "event", event: "initialized", body: {} });
        return;
      }
      if (message.command === "launch" || message.command === "attach" || message.command === "configurationDone") {
        memoryTransport!.server.send(dapResponse(message));
        return;
      }
      if (message.command === "setBreakpoints") {
        memoryTransport!.server.send(dapResponse(message, {
          breakpoints: (message.arguments?.breakpoints ?? []).map((breakpoint: { line?: number }, index: number) => ({
            id: index + 1,
            verified: true,
            line: breakpoint.line ?? 1
          }))
        }));
        return;
      }
      if (message.command === "threads") {
        memoryTransport!.server.send(dapResponse(message, { threads: [{ id: 1, name: "main" }] }));
        return;
      }
      if (message.command === "stackTrace") {
        memoryTransport!.server.send(dapResponse(message, {
          stackFrames: [{ id: 101, name: "probe", line: 1, column: 1, source: { path: source } }],
          totalFrames: 1
        }));
        return;
      }
      if (message.command === "scopes") {
        memoryTransport!.server.send(dapResponse(message, { scopes: [{ name: "locals", variablesReference: 201, expensive: false }] }));
        return;
      }
      if (message.command === "variables") {
        memoryTransport!.server.send(dapResponse(message, { variables: [{ name: "value", value: "1", variablesReference: 0 }] }));
        return;
      }
      if (message.command === "evaluate") {
        memoryTransport!.server.send(dapResponse(message, { result: expression === "1 + 1" ? "2" : "ok", variablesReference: 0 }));
      }
    });
  }

  try {
    const client = new DapClient(transport, {
      adapterId: "equaxis-process-dap",
      requestTimeoutMs: params.timeoutMs
    });
    const capabilities = await client.initialize();
    if (request === "attach") {
      const attach = client.attach({ type: "python", request: "attach", name: "Equaxis attach", connect: { host: params.host, port: params.port }, justMyCode: false });
      await client.configurationDone();
      await attach;
    } else if (params.program) {
      const launch = client.launch({ type: "python", request: "launch", name: "Equaxis debug", program: params.program, cwd: params.cwd ?? process.cwd(), justMyCode: false });
      await client.configurationDone();
      await launch;
    }
    const breakpointResult = await client.setBreakpoints(source, breakpoints);
    if (!processHandle) {
      memoryTransport!.server.send({ seq: 30_000, type: "event", event: "thread", body: { reason: "started", threadId: 1 } });
      memoryTransport!.server.send({ seq: 30_001, type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1, allThreadsStopped: true } });
    }
    const threads = await client.threadsRequest();
    const stackTrace = threads?.threads?.[0] ? await client.stackTrace(threads.threads[0].id) : { stackFrames: [] };
    const frameId = stackTrace?.stackFrames?.[0]?.id;
    const scopes = frameId ? await client.scopes(frameId) : { scopes: [] };
    const variablesReference = scopes?.scopes?.[0]?.variablesReference;
    const variables = variablesReference ? await client.variables(variablesReference) : { variables: [] };
    const evaluation = frameId ? await client.evaluate(expression, { frameId }) : null;
    return {
      mode: params.mode === "process" ? "process" : "in-memory-probe",
      request,
      initialized: client.initialized,
      capabilities,
      breakpoints: breakpointResult?.breakpoints ?? [],
      threads: threads?.threads ?? [],
      stackFrames: stackTrace?.stackFrames ?? [],
      scopes: scopes?.scopes ?? [],
      variables: variables?.variables ?? [],
      evaluation,
      stopped: client.getStoppedEvent(),
      session: client.getSessionState(),
      transportErrors
    };
  } finally {
    processHandle?.close();
  }
}

export default function protocolToolsExtension(pi: ExtensionAPI): void {
  const state: ToolContextState = {};
  const services = createExtensionRuntimeServices({ cwd: process.cwd(), extensionId: "protocol-tools", pi });

  function trace(event: string, data: Record<string, unknown> = {}): void {
    if (!state.ctx) return;
    services.trace.record(state.ctx, event, data);
  }

  function updateStatus(ctx: ExtensionContext): void {
    services.status.set(ctx, "equaxis-protocol", "Protocol tools ready");
  }

  pi.registerTool({
    name: "advisor_consult",
    label: "Advisor Consult",
    description: "Build a redacted recommendation-only advisor request for high-risk tools, complex plans, or result reviews. Does not execute tools or approve actions.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("tool_call"), Type.Literal("plan"), Type.Literal("result")], { description: "Decision type to review" }),
      question: Type.Optional(Type.String({ description: "Question for the advisor" })),
      risk: Type.Optional(Type.String({ description: "Risk level such as high, medium, or low" })),
      steps: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: "Number of plan steps" })),
      needsReview: Type.Optional(Type.Boolean({ description: "Whether result review is explicitly requested" })),
      evidence: Type.Optional(Type.String({ description: "Concise evidence summary; do not include credentials" }))
    }),
    async execute(_toolCallId, params) {
      const config = services.config;
      const request = buildAdvisorRequest({
        kind: params.kind,
        question: params.question,
        risk: params.risk,
        steps: params.steps,
        needsReview: params.needsReview,
        evidence: evidenceFromText(params.evidence)
      }, config);
      const result = {
        consulted: false,
        reason: request.consult ? "advisor client not wired; request prepared" : request.reason,
        request
      };
      trace("advisor_consult", { kind: params.kind, consult: request.consult, reason: result.reason });
      return {
        content: [{ type: "text", text: formatJson(result) }],
        details: result
      };
    }
  });

  pi.registerTool({
    name: "lsp_probe",
    label: "LSP Probe",
    description: "Run an in-memory Language Server Protocol probe or connect to a configured external language server over stdio.",
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal("memory"), Type.Literal("process")], { default: "memory" })),
      command: Type.Optional(Type.String({ description: "External language server command; only used with mode=process" })),
      args: Type.Optional(Type.Array(Type.String(), { maxItems: 32, description: "Arguments for the external language server" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the external language server" })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 120000, default: 15000, description: "Maximum wait per LSP request" })),
      rootPath: Type.Optional(Type.String({ description: "Workspace root for the probe" })),
      documentPath: Type.Optional(Type.String({ description: "Document path used in the probe" })),
      text: Type.Optional(Type.String({ description: "Document text; TODO produces a sample diagnostic" })),
      languageId: Type.Optional(Type.String({ description: "LSP language id" })),
      position: Type.Optional(PositionSchema),
      includeDiagnostics: Type.Optional(Type.Boolean({ default: true }))
    }),
    async execute(_toolCallId, params) {
      const result = await runLspProbe(resolveProtocolProcessParams(
        params,
        services.config.protocols.lsp,
        "LSP"
      ));
      trace("lsp_probe", { mode: result.mode, diagnostics: result.diagnostics.length, definition: Boolean(result.definition) });
      return {
        content: [{ type: "text", text: formatJson(result) }],
        details: result
      };
    }
  });

  pi.registerTool({
    name: "dap_probe",
    label: "DAP Probe",
    description: "Run an in-memory Debug Adapter Protocol probe or connect to an external debug adapter over stdio.",
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal("memory"), Type.Literal("process")], { default: "memory" })),
      command: Type.Optional(Type.String({ description: "External debug adapter command; only used with mode=process" })),
      args: Type.Optional(Type.Array(Type.String(), { maxItems: 32, description: "Arguments for the external debug adapter" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the external debug adapter" })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 120000, default: 15000, description: "Maximum wait per DAP request" })),
      request: Type.Optional(Type.Union([Type.Literal("launch"), Type.Literal("attach")], { default: "launch", description: "Start a configured program or attach to a debugpy server" })),
      source: Type.Optional(Type.String({ description: "Source path or URI for breakpoint and stack-frame requests" })),
      breakpoints: Type.Optional(Type.Array(BreakpointSchema, { maxItems: 20 })),
      expression: Type.Optional(Type.String({ description: "Expression for the evaluate request" })),
      program: Type.Optional(Type.String({ description: "Program passed to a DAP launch request" })),
      host: Type.Optional(Type.String({ description: "Debug server host for attach requests" })),
      port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: "Debug server port for attach requests" }))
    }),
    async execute(_toolCallId, params) {
      const result = await runDapProbe(resolveProtocolProcessParams(
        params,
        services.config.protocols.dap,
        "DAP"
      ));
      trace("dap_probe", { mode: result.mode, request: result.request, phase: result.session.phase, breakpoints: result.breakpoints.length, threads: result.threads.length });
      return {
        content: [{ type: "text", text: formatJson(result) }],
        details: result
      };
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    state.ctx = ctx;
    services.configure(ctx.cwd);
    updateStatus(ctx);
    trace("protocol_tools_started", { advisorEnabled: Boolean(services.config.advisor?.enabled) });
  });
}
