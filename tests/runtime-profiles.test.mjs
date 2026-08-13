import test from "node:test";
import assert from "node:assert/strict";
import { RUNTIME_PROFILES, isRuntimeProfile, profileExtensionSelection } from "../src/runtime-profiles.mjs";

test("profile extension sets follow the architecture reduction directive", () => {
  // minimal: governance core only (policy/approval/trace/budget live in reliability).
  const minimal = profileExtensionSelection("minimal");
  assert.ok(minimal.enabled.includes("harness-panel"));
  assert.ok(!minimal.enabled.includes("memory"));
  assert.ok(!minimal.enabled.includes("web-crawler"));
  // standard: adds local in-process engineering tools, still no python/network/subagents.
  const standard = profileExtensionSelection("standard");
  for (const id of ["protocol-tools", "ast-tools", "tool-catalog", "tool-scheduler"]) assert.ok(standard.enabled.includes(id), id);
  for (const id of ["memory", "skills", "subagent-engine", "web-crawler", "pi-web-command"]) assert.ok(!standard.enabled.includes(id), id);
  // full: empty enabled list means "every manifest contract".
  assert.deepEqual(profileExtensionSelection("full"), { enabled: [] });
  // raw: no Equaxis extensions at all.
  assert.equal(profileExtensionSelection("raw"), null);
});

test("explicit extensions.enabled/disabled override the profile", () => {
  const withMemory = profileExtensionSelection("standard", { enabled: ["memory", "skills"] });
  assert.ok(withMemory.enabled.includes("memory"));
  assert.ok(withMemory.enabled.includes("skills"));
  const withoutCatalog = profileExtensionSelection("standard", { disabled: ["tool-catalog"] });
  assert.ok(!withoutCatalog.enabled.includes("tool-catalog"));
  const explicitWins = profileExtensionSelection("full", { enabled: ["memory"], disabled: ["memory"] });
  assert.ok(!explicitWins.enabled.includes("memory"));
});

test("unknown profiles are rejected and profile constants are stable", () => {
  assert.throws(() => profileExtensionSelection("turbo"), /unknown runtime profile/);
  assert.equal(isRuntimeProfile("minimal"), true);
  assert.equal(isRuntimeProfile("full"), true);
  assert.equal(isRuntimeProfile("other"), false);
  assert.equal(RUNTIME_PROFILES.raw.extensionIds.length, 0);
  assert.equal(RUNTIME_PROFILES.full.extensionIds, null);
});

test("profile sets never include the fatal core extensions twice", () => {
  // provider/reliability are fatal and always loaded by extensionPaths;
  // profile sets must not depend on listing them.
  for (const profile of ["minimal", "standard"]) {
    const selection = profileExtensionSelection(profile);
    assert.equal(new Set(selection.enabled).size, selection.enabled.length, profile + " has no duplicate ids");
  }
});