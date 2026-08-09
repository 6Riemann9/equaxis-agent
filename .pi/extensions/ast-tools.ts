import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createExtensionRuntimeServices } from "../../src/extension-runtime-services.mjs";
import { inspectAst, renameAst } from "../../src/ast-tools.mjs";

const PositionFields = {
  path: Type.String({ minLength: 1, description: "Workspace-relative JavaScript or TypeScript file" }),
  line: Type.Integer({ minimum: 0, description: "Zero-based line" }),
  character: Type.Integer({ minimum: 0, description: "Zero-based character" })
};

export default function astToolsExtension(pi: ExtensionAPI): void {
  const services = createExtensionRuntimeServices({ cwd: process.cwd(), extensionId: "ast-tools", pi });
  let context: ExtensionContext | undefined;
  const trace = (event: string, data: Record<string, unknown>) => {
    if (context) services.trace.record(context, event, data);
  };

  pi.registerTool({
    name: "ast_inspect",
    label: "AST Inspect",
    description: "Inspect a TypeScript or JavaScript symbol, definition, and rename capability at a source position.",
    promptSnippet: "Inspect a JavaScript or TypeScript symbol at a file position",
    parameters: Type.Object(PositionFields),
    async execute(_toolCallId, params) {
      const result = inspectAst(params, { cwd: context?.cwd ?? process.cwd() });
      trace("ast_inspect", { path: result.path, canRename: result.canRename });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    }
  });

  pi.registerTool({
    name: "ast_rename",
    label: "AST Rename",
    description: "Preview or safely apply a TypeScript or JavaScript symbol rename. Applying requires an expectedHash from a fresh preview.",
    promptSnippet: "Preview or apply a hash-checked AST symbol rename",
    promptGuidelines: [
      "Call ast_rename with apply=false first and use its expectedHash for a later apply=true call.",
      "The target must be a JavaScript or TypeScript file in the workspace and the rename stays within that file."
    ],
    parameters: Type.Object({
      ...PositionFields,
      newName: Type.String({ minLength: 1, description: "New JavaScript identifier" }),
      apply: Type.Optional(Type.Boolean({ default: false, description: "Write the rename; requires expectedHash" })),
      expectedHash: Type.Optional(Type.String({ minLength: 64, maxLength: 64, description: "SHA-256 returned by a fresh preview" }))
    }),
    async execute(_toolCallId, params) {
      const result = renameAst(params, { cwd: context?.cwd ?? process.cwd() });
      trace("ast_rename", { path: result.path, applied: result.applied, editCount: result.editCount });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    services.configure(ctx.cwd);
    services.status.set(ctx, "equaxis-ast", "AST tools ready");
    trace("ast_tools_started", {});
  });
}