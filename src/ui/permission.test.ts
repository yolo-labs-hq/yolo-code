// Unit tests for the permission modal's scope label helper. The Ink
// component itself isn't unit-testable without a TTY renderer; the
// pure `describeSessionScope` function captures the operator-facing
// behavior that matters (no opaque "Allow for this session" — show
// what's actually being trusted).

import { describe, it } from "node:test";
import assert from "node:assert";
import { describeSessionScope } from "./permission.js";

describe("describeSessionScope", () => {
  it("renders the bash:<verb> shape with backtick-quoted verb", () => {
    assert.strictEqual(
      describeSessionScope("bash", "bash:git"),
      "`bash` starting with `git`",
    );
    assert.strictEqual(
      describeSessionScope("bash", "bash:rm"),
      "`bash` starting with `rm`",
    );
  });

  it("falls back to a generic tool-name shape for non-bash tools", () => {
    assert.strictEqual(
      describeSessionScope("write", "write"),
      "any `write` call",
    );
    assert.strictEqual(
      describeSessionScope("edit", "edit"),
      "any `edit` call",
    );
  });

  it("handles unfamiliar keys without crashing", () => {
    // If a future executor change introduces a new key shape that we
    // haven't taught the label about, the fallback should still be
    // honest — say "any `<tool>` call" rather than expose the raw key.
    assert.strictEqual(
      describeSessionScope("future_tool", "future_tool:some-future-shape"),
      "any `future_tool` call",
    );
  });
});
