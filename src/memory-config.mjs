import { DEFAULT_EQUAXIS_CONFIG, loadEquaxisConfig, validateEquaxisConfig } from "./equaxis-config.mjs";

export const DEFAULT_MEMORY_CONFIG = structuredClone(DEFAULT_EQUAXIS_CONFIG.memory);

export function validateMemoryConfig(config, configPath = ".pi/memory.json") {
  const unified = {
    ...structuredClone(DEFAULT_EQUAXIS_CONFIG),
    memory: { ...structuredClone(DEFAULT_EQUAXIS_CONFIG.memory), ...config }
  };
  validateEquaxisConfig(unified, configPath);
  return unified.memory;
}

export function loadMemoryConfig(cwd) {
  return loadEquaxisConfig(cwd).memory;
}
