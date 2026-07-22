import test from "node:test";
import assert from "node:assert/strict";
import { createMcpResultAdapter, normalizeMcpResult } from "../src/mcp-result-adapter.mjs";

test("normalizes MCP text, structured content and resources", () => {
  const result = normalizeMcpResult({
    server: "eval-server", tool: "score", requestId: "r-1",
    response: {
      content: [
        { type: "text", text: "score=0.91" },
        { type: "resource", resource: { uri: "kb://case-1", mimeType: "text/plain", text: "evidence" } }
      ],
      structuredContent: { score: 0.91 }
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.text, "score=0.91\nevidence");
  assert.deepEqual(result.data.structured, { score: 0.91 });
  assert.deepEqual(result.meta.sourceUris, ["kb://case-1"]);
  assert.equal(result.meta.raw.structuredContent.score, 0.91);
});

test("normalizes MCP errors without losing the error text", () => {
  const result = normalizeMcpResult({ server: "eval", tool: "judge", response: { isError: true, content: [{ type: "text", text: "timeout" }] } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MCP_TOOL_ERROR");
  assert.equal(result.error.message, "timeout");
});

test("adapter injects server/tool/request identity", async () => {
  const call = createMcpResultAdapter(async () => ({ content: [{ type: "text", text: "ok" }] }), { server: "s", tool: "t" });
  const result = await call({ query: "x" }, { requestId: "req-1" });
  assert.deepEqual(result.meta, {
    protocol: "mcp", server: "s", tool: "t", requestId: "req-1",
    contentTypes: ["text"], sourceUris: [], raw: { content: [{ type: "text", text: "ok" }] }
  });
});

