export function mergeConfig(base, override) {
  return { ...base, ...override };
}
