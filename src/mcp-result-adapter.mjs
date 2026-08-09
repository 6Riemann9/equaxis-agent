import { parseResourceUri } from "./resource-uri.mjs";

function textFromContent(item) {
  if (item?.type === "text") return String(item.text ?? "");
  if (item?.type === "resource") return String(item.resource?.text ?? item.resource?.uri ?? "");
  return "";
}

/** Normalize common MCP tool result variants without discarding the original payload. */
export function normalizeMcpResult(input) {
  const response = input?.response ?? {};
  const content = Array.isArray(response.content) ? response.content : [];
  const texts = content.map(textFromContent).filter(Boolean);
  const resources = content
    .filter((item) => item?.type === "resource")
    .map((item) => ({
      uri: item.resource?.uri,
      mimeType: item.resource?.mimeType,
      text: item.resource?.text
    }));
  const sourceResources = resources
    .map((resource) => parseResourceUri(resource.uri))
    .filter((resource) => resource.ok);
  const structured = response.structuredContent ?? response.data ?? null;
  const isError = response.isError === true || response.ok === false;
  const errorText = isError ? texts.join("\n") || String(response.error?.message ?? "MCP tool failed") : null;
  return {
    ok: !isError,
    data: {
      text: texts.join("\n"),
      texts,
      structured,
      resources,
      content
    },
    error: errorText ? { code: response.error?.code ?? "MCP_TOOL_ERROR", message: errorText } : null,
    meta: {
      protocol: "mcp",
      server: input.server,
      tool: input.tool,
      requestId: input.requestId,
      contentTypes: content.map((item) => item?.type).filter(Boolean),
      sourceUris: sourceResources.map((resource) => resource.normalized),
      sourceResources,
      raw: response
    }
  };
}

export function createMcpResultAdapter(call, identity = {}) {
  return async function callMcpTool(args, context = {}) {
    const response = await call(args, context);
    return normalizeMcpResult({ ...identity, requestId: context.requestId, response });
  };
}

