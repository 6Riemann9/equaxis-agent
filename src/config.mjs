import { DEFAULT_EQUAXIS_CONFIG, loadEquaxisConfig, validateEquaxisConfig } from "./equaxis-config.mjs";

export const DEFAULT_CONFIG = structuredClone(DEFAULT_EQUAXIS_CONFIG.reliability);

export function validateConfig(config, configPath = ".pi/reliability.json") {
  const unified = {
    ...structuredClone(DEFAULT_EQUAXIS_CONFIG),
    reliability: {
      ...structuredClone(DEFAULT_EQUAXIS_CONFIG.reliability),
      ...config,
      trace: { ...DEFAULT_EQUAXIS_CONFIG.reliability.trace, ...(config.trace ?? {}) },
      approval: { ...DEFAULT_EQUAXIS_CONFIG.reliability.approval, ...(config.approval ?? {}) },
      limits: { ...DEFAULT_EQUAXIS_CONFIG.reliability.limits, ...(config.limits ?? {}) },
      toolRouting: { ...DEFAULT_EQUAXIS_CONFIG.reliability.toolRouting, ...(config.toolRouting ?? {}) }
    }
  };
  validateEquaxisConfig(unified, configPath);
  return unified.reliability;
}

export function loadConfig(cwd) {
  const unified = loadEquaxisConfig(cwd);
  return {
    ...unified.reliability,
    schemaVersion: unified.schemaVersion,
    runtime: unified.runtime,
    extensions: unified.extensions,
    memory: unified.memory,
    unified
  };
}
