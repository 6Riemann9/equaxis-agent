import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  mode: "enforce",
  traceDir: ".pi/runtime",
  protectPaths: [".env", ".git/", "node_modules/", "*.pem", "*.key"],
  approval: { highRiskBash: true, writesOutsideWorkspace: true, sessionFork: false },
  limits: { maxToolCallsPerTurn: 30, maxHighRiskCallsPerTurn: 3, maxRepairAttemptsPerError: 2 },
  toolRouting: { enabled: true, maxCandidates: 5 }
});

export function loadConfig(cwd) {
  const configPath = path.join(cwd, ".pi", "reliability.json");
  if (!fs.existsSync(configPath)) return structuredClone(DEFAULT_CONFIG);
  const custom = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...custom,
    approval: { ...DEFAULT_CONFIG.approval, ...(custom.approval ?? {}) },
    limits: { ...DEFAULT_CONFIG.limits, ...(custom.limits ?? {}) },
    toolRouting: { ...DEFAULT_CONFIG.toolRouting, ...(custom.toolRouting ?? {}) }
  };
}
