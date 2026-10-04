import { readFile, writeFile, mkdir, chmod, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Marker tags wrap the YOLO-managed block inside ~/.tmux.conf so re-running
// `yolo-code tmux install` replaces in place instead of duplicating. Keep
// the literal strings stable — old installs use them to find the block.
export const TMUX_CONFIG_BEGIN = "# >>> yolo-code tmux config >>>";
export const TMUX_CONFIG_END = "# <<< yolo-code tmux config <<<";

// The snippet itself. Targets the touchpad-sensitivity complaint: stock
// tmux scrolls 5 lines per wheel event, which combined with trackpad
// inertial bursts (30–50 events per gesture) feels like a slingshot.
// Three lines per wheel tick is roughly mouse-wheel-feel on a trackpad.
//
// Scope: changes apply inside tmux copy-mode only. Pane-entry wheel-up
// (the moment of dropping into copy-mode) is governed by tmux's default
// root-table binding and stays untouched — we just slow the post-entry
// scroll. The `unbind … MouseDragEnd1Pane` lines keep copy-mode open
// after a drag-select so you can scroll, select, scroll again, and
// finish copying without tmux yanking you back to the prompt.
export const TMUX_CONFIG_BODY = [
  "# Curated tmux settings for running yolo-code / codex / claude under tmux on a host terminal.",
  "# Targets trackpad wheel sensitivity in copy-mode — stock tmux scrolls 5 lines per wheel",
  "# event, which combined with trackpad inertial bursts feels like a slingshot.",
  "# Re-run `yolo-code tmux install` to refresh this block.",
  "",
  "# Keep mouse on so wheel events reach tmux; without this, alt-screen TUIs",
  "# block the host terminal's native scrollback entirely.",
  "set -g mouse on",
  "",
  "# Big scrollback — codex/claude inside alt-screen plus shell history accumulates fast.",
  "set -g history-limit 50000",
  "",
  "# 3 lines per wheel tick in copy-mode instead of tmux's default 5. Both keymap",
  "# variants (default emacs-style and copy-mode-vi) need the binding.",
  "bind -T copy-mode    WheelUpPane   send -N3 -X scroll-up",
  "bind -T copy-mode    WheelDownPane send -N3 -X scroll-down",
  "bind -T copy-mode-vi WheelUpPane   send -N3 -X scroll-up",
  "bind -T copy-mode-vi WheelDownPane send -N3 -X scroll-down",
  "",
  "# Stay in copy-mode after a drag-select so you can scroll → select → scroll → copy",
  "# without tmux yanking you back to the live pane between gestures.",
  "unbind -T copy-mode    MouseDragEnd1Pane",
  "unbind -T copy-mode-vi MouseDragEnd1Pane",
].join("\n");

export function renderSnippet(): string {
  return [TMUX_CONFIG_BEGIN, TMUX_CONFIG_BODY, TMUX_CONFIG_END].join("\n");
}

export function defaultConfigPath(): string {
  return join(homedir(), ".tmux.conf");
}

export interface InstallResult {
  path: string;
  action: "created" | "replaced" | "appended";
}

// Replaces (or appends) the YOLO-managed block in `existing` with the
// current snippet. Pure function so tests don't need a tempdir.
export function mergeSnippet(existing: string | null): { content: string; action: "created" | "replaced" | "appended" } {
  const snippet = renderSnippet();
  if (existing === null || existing.length === 0) {
    return { content: snippet + "\n", action: "created" };
  }
  const beginIdx = existing.indexOf(TMUX_CONFIG_BEGIN);
  const endIdx = existing.indexOf(TMUX_CONFIG_END);
  if (beginIdx >= 0 && endIdx > beginIdx) {
    // Replace inclusive of both markers.
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + TMUX_CONFIG_END.length);
    const trimmedBefore = before.replace(/\s+$/, "");
    const trimmedAfter = after.replace(/^\s+/, "");
    const parts: string[] = [];
    if (trimmedBefore) parts.push(trimmedBefore);
    parts.push(snippet);
    if (trimmedAfter) parts.push(trimmedAfter);
    return { content: parts.join("\n\n") + "\n", action: "replaced" };
  }
  // No markers — append, separated by a blank line. Preserve trailing
  // newline behavior of the original file.
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return { content: existing + separator + snippet + "\n", action: "appended" };
}

export async function tmuxPrint(): Promise<number> {
  process.stdout.write(renderSnippet() + "\n");
  return 0;
}

export async function tmuxInstall(opts: { path?: string } = {}): Promise<number> {
  const targetPath = opts.path ?? defaultConfigPath();
  let existing: string | null = null;
  // Preserve the existing file's mode so re-running install never widens
  // permissions on a user who deliberately set ~/.tmux.conf to 0600
  // (which is common when the config holds host-specific paths, socket
  // names, or credentials passed via tmux env). For brand-new files,
  // default to 0o600 — tmux.conf is owner-only territory by convention.
  let preservedMode: number | undefined;
  if (existsSync(targetPath)) {
    try {
      existing = await readFile(targetPath, "utf8");
      const st = await stat(targetPath);
      preservedMode = st.mode & 0o777;
    } catch (e) {
      process.stderr.write(`yolo-code tmux: failed to read ${targetPath}: ${(e as Error).message}\n`);
      return 1;
    }
  }
  const { content, action } = mergeSnippet(existing);
  const targetMode = preservedMode ?? 0o600;
  try {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, { encoding: "utf8", mode: targetMode });
    // writeFile's `mode` option only applies on file CREATE — for an
    // existing file Node leaves the permission bits alone. Explicitly
    // chmod so a future Node behavior change can't silently regress us.
    // Also covers the new-file path when umask trims the requested mode.
    await chmod(targetPath, targetMode);
  } catch (e) {
    process.stderr.write(`yolo-code tmux: failed to write ${targetPath}: ${(e as Error).message}\n`);
    return 1;
  }
  process.stdout.write(`${action} YOLO tmux block in ${targetPath}\n`);
  process.stdout.write(`reload an attached tmux session with:  tmux source-file ${targetPath}\n`);
  return 0;
}
