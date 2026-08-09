import fs from "node:fs";
import path from "node:path";
import { loadEquaxisConfig, unifiedConfigPath } from "./equaxis-config.mjs";

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function runConfigMigration(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const configPath = unifiedConfigPath(projectRoot);
  const before = readJsonIfPresent(configPath);
  const config = loadEquaxisConfig(projectRoot);
  const beforeText = before ? stableJson(before) : "";
  const afterText = stableJson(config);
  const changed = beforeText !== afterText;
  const dryRun = options.dryRun !== false;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, afterText, "utf8");
  }
  return {
    ok: true,
    path: configPath,
    dryRun,
    written: !dryRun,
    changed,
    schemaVersion: config.schemaVersion,
    config
  };
}

export function formatConfigMigrationReport(report) {
  const lines = ["Equaxis config migration", `Path: ${report.path}`, `Schema: ${report.schemaVersion}`, `Changed: ${report.changed ? "yes" : "no"}`, `Written: ${report.written ? "yes" : "no"}`];
  return lines.join("\n");
}
