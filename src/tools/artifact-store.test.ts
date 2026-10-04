// Unit tests for the ToolArtifactStore helpers added 2026-05-13 to
// back the `/expand` slash command's default and list sub-forms.

import { describe, it } from "node:test";
import assert from "node:assert";
import { ToolArtifactStore } from "./artifact-store.js";

describe("ToolArtifactStore.latestId", () => {
  it("returns undefined when the store is empty", () => {
    const s = new ToolArtifactStore();
    assert.strictEqual(s.latestId(), undefined);
  });

  it("returns the only id when one artifact is stored", () => {
    const s = new ToolArtifactStore();
    const id = s.store("hello");
    assert.strictEqual(s.latestId(), id);
  });

  it("returns the most recently stored id (insertion order)", () => {
    const s = new ToolArtifactStore();
    s.store("first");
    s.store("second");
    const third = s.store("third");
    assert.strictEqual(s.latestId(), third);
  });

  it("survives eviction — returns the newest surviving id", () => {
    // Tiny char-cap forces evictions; latestId must still point at
    // the most recent entry that hasn't been evicted.
    const s = new ToolArtifactStore({ maxTotalChars: 12 });
    s.store("aaaa"); // art_1 (4 chars, total 4)
    s.store("bbbb"); // art_2 (4 chars, total 8)
    s.store("cccc"); // art_3 (4 chars, total 12)
    s.store("dddd"); // forces eviction of art_1 → store now has art_2, art_3, art_4
    assert.strictEqual(s.latestId(), "art_4");
    assert.strictEqual(s.has("art_1"), false);
  });
});

describe("ToolArtifactStore.listIds", () => {
  it("returns [] for an empty store", () => {
    assert.deepStrictEqual(new ToolArtifactStore().listIds(), []);
  });

  it("returns ids in insertion order (oldest → newest)", () => {
    const s = new ToolArtifactStore();
    const a = s.store("one");
    const b = s.store("two");
    const c = s.store("three");
    assert.deepStrictEqual(s.listIds(), [a, b, c]);
  });

  it("reflects eviction — evicted ids drop off the front", () => {
    const s = new ToolArtifactStore({ maxTotalChars: 12 });
    s.store("aaaa");
    s.store("bbbb");
    s.store("cccc");
    s.store("dddd");
    assert.deepStrictEqual(s.listIds(), ["art_2", "art_3", "art_4"]);
  });
});
