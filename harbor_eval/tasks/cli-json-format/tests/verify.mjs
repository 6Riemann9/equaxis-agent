import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const run = (...args) => spawnSync("node", ["/app/cli.mjs", "/app/users.csv", ...args], { encoding: "utf8" });

const defaultResult = run();
assert.equal(defaultResult.status, 0);
assert.equal(defaultResult.stdout, "Users: 3\nActive: 2\nNames: Ada, Lin\n");

const explicitText = run("--format", "text");
assert.equal(explicitText.status, 0);
assert.equal(explicitText.stdout, defaultResult.stdout);

const jsonResult = run("--format", "json");
assert.equal(jsonResult.status, 0);
assert.deepEqual(JSON.parse(jsonResult.stdout), {
  total: 3,
  active: 2,
  names: ["Ada", "Lin"]
});

const invalid = run("--format", "yaml");
assert.equal(invalid.status, 2);
assert.equal(invalid.stderr.trim(), "Unsupported format: yaml");
