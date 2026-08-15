import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createExtensionRuntimeServices } from "../../src/extension-runtime-services.mjs";
import { listRefines, recordRefine, rollbackRefine } from "../../src/refine-ledger.mjs";

interface RefineConfig {
  enabled: boolean;
  rootDir: string;
}

/**
 * Refine ledger (prime-agent /refine minimal slice): one audit trail for
 * small evidence-backed refinement ops (notes / prompt fragments / files)
 * with before/after snapshots and rollback by id. The base system prompt
 * stays immutable — refinements land in the ledger's own directories.
 */
export default function equaxisRefine(pi: ExtensionAPI): void {
  const services = createExtensionRuntimeServices({ cwd: process.cwd(), extensionId: "refine", pi });
  let config = services.config.refine as RefineConfig;

  function trace(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}): void {
    services.trace.record(ctx, event, data);
  }

  pi.registerCommand("equaxis-refine", {
    description:
      "Refinement ledger: list [kind] | record <kind> <target> <text> | rollback <id>. Kinds: note, prompt, file. Every op snapshots before/after; rollback restores by id.",
    handler: async (args, ctx) => {
      if (!config.enabled) {
        ctx.ui.notify("Refine ledger is disabled (.pi/equaxis.json refine.enabled)", "info");
        return;
      }
      const [subcommand, ...rest] = args.trim().split(/\s+/);
      try {
        switch (subcommand ?? "list") {
          case "list": {
            const kind = rest[0] && ["note", "prompt", "file"].includes(rest[0]) ? rest[0] : undefined;
            const records = listRefines({ projectRoot: services.paths.workspace, rootDir: config.rootDir, kind, limit: 20 });
            ctx.ui.notify(
              records.length
                ? `Refine ledger (${kind ?? "all"}):\n` + records.map((record) => `- ${record.id.slice(0, 14)} ${record.action} ${record.kind} ${record.target} @ ${record.at}`).join("\n")
                : "Refine ledger: empty",
              "info"
            );
            return;
          }
          case "record": {
            const [kind, target, ...text] = rest;
            if (!kind || !target || !text.length) throw new Error("record requires <kind> <target> <text>");
            if (!["note", "prompt", "file"].includes(kind)) throw new Error("kind must be note, prompt, or file");
            const record = recordRefine({
              projectRoot: services.paths.workspace,
              rootDir: config.rootDir,
              kind: kind as "note" | "prompt" | "file",
              action: "create",
              target,
              content: text.join(" "),
              evidence: ["/equaxis-refine"]
            });
            trace(ctx, "refine_recorded", { id: record.id, kind, target: record.target, action: record.action });
            ctx.ui.notify(`Refinement recorded: ${record.id} (${kind} ${record.target})`, "info");
            return;
          }
          case "rollback": {
            const id = rest[0] ?? "";
            if (!id) throw new Error("rollback requires <id>");
            const record = rollbackRefine(id, { projectRoot: services.paths.workspace, rootDir: config.rootDir });
            trace(ctx, "refine_rolled_back", { id, target: record.target, kind: record.kind });
            ctx.ui.notify(`Rolled back ${id} (${record.kind} ${record.target})`, "info");
            return;
          }
          default:
            throw new Error(`unknown subcommand: ${subcommand}`);
        }
      } catch (error) {
        ctx.ui.notify(`equaxis-refine: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    services.configure(ctx.cwd);
    config = services.config.refine as RefineConfig;
    if (!config.enabled) return;
    const records = listRefines({ projectRoot: services.paths.workspace, rootDir: config.rootDir, limit: 1 });
    trace(ctx, "refine_status", { enabled: true, latest: records[0]?.id ?? null, count: listRefines({ projectRoot: services.paths.workspace, rootDir: config.rootDir }).length });
  });
}
