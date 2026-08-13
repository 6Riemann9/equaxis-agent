// Runtime profile selection per docs/ARCHITECTURE_REDUCTION_DIRECTIVE.md.
// Profiles decide WHICH extensions load; they never reimplement policy.
//
//   raw      - no Equaxis extensions (Pi baseline)
//   minimal  - governance core only: policy, approval, trace, budgets
//   standard - minimal + local in-process engineering tools (protocol/AST/catalog/scheduler)
//   full     - everything explicitly enabled in the manifest
//
// A profile is a selection policy, not a feature flag: users can still
// add/remove individual extensions via the extensions.enabled/disabled lists.

export const RUNTIME_PROFILES = Object.freeze({
  raw: { label: "raw", extensionIds: [] },
  minimal: {
    label: "minimal",
    extensionIds: ["harness-panel", "dashboard-command"]
  },
  standard: {
    label: "standard",
    extensionIds: [
      "harness-panel",
      "dashboard-command",
      "protocol-tools",
      "ast-tools",
      "tool-catalog",
      "tool-scheduler"
    ]
  },
  // null means "load every contract in the manifest" (subject to enabled/disabled).
  full: { label: "full", extensionIds: null }
});

export function isRuntimeProfile(value) {
  return value === "raw" || value === "minimal" || value === "standard" || value === "full";
}

/**
 * Resolve the extension selection for a runtime profile.
 *
 * Returns:
 *   - null                     for raw (no Equaxis extensions at all)
 *   - { enabled: string[] }    otherwise; empty array means "every manifest
 *                              contract" (full). Fatal contracts are always
 *                              loaded by extensionPaths regardless of the list.
 *
 * Individual extensions.enabled entries are merged in, and
 * extensions.disabled entries are always removed (explicit wins over profile).
 */
export function profileExtensionSelection(profile, selection = {}) {
  if (!isRuntimeProfile(profile)) {
    throw new Error("unknown runtime profile: " + String(profile));
  }
  if (profile === "raw") return null;
  const definition = RUNTIME_PROFILES[profile];
  const extra = new Set(Array.isArray(selection.enabled) ? selection.enabled : []);
  const excluded = new Set(Array.isArray(selection.disabled) ? selection.disabled : []);
  if (definition.extensionIds === null) {
    return { enabled: [...extra].filter((id) => !excluded.has(id)) };
  }
  const enabled = [...new Set([...definition.extensionIds, ...extra])]
    .filter((id) => !excluded.has(id));
  return { enabled };
}
