import { describe, it } from "node:test";
import assert from "node:assert";
import {
  hashString,
  preview,
  redact,
  redactedPayload,
  redactedStructuredPayload,
  redactStructured,
  RepeatedCallTracker,
  safePreview,
  tryParseJsonRedacted,
} from "./trace-log.js";

describe("redact", () => {
  it("redacts Bearer tokens but keeps the prefix", () => {
    const out = redact("Authorization: Bearer abcdefghijklmnopqrstuv");
    assert.match(out, /Bearer \[redacted:Bearer len=22 ab…uv\]/);
    assert.ok(!out.includes("abcdefghijklmnopqrstuv"));
  });

  it("redacts sk-* API keys", () => {
    const out = redact("API key: sk-proj-abcdefghijklmnopqrstuv");
    assert.match(out, /\[redacted:ApiKey/);
    assert.ok(!out.includes("sk-proj-abcdefghijklmnopqrstuv"));
  });

  it("redacts JWTs", () => {
    const jwt = "eyJabcdefghij.eyJklmnopqrst.zyxwvutsrqponm";
    const out = redact(`token=${jwt} more text`);
    assert.match(out, /\[redacted:JWT/);
    assert.ok(!out.includes(jwt));
  });

  it("redacts URL query params with credentials", () => {
    const out = redact("https://api.example/v1?token=ABC123&other=keep");
    assert.match(out, /\?token=\[redacted:QueryParam/);
    assert.match(out, /other=keep/);
  });

  it("leaves plain text unchanged", () => {
    assert.strictEqual(redact("hello world"), "hello world");
  });

  it("redacts JSON-key-in-text patterns even when value is short (codex R10 P2)", () => {
    // Catches `"password": "abc"` shapes in error messages or malformed
    // JSON that wouldn't parse cleanly enough for the structured walker
    // to handle. Pairs with redactedPayload's fall-through to safePreview
    // when input isn't valid JSON.
    const malformed = 'Error: invalid JSON: {"password": "abc", "tool": "edit",}';
    const out = redact(malformed);
    assert.ok(!out.includes('"abc"'));
    assert.match(out, /\[redacted:JsonKeyText/);
    // Non-credential keys are preserved.
    assert.match(out, /"tool": "edit"/);
  });

  it("redacts `authorization`/`token`/`cookie` in raw text", () => {
    const cases = [
      '{"authorization": "short", "x": 1}',
      '{"token": "abc",}',
      '{"cookie": "session=xyz",}',
    ];
    for (const c of cases) {
      const out = redact(c);
      assert.ok(!out.includes('"short"') && !out.includes('"abc"') && !out.includes('"session=xyz"'),
        `expected secrets stripped from: ${c}\nstill in: ${out}`);
    }
  });
});

describe("preview", () => {
  it("returns full value when under limit", () => {
    const r = preview("short");
    assert.strictEqual(r.preview, "short");
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.fullLength, 5);
  });

  it("truncates oversized values and reports fullLength", () => {
    const big = "x".repeat(5000);
    const r = preview(big, { maxBytes: 100 });
    assert.strictEqual(r.truncated, true);
    assert.ok(r.preview.length <= 100 + 50);
    assert.strictEqual(r.fullLength, 5000);
    assert.match(r.preview, /\[\+4900 bytes\]/);
  });

  it("redacts before measuring", () => {
    const r = preview("Bearer 1234567890abcdef1234");
    assert.ok(!r.preview.includes("1234567890abcdef1234"));
  });
});

describe("safePreview", () => {
  it("returns full when below limit", () => {
    const r = safePreview("hello");
    assert.strictEqual(r.full, "hello");
    assert.strictEqual(r.fullLength, 5);
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.preview, undefined);
  });

  it("returns preview when above limit", () => {
    const big = "x".repeat(60_000);
    const r = safePreview(big);
    assert.strictEqual(r.full, undefined);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.fullLength, 60_000);
    assert.ok(r.preview !== undefined && r.preview.length < big.length);
  });
});

describe("tryParseJsonRedacted", () => {
  it("returns the parsed object for valid JSON", () => {
    const r = tryParseJsonRedacted('{"foo": 1, "bar": "hi"}') as Record<string, unknown>;
    assert.deepStrictEqual(r, { foo: 1, bar: "hi" });
  });

  it("redacts known credential keys", () => {
    const r = tryParseJsonRedacted('{"authorization": "Bearer xyz", "name": "tool"}') as Record<string, unknown>;
    assert.match(r.authorization as string, /\[redacted:JsonKey/);
    assert.strictEqual(r.name, "tool");
  });

  it("returns undefined for non-JSON", () => {
    assert.strictEqual(tryParseJsonRedacted("hello"), undefined);
    assert.strictEqual(tryParseJsonRedacted(""), undefined);
    assert.strictEqual(tryParseJsonRedacted(null), undefined);
  });

  it("redacts secret-looking strings inside nested values", () => {
    const r = tryParseJsonRedacted('{"args": {"prompt": "Bearer abcdefghijklmnopqrst"}}') as Record<string, unknown>;
    const args = r.args as Record<string, unknown>;
    assert.match(args.prompt as string, /\[redacted:Bearer/);
  });
});

describe("redactedPayload", () => {
  it("returns JSON-key-redacted parsed shape and withholds raw text for valid JSON", () => {
    const r = redactedPayload('{"password": "hunter2", "tool": "edit"}');
    assert.strictEqual(typeof r.parsed, "object");
    const parsed = r.parsed as Record<string, unknown>;
    assert.match(parsed.password as string, /\[redacted:JsonKey/);
    assert.strictEqual(parsed.tool, "edit");
    // CRITICAL: raw text preview is suppressed so the short "hunter2"
    // doesn't leak via safePreview's regex-only path.
    assert.strictEqual(r.full, undefined);
    assert.strictEqual(r.preview, undefined);
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.fullLength, '{"password": "hunter2", "tool": "edit"}'.length);
  });

  it("does not leak short bearer-style values under JSON keys", () => {
    // This is the codex P1 finding: previously safePreview would have
    // written `{"authorization":"abc"}` verbatim because the Bearer regex
    // requires 16+ chars. Now the JSON-key walk catches it.
    const r = redactedPayload('{"authorization": "abc", "x": 1}');
    assert.strictEqual(r.full, undefined);
    assert.strictEqual(r.preview, undefined);
    const parsed = r.parsed as Record<string, unknown>;
    assert.match(parsed.authorization as string, /\[redacted:JsonKey/);
  });

  it("falls back to safePreview for non-JSON input", () => {
    const r = redactedPayload("plain text error message");
    assert.strictEqual(r.parsed, undefined);
    assert.strictEqual(r.full, "plain text error message");
    assert.strictEqual(r.fullLength, 24);
  });

  it("falls back to safePreview for malformed JSON", () => {
    const r = redactedPayload('{"foo": malformed}');
    assert.strictEqual(r.parsed, undefined);
    assert.ok(r.full !== undefined || r.preview !== undefined);
  });

  it("handles empty and nullish input", () => {
    const a = redactedPayload("");
    assert.strictEqual(a.parsed, undefined);
    assert.strictEqual(a.full, "");
    const b = redactedPayload(null);
    assert.strictEqual(b.parsed, undefined);
    assert.strictEqual(b.full, "");
  });

  it("enforces the size cap on JSON payloads instead of inlining the whole object", () => {
    // Build a JSON payload that serializes larger than the cap. Use the
    // explicit maxBytes opt so the test isn't coupled to the env default.
    const items = Array.from({ length: 200 }, (_, i) => ({ idx: i, blob: "x".repeat(50) }));
    const raw = JSON.stringify({ items });
    const r = redactedPayload(raw, { maxBytes: 1_000 });
    assert.strictEqual(r.parsed, undefined, "should drop the inlined parsed object when oversized");
    assert.ok(r.parsedJsonPreview !== undefined, "should emit a truncated serialized preview");
    assert.ok(r.parsedJsonPreview!.length <= 1_000 + 50);
    assert.match(r.parsedJsonPreview!, /\[\+\d+ bytes\]$/);
    assert.deepStrictEqual(r.parsedTopLevelKeys, ["items"]);
    assert.strictEqual(r.truncated, true);
  });

  it("size-capped JSON path preserves redaction (no credential leak)", () => {
    // Big JSON containing a credential-named key. The truncated preview
    // is taken from the *already-redacted* serialization, so the secret
    // must not appear in the trace event.
    const raw = JSON.stringify({
      password: "topsecret",
      data: "x".repeat(5_000),
    });
    const r = redactedPayload(raw, { maxBytes: 500 });
    assert.ok(r.parsedJsonPreview !== undefined);
    assert.ok(!r.parsedJsonPreview!.includes("topsecret"));
    assert.match(r.parsedJsonPreview!, /\[redacted:JsonKey/);
  });
});

describe("redactStructured", () => {
  it("scrubs credential-named keys in an already-parsed object", () => {
    const out = redactStructured({ access_token: "abc", planId: "p1" }) as Record<string, unknown>;
    assert.match(out.access_token as string, /\[redacted:JsonKey/);
    assert.strictEqual(out.planId, "p1");
  });

  it("walks nested objects", () => {
    const out = redactStructured({ a: { b: { password: "x", value: 42 } } }) as Record<string, unknown>;
    const a = out.a as Record<string, unknown>;
    const b = a.b as Record<string, unknown>;
    assert.match(b.password as string, /\[redacted:JsonKey/);
    assert.strictEqual(b.value, 42);
  });
});

describe("redactedStructuredPayload", () => {
  it("inlines small structured payloads", () => {
    const r = redactedStructuredPayload({ planId: "p1", state: "draft" });
    assert.deepStrictEqual(r.structured, { planId: "p1", state: "draft" });
    assert.strictEqual(r.structuredTruncated, false);
  });

  it("redacts credential-named keys", () => {
    const r = redactedStructuredPayload({ password: "hunter2", planId: "p1" });
    const s = r.structured as Record<string, unknown>;
    assert.match(s.password as string, /\[redacted:JsonKey/);
    assert.strictEqual(s.planId, "p1");
  });

  it("size-caps large structured payloads instead of inlining the whole object (codex R11 P3)", () => {
    // Simulate a plan-list response with hundreds of items.
    const items = Array.from({ length: 300 }, (_, i) => ({ id: `plan-${i}`, state: "active" }));
    const r = redactedStructuredPayload({ plans: items }, { maxBytes: 1_000 });
    assert.strictEqual(r.structured, undefined, "must NOT inline the full object when oversized");
    assert.ok(r.structuredJsonPreview !== undefined);
    assert.ok(r.structuredJsonPreview!.length <= 1_000 + 50);
    assert.deepStrictEqual(r.structuredTopLevelKeys, ["plans"]);
    assert.strictEqual(r.structuredTruncated, true);
  });

  it("returns nothing when value is undefined", () => {
    const r = redactedStructuredPayload(undefined);
    assert.strictEqual(r.structured, undefined);
    assert.strictEqual(r.structuredJsonPreview, undefined);
    assert.strictEqual(r.structuredTruncated, false);
  });
});

describe("hashString", () => {
  it("is deterministic", () => {
    assert.strictEqual(hashString("hello"), hashString("hello"));
  });

  it("differs across distinct inputs", () => {
    assert.notStrictEqual(hashString("a"), hashString("b"));
  });
});

describe("RepeatedCallTracker", () => {
  it("reports 0 until streak threshold reached", () => {
    const t = new RepeatedCallTracker(8, 3);
    assert.strictEqual(t.record("x", "args"), 0);
    assert.strictEqual(t.record("x", "args"), 0);
    assert.strictEqual(t.record("x", "args"), 3);
  });

  it("resets streak when args change", () => {
    const t = new RepeatedCallTracker(8, 3);
    t.record("x", "a");
    t.record("x", "a");
    assert.strictEqual(t.record("x", "b"), 0);
  });

  it("reset() clears state", () => {
    const t = new RepeatedCallTracker(8, 3);
    t.record("x", "a");
    t.record("x", "a");
    t.reset();
    assert.strictEqual(t.record("x", "a"), 0);
  });
});
