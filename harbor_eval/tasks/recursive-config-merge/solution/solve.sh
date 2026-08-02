#!/bin/bash
cat > /app/src/merge-config.mjs <<'EOF'
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mergeConfig(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return structuredClone(override);
  }
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(base[key])
      ? mergeConfig(base[key], value)
      : structuredClone(value);
  }
  return result;
}
EOF
