import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../lib/users.mjs";

test("summarizes active users", () => {
  assert.deepEqual(summarize([
    { name: "A", status: "active" },
    { name: "B", status: "inactive" }
  ]), { total: 2, active: 1, names: ["A"] });
});
