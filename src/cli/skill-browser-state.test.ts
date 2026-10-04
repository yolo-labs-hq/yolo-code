// Unit tests for the SkillBrowser data loader. The interactive TUI
// component is rendered by Ink and not unit-testable without a
// headless renderer; the data layer (loadSkillBrowserState) IS
// trivially testable via a fetcher seam.

import { describe, it } from "node:test";
import assert from "node:assert";
import { loadSkillBrowserState } from "./skills-cmd.js";

describe("loadSkillBrowserState", () => {
  it("maps registry entries to SkillBrowserEntry[] sorted by name", async () => {
    const state = await loadSkillBrowserState({
      fetcher: async () => ({
        version: 1,
        skills: {
          "zebra-skill": {
            description: "Z",
            tags: ["z1"],
            endorsed: false,
          },
          "alpha-skill": {
            description: "A",
            tags: ["a1", "a2"],
            endorsed: true,
            license: "MIT",
            latestVersion: "1.2.3",
          },
        },
      }),
    });
    assert.strictEqual(state.error, null);
    assert.strictEqual(state.total, 2);
    assert.strictEqual(state.entries[0]!.name, "alpha-skill");
    assert.strictEqual(state.entries[0]!.endorsed, true);
    assert.strictEqual(state.entries[0]!.license, "MIT");
    assert.strictEqual(state.entries[0]!.version, "1.2.3");
    assert.deepStrictEqual(state.entries[0]!.tags, ["a1", "a2"]);
    assert.strictEqual(state.entries[1]!.name, "zebra-skill");
  });

  it("returns an error value instead of throwing on fetch failure", async () => {
    const state = await loadSkillBrowserState({
      fetcher: async () => {
        throw new Error("ENOTFOUND raw.githubusercontent.com");
      },
    });
    assert.strictEqual(state.entries.length, 0);
    assert.strictEqual(state.total, 0);
    assert.ok(state.error);
    assert.match(state.error!, /ENOTFOUND/);
  });

  it("prefers latestVersion over the legacy `version` field", async () => {
    const state = await loadSkillBrowserState({
      fetcher: async () => ({
        skills: {
          a: { version: "0.9.0", latestVersion: "1.0.0" },
          b: { version: "0.5.0" }, // no latestVersion → fall back
          c: {}, // no version info at all
        },
      }),
    });
    const byName = Object.fromEntries(state.entries.map((e) => [e.name, e]));
    assert.strictEqual(byName.a!.version, "1.0.0");
    assert.strictEqual(byName.b!.version, "0.5.0");
    assert.strictEqual(byName.c!.version, undefined);
  });

  it("treats missing or malformed tags as empty array (never throws)", async () => {
    const state = await loadSkillBrowserState({
      fetcher: async () => ({
        skills: {
          a: { tags: ["good"] },
          b: { tags: [123 as unknown as string, "ok", null as unknown as string] }, // filter non-strings
          c: { /* no tags */ },
        },
      }),
    });
    const byName = Object.fromEntries(state.entries.map((e) => [e.name, e]));
    assert.deepStrictEqual(byName.a!.tags, ["good"]);
    assert.deepStrictEqual(byName.b!.tags, ["ok"]);
    assert.deepStrictEqual(byName.c!.tags, []);
  });

  it("returns an empty list when the registry has no skills field", async () => {
    const state = await loadSkillBrowserState({
      fetcher: async () => ({ version: 1 }),
    });
    assert.strictEqual(state.error, null);
    assert.strictEqual(state.total, 0);
    assert.deepStrictEqual(state.entries, []);
  });
});
