import test from "node:test";
import assert from "node:assert/strict";
import { makeUiKit, ansiKit, STATUS_SYMBOLS, SEMANTIC_COLORS } from "../src/ui-kit.mjs";

test("exposes the unified status symbol set", () => {
  assert.deepEqual(STATUS_SYMBOLS, { ok: "✓", warn: "!", error: "✗", info: "›" });
});

test("exposes the semantic color names shared by both backends", () => {
  assert.ok(SEMANTIC_COLORS.includes("accent"));
  assert.ok(SEMANTIC_COLORS.includes("success"));
  assert.ok(SEMANTIC_COLORS.includes("warning"));
  assert.ok(SEMANTIC_COLORS.includes("error"));
  assert.ok(SEMANTIC_COLORS.includes("borderMuted"));
});

test("plain mode emits no ANSI escape codes", () => {
  const kit = makeUiKit({ color: false });
  const output = [
    kit.paint("accent", "Equaxis runtime dashboard"),
    kit.section("Reliability"),
    kit.badge("READY", "ok"),
    kit.status("warn", "warning here"),
    kit.kv("mode", "enforce"),
    kit.rule("─", 20),
  ].join("\n");
  assert.ok(!output.includes("\u001b["));
  assert.match(output, /Equaxis runtime dashboard/);
  assert.match(output, /── Reliability/);
  assert.match(output, /\[ READY \]/);
  assert.match(output, /mode\s+enforce/);
});

test("colored mode emits ANSI 256-color codes", () => {
  const kit = makeUiKit({ color: true });
  assert.match(kit.paint("accent", "x"), /\u001b\[38;5;\d+m/);
  assert.match(kit.bold("x"), /\u001b\[1m/);
  assert.match(kit.badge("READY", "ok"), /\u001b\[38;5;/);
});

test("theme mode delegates to the pi theme", () => {
  const calls = [];
  const theme = {
    fg: (name, text) => {
      calls.push(name);
      return `<${name}>${text}</${name}>`;
    },
    bold: (text) => `*${text}*`,
  };
  const kit = makeUiKit({ theme });
  assert.equal(kit.paint("accent", "hi"), "<accent>hi</accent>");
  assert.equal(kit.bold("hi"), "*hi*");
  assert.equal(kit.badge("READY", "ok"), "<success>[ READY ]</success>");
  assert.equal(kit.status("error", "boom"), "<error>✗</error> boom");
  assert.deepEqual(calls, ["accent", "success", "error"]);
});

test("symbol() resolves levels and falls back to info", () => {
  const kit = makeUiKit({ color: false });
  assert.equal(kit.symbol("ok"), "✓");
  assert.equal(kit.symbol("warn"), "!");
  assert.equal(kit.symbol("error"), "✗");
  assert.equal(kit.symbol("info"), "›");
  assert.equal(kit.symbol("unknown-level"), "›");
});

test("onOff and healthBadge produce consistent badges", () => {
  const kit = makeUiKit({ color: false });
  assert.equal(kit.onOff(true), "[ ON ]");
  assert.equal(kit.onOff(false), "[ OFF ]");
  assert.equal(kit.healthBadge(true), "[ READY ]");
  assert.equal(kit.healthBadge(false), "[ FAIL ]");
});

test("ansiKit is a convenience factory", () => {
  assert.equal(ansiKit(false).colored, false);
  assert.equal(ansiKit(true).colored, true);
});
