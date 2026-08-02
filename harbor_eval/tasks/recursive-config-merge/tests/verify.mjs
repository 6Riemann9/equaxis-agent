import assert from "node:assert/strict";
import { mergeConfig } from "/app/src/merge-config.mjs";

const base = {
  service: { host: "localhost", ports: [80], tls: { enabled: false, cert: null } },
  features: { audit: true }
};
const override = {
  service: { ports: [443], tls: { enabled: true } },
  features: { trace: true }
};
const beforeBase = structuredClone(base);
const beforeOverride = structuredClone(override);
const result = mergeConfig(base, override);

assert.deepEqual(result, {
  service: { host: "localhost", ports: [443], tls: { enabled: true, cert: null } },
  features: { audit: true, trace: true }
});
assert.deepEqual(base, beforeBase);
assert.deepEqual(override, beforeOverride);
assert.notEqual(result.service, base.service);
assert.notEqual(result.features, override.features);

assert.deepEqual(
  mergeConfig({ value: { old: true }, list: [1, 2] }, { value: null, list: [] }),
  { value: null, list: [] }
);
