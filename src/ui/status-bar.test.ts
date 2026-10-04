// Unit tests for the status-bar helpers added 2026-05-13 (the visual
// context-usage bar + token formatter + threshold color picker).
//
// The bar / color / format helpers are pure functions — easier to
// regression-test than the full Ink component, which requires a TTY
// renderer. The visual rendering of the bar inside StatusBar is
// covered by the typecheck + the existing status.tsx structure (no
// new shape, just additional Text children).

import { describe, it } from "node:test";
import assert from "node:assert";
import { ctxBar, ctxColor, formatTokens } from "./status.js";
import type { Theme } from "./theme.js";

const FAKE_THEME = {
  warn: "#ff0000",
  permission: "#ffaa00",
  assistant: "#00aaff",
  info: { color: "#999999", dim: false },
} as unknown as Theme;

describe("ctxBar", () => {
  it("returns empty string for non-positive limit or width", () => {
    assert.strictEqual(ctxBar(50, 0, 10), "");
    assert.strictEqual(ctxBar(50, 100, 0), "");
    assert.strictEqual(ctxBar(50, -1, 10), "");
  });

  it("renders entirely filled bar at 100%", () => {
    const b = ctxBar(100, 100, 10);
    assert.strictEqual(b.length, 10);
    assert.match(b, /^▰+$/);
  });

  it("renders entirely empty bar at 0%", () => {
    const b = ctxBar(0, 100, 10);
    assert.strictEqual(b.length, 10);
    assert.match(b, /^▱+$/);
  });

  it("clamps over-limit usage to a full bar", () => {
    // Mid-stream tools sometimes report prompt_tokens > limit for one
    // frame before compaction; the bar should saturate, not overflow.
    const b = ctxBar(150, 100, 10);
    assert.strictEqual(b.length, 10);
    assert.match(b, /^▰+$/);
  });

  it("clamps negative usage to an empty bar", () => {
    const b = ctxBar(-50, 100, 10);
    assert.strictEqual(b.length, 10);
    assert.match(b, /^▱+$/);
  });

  it("rounds the fill cell count to nearest", () => {
    // 47% of 10 = 4.7 → 5 filled cells.
    const b = ctxBar(47, 100, 10);
    assert.strictEqual(b, "▰▰▰▰▰▱▱▱▱▱");
    // 53% of 10 = 5.3 → 5 filled cells.
    assert.strictEqual(ctxBar(53, 100, 10), "▰▰▰▰▰▱▱▱▱▱");
  });
});

describe("ctxColor", () => {
  it("returns undefined for non-positive limit (avoid div-by-zero)", () => {
    assert.strictEqual(ctxColor(50, 0, FAKE_THEME), undefined);
  });

  it("returns assistant color when < 50%", () => {
    assert.strictEqual(ctxColor(49, 100, FAKE_THEME), "#00aaff");
  });

  it("returns permission color in the 50–80% band", () => {
    assert.strictEqual(ctxColor(50, 100, FAKE_THEME), "#ffaa00");
    assert.strictEqual(ctxColor(79, 100, FAKE_THEME), "#ffaa00");
  });

  it("returns warn color at ≥ 80%", () => {
    assert.strictEqual(ctxColor(80, 100, FAKE_THEME), "#ff0000");
    assert.strictEqual(ctxColor(99, 100, FAKE_THEME), "#ff0000");
  });
});

describe("formatTokens", () => {
  it("passes small counts through as-is", () => {
    assert.strictEqual(formatTokens(0), "0");
    assert.strictEqual(formatTokens(42), "42");
    assert.strictEqual(formatTokens(999), "999");
  });

  it("uses k suffix with 2 decimals under 10k, 1 decimal under 100k, 0 above", () => {
    assert.strictEqual(formatTokens(1000), "1.00k");
    assert.strictEqual(formatTokens(1234), "1.23k");
    assert.strictEqual(formatTokens(9999), "10.00k"); // 9.999 rounds to 10.00
    assert.strictEqual(formatTokens(12_345), "12.3k");
    assert.strictEqual(formatTokens(123_456), "123k");
  });

  it("uses M suffix above 1M with the same decimal-tier pattern", () => {
    assert.strictEqual(formatTokens(1_000_000), "1.00M");
    assert.strictEqual(formatTokens(1_234_567), "1.23M");
    assert.strictEqual(formatTokens(12_345_678), "12.3M");
  });
});
