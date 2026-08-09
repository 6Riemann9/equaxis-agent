import test from "node:test";
import assert from "node:assert/strict";
import { formatEquaxisBanner, shouldShowBanner } from "../src/cli-banner.mjs";

test("formats a recognizable Equaxis CLI mark", () => {
  const banner = formatEquaxisBanner({ color: false });
  assert.match(banner, /__ _+__/);
  assert.match(banner, /reliable agent runtime/);
});

test("does not show the banner for JSON or non-interactive output", () => {
  assert.equal(shouldShowBanner({ isTTY: false, args: [] }), false);
  assert.equal(shouldShowBanner({ isTTY: true, args: ["--mode", "json"] }), false);
  assert.equal(shouldShowBanner({ isTTY: true, args: ["--mode=json"] }), false);
  assert.equal(shouldShowBanner({ isTTY: true, args: ["--no-banner"] }), false);
  assert.equal(shouldShowBanner({ isTTY: true, args: [] }), true);
});
