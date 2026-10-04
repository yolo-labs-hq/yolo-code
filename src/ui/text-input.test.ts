import { describe, it } from "node:test";
import assert from "node:assert";
import {
  isOnlyPastePlaceholders,
  resolvePastePlaceholders,
  shouldTreatAsPaste,
} from "./text-input.js";

describe("text-input paste helpers", () => {
  it("expands placeholder tokens back into full pasted content", () => {
    const pastes = new Map<string, string>([
      ["[pasted 1 line #abc]", "first line"],
      ["[pasted 2 lines #def]", "second\nthird"],
    ]);

    const result = resolvePastePlaceholders(
      "[pasted 1 line #abc][pasted 2 lines #def]",
      pastes,
    );

    assert.deepStrictEqual(result, {
      full: "first linesecond\nthird",
      hasPastes: true,
    });
  });

  it("shouldTreatAsPaste sees a single-line newline-terminated submit as non-paste (codex R4 P2)", () => {
    // A shortcut/auto-submit chunk like "Commit all changes\n" lands as
    // one useInput call. Pre-strip it has a trailing \n so the paste
    // heuristic (which counts \n characters) would classify it as a
    // multi-line paste and replace the visible text with a placeholder.
    // After stripping the terminator, the text is a single line and
    // should submit as a normal prompt. Callers must run the heuristic
    // on the *post-strip* value for that to hold.
    const raw = "Commit all changes and push\n";
    const stripped = raw.replace(/[\r\n]+$/, "");
    assert.strictEqual(shouldTreatAsPaste(stripped), false);
    // The pre-strip value DOES trigger paste because of the trailing
    // \n — which is exactly why we need to classify after stripping.
    assert.strictEqual(shouldTreatAsPaste(raw), true);
  });

  it("detects drafts composed only of paste placeholders", () => {
    const pastes = new Map<string, string>([
      ["[pasted 1 line #abc]", "first line"],
      ["[pasted 1 line #def]", "second line"],
    ]);

    assert.strictEqual(
      isOnlyPastePlaceholders("[pasted 1 line #abc][pasted 1 line #def]", pastes),
      true,
    );
    assert.strictEqual(
      isOnlyPastePlaceholders("[pasted 1 line #abc] trailing", pastes),
      false,
    );
  });
});
