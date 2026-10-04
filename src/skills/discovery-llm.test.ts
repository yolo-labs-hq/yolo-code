import { describe, it } from "node:test";
import assert from "node:assert";
import { parseActiveJson } from "./discovery-llm.js";

describe("parseActiveJson", () => {
  it("parses a clean JSON object", () => {
    const out = parseActiveJson(`{"active": ["foo", "bar"]}`, ["foo", "bar", "baz"]);
    assert.deepStrictEqual(out, ["foo", "bar"]);
  });

  it("strips ```json fences", () => {
    const raw = '```json\n{"active":["foo"]}\n```';
    assert.deepStrictEqual(parseActiveJson(raw, ["foo"]), ["foo"]);
  });

  it("strips bare ``` fences", () => {
    const raw = '```\n{"active":["foo"]}\n```';
    assert.deepStrictEqual(parseActiveJson(raw, ["foo"]), ["foo"]);
  });

  it("ignores names not in the valid set (no hallucinations)", () => {
    const out = parseActiveJson(`{"active":["foo","ghost"]}`, ["foo"]);
    assert.deepStrictEqual(out, ["foo"]);
  });

  it("returns [] on empty / null input", () => {
    assert.deepStrictEqual(parseActiveJson("", ["foo"]), []);
    assert.deepStrictEqual(parseActiveJson("null", ["foo"]), []);
  });

  it("returns [] on unparseable JSON", () => {
    assert.deepStrictEqual(parseActiveJson("{not json", ["foo"]), []);
  });

  it("tolerates leading prose followed by an object", () => {
    const raw = "Sure! Here's my answer:\n{\"active\":[\"foo\"]}\nLet me know if that helps.";
    assert.deepStrictEqual(parseActiveJson(raw, ["foo"]), ["foo"]);
  });

  it("returns [] when `active` is not an array", () => {
    assert.deepStrictEqual(parseActiveJson(`{"active": "foo"}`, ["foo"]), []);
  });
});
