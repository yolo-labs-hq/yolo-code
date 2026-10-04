import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TMUX_CONFIG_BEGIN,
  TMUX_CONFIG_END,
  mergeSnippet,
  renderSnippet,
  tmuxInstall,
} from "./tmux-cmd.js";

describe("renderSnippet", () => {
  it("wraps the body in begin/end markers", () => {
    const out = renderSnippet();
    assert.ok(out.startsWith(TMUX_CONFIG_BEGIN));
    assert.ok(out.endsWith(TMUX_CONFIG_END));
    assert.match(out, /set -g mouse on/);
    assert.match(out, /WheelUpPane\s+send -N3 -X scroll-up/);
    assert.match(out, /unbind -T copy-mode\s+MouseDragEnd1Pane/);
  });
});

describe("mergeSnippet", () => {
  it("creates a fresh block when no file exists", () => {
    const { content, action } = mergeSnippet(null);
    assert.strictEqual(action, "created");
    assert.ok(content.includes(TMUX_CONFIG_BEGIN));
    assert.ok(content.endsWith("\n"));
  });

  it("creates a fresh block on empty input", () => {
    const { content, action } = mergeSnippet("");
    assert.strictEqual(action, "created");
    assert.ok(content.includes(TMUX_CONFIG_BEGIN));
  });

  it("appends to an existing config without markers", () => {
    const existing = "set -g status on\nbind r source-file ~/.tmux.conf\n";
    const { content, action } = mergeSnippet(existing);
    assert.strictEqual(action, "appended");
    assert.ok(content.startsWith("set -g status on\n"));
    assert.ok(content.includes(TMUX_CONFIG_BEGIN));
    // Preserves the user's content verbatim
    assert.ok(content.includes("bind r source-file ~/.tmux.conf"));
  });

  it("replaces an existing marked block in place", () => {
    const existing = [
      "set -g status on",
      "",
      TMUX_CONFIG_BEGIN,
      "set -g mouse off",
      "# old stale content",
      TMUX_CONFIG_END,
      "",
      "bind r source-file ~/.tmux.conf",
    ].join("\n");
    const { content, action } = mergeSnippet(existing);
    assert.strictEqual(action, "replaced");
    // User content before the block is preserved
    assert.ok(content.includes("set -g status on"));
    // User content after the block is preserved
    assert.ok(content.includes("bind r source-file ~/.tmux.conf"));
    // Old stale body was discarded
    assert.ok(!content.includes("set -g mouse off"));
    assert.ok(!content.includes("# old stale content"));
    // The new snippet body is present
    assert.match(content, /WheelUpPane\s+send -N3 -X scroll-up/);
    // Markers appear exactly once each
    assert.strictEqual(content.split(TMUX_CONFIG_BEGIN).length - 1, 1);
    assert.strictEqual(content.split(TMUX_CONFIG_END).length - 1, 1);
  });

  it("is idempotent across repeated merges", () => {
    const first = mergeSnippet("set -g status on\n").content;
    const second = mergeSnippet(first).content;
    const third = mergeSnippet(second).content;
    assert.strictEqual(second, third);
    // The user content is still there after multiple merges
    assert.ok(second.includes("set -g status on"));
    // Exactly one block
    assert.strictEqual(second.split(TMUX_CONFIG_BEGIN).length - 1, 1);
  });
});

describe("tmuxInstall (filesystem)", () => {
  let workDir: string;
  before(async () => {
    workDir = await mkdtemp(join(tmpdir(), "yolo-tmux-cmd-"));
  });
  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("creates a new file when none exists", async () => {
    const path = join(workDir, "fresh.tmux.conf");
    const code = await tmuxInstall({ path });
    assert.strictEqual(code, 0);
    const written = await readFile(path, "utf8");
    assert.ok(written.includes(TMUX_CONFIG_BEGIN));
  });

  it("preserves surrounding content on second install", async () => {
    const path = join(workDir, "existing.tmux.conf");
    await writeFile(path, "set -g status on\n", "utf8");
    const first = await tmuxInstall({ path });
    assert.strictEqual(first, 0);
    const second = await tmuxInstall({ path });
    assert.strictEqual(second, 0);
    const written = await readFile(path, "utf8");
    assert.ok(written.includes("set -g status on"));
    assert.strictEqual(written.split(TMUX_CONFIG_BEGIN).length - 1, 1);
  });

  it("preserves 0600 permission bits across reinstall (codex R4 P2)", async () => {
    const path = join(workDir, "private.tmux.conf");
    await writeFile(path, "set -g status on\n", "utf8");
    await chmod(path, 0o600);
    const before = (await stat(path)).mode & 0o777;
    assert.strictEqual(before, 0o600);
    const code = await tmuxInstall({ path });
    assert.strictEqual(code, 0);
    const after = (await stat(path)).mode & 0o777;
    assert.strictEqual(after, 0o600, "install must not widen owner-only tmux.conf");
  });

  it("preserves 0644 permission bits across reinstall", async () => {
    const path = join(workDir, "public.tmux.conf");
    await writeFile(path, "set -g status on\n", "utf8");
    await chmod(path, 0o644);
    const before = (await stat(path)).mode & 0o777;
    assert.strictEqual(before, 0o644);
    await tmuxInstall({ path });
    const after = (await stat(path)).mode & 0o777;
    assert.strictEqual(after, 0o644);
  });

  it("creates new tmux.conf as 0600 (owner-only, conservative default)", async () => {
    const path = join(workDir, "brand-new.tmux.conf");
    await tmuxInstall({ path });
    const mode = (await stat(path)).mode & 0o777;
    assert.strictEqual(mode, 0o600);
  });
});
