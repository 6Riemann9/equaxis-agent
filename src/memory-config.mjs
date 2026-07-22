import fs from "node:fs";
import path from "node:path";

export const DEFAULT_MEMORY_CONFIG = Object.freeze({
  enabled: true,
  pythonCommand: "python",
  rootDir: ".equaxis/memory",
  autoRecall: true,
  defaultWing: "equaxis",
  defaultRoom: "general",
  recallLimit: 5,
  maxContextChars: 8000,
  maxStoredMessageChars: 24000,
  requestTimeoutMs: 60000
});

export function loadMemoryConfig(cwd) {
  const configPath = path.join(cwd, ".pi", "memory.json");
  if (!fs.existsSync(configPath)) return structuredClone(DEFAULT_MEMORY_CONFIG);
  const custom = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return { ...structuredClone(DEFAULT_MEMORY_CONFIG), ...custom };
}
