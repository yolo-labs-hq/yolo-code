import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPinFilter, pinClear, pinDisable, pinEnable, pinsFilePath, readPins } from "./pins.js";
import type { SkillRecord } from "./types.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yolo-pins-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const rec = (name: string): SkillRecord => ({
  name,
  description: `${name} desc`,
  body: "body",
  path: `/tmp/${name}/SKILL.md`,
  scope: "user",
});

describe("skill pins", () => {
  it("starts with empty enabled/disabled lists", () => {
    const pins = readPins(home);
    assert.deepStrictEqual(pins, { enabled: [], disabled: [] });
  });

  it("pinDisable adds the name to `disabled` and writes the file", () => {
    pinDisable("foo", home);
    const pins = readPins(home);
    assert.deepStrictEqual(pins.disabled, ["foo"]);
    assert.deepStrictEqual(pins.enabled, []);
    assert.ok(existsSync(pinsFilePath(home)));
  });

  it("pinEnable moves a name from disabled → enabled", () => {
    pinDisable("foo", home);
    pinEnable("foo", home);
    const pins = readPins(home);
    assert.deepStrictEqual(pins.enabled, ["foo"]);
    assert.deepStrictEqual(pins.disabled, []);
  });

  it("pinClear drops the name from both lists", () => {
    pinDisable("foo", home);
    pinEnable("bar", home);
    pinClear("foo", home);
    pinClear("bar", home);
    assert.deepStrictEqual(readPins(home), { enabled: [], disabled: [] });
  });

  it("dedupes when pinning the same name twice", () => {
    pinDisable("foo", home);
    pinDisable("foo", home);
    assert.deepStrictEqual(readPins(home).disabled, ["foo"]);
  });

  it("writes the pins file with chmod 600 on POSIX", () => {
    pinEnable("foo", home);
    if (process.platform !== "win32") {
      const mode = statSync(pinsFilePath(home)).mode & 0o777;
      assert.strictEqual(mode, 0o600);
    }
  });

  it("applyPinFilter drops disabled records, keeps the rest", () => {
    pinDisable("disabled-skill", home);
    pinEnable("enabled-skill", home);
    const records = [rec("enabled-skill"), rec("disabled-skill"), rec("untouched")];
    const filtered = applyPinFilter(records, home);
    assert.deepStrictEqual(
      filtered.map((r) => r.name).sort(),
      ["enabled-skill", "untouched"],
    );
  });

  it("applyPinFilter is a no-op when nothing is disabled", () => {
    pinEnable("foo", home);
    const records = [rec("foo"), rec("bar")];
    const filtered = applyPinFilter(records, home);
    assert.strictEqual(filtered.length, 2);
  });

  it("ignores malformed JSON gracefully", () => {
    // pinEnable creates the file; corrupt it and re-read.
    pinEnable("foo", home);
    writeFileSync(pinsFilePath(home), "{ this is not json }");
    assert.deepStrictEqual(readPins(home), { enabled: [], disabled: [] });
  });
});
