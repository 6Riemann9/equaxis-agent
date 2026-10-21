import test from "node:test";
import assert from "node:assert/strict";
import { satisfiesVersion, isValidVersionRange } from "../src/extension-compat.mjs";
import { beforeAgentStartText, isBeforeAgentStartUserRun } from "../src/pi-event-utils.mjs";

test("satisfiesVersion keeps simple conjunction behavior", () => {
  assert.equal(satisfiesVersion("0.83.0", ">=0.83.0 <0.84.0"), true);
  assert.equal(satisfiesVersion("0.84.0", ">=0.83.0 <0.84.0"), false);
  assert.equal(satisfiesVersion("1.3.0", "^1.3.0"), true);
  assert.equal(satisfiesVersion("2.0.0", "^1.3.0"), false);
  assert.equal(satisfiesVersion("9.9.9", "*"), true);
  assert.equal(satisfiesVersion("not-a-version", "*"), false);
});

test("satisfiesVersion supports || unions across breaking lines", () => {
  const dual = ">=0.83.0 <0.84.0 || >=1.3.0 <2.0.0";
  assert.equal(satisfiesVersion("0.83.0", dual), true);
  assert.equal(satisfiesVersion("0.84.0", dual), false);
  assert.equal(satisfiesVersion("1.3.0", dual), true);
  assert.equal(satisfiesVersion("1.99.0", dual), true);
  assert.equal(satisfiesVersion("2.0.0", dual), false);
});

test("isValidVersionRange validates each alternative", () => {
  assert.equal(isValidVersionRange("*"), true);
  assert.equal(isValidVersionRange(">=0.83.0 <0.84.0 || >=1.3.0 <2.0.0"), true);
  assert.equal(isValidVersionRange(">=0.83.0 || bogus"), false);
  assert.equal(isValidVersionRange("||"), false);
});

test("beforeAgentStartText handles pi 0.83 events (no messageType)", () => {
  const legacy = { type: "before_agent_start", prompt: "hello 0.83", systemPrompt: "sys" };
  assert.equal(beforeAgentStartText(legacy), "hello 0.83");
  assert.equal(isBeforeAgentStartUserRun(legacy), true);
});

test("beforeAgentStartText handles pi 1.2+ user and custom events", () => {
  const user = { type: "before_agent_start", messageType: "user", prompt: "hello user" };
  assert.equal(beforeAgentStartText(user), "hello user");
  assert.equal(isBeforeAgentStartUserRun(user), true);

  const customString = { type: "before_agent_start", messageType: "custom", message: { content: "injected" } };
  assert.equal(beforeAgentStartText(customString), "injected");
  assert.equal(isBeforeAgentStartUserRun(customString), false);

  const customBlocks = {
    type: "before_agent_start",
    messageType: "custom",
    message: { content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }
  };
  assert.equal(beforeAgentStartText(customBlocks), "a\nb");
  assert.equal(isBeforeAgentStartUserRun(customBlocks), false);
});
