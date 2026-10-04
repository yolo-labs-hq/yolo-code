import { spawnSync } from "node:child_process";

// Pure data structures for the probe. The "build" stage takes a context
// (env + platform + tmux runner) and returns a report; the "format" stage
// turns it into human-readable output. This split lets the tests pin
// classification logic without process / tmux side effects.

export interface ProbeEnv {
  env: NodeJS.ProcessEnv;
  platform: string;
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
  tmux: TmuxRunner;
}

export interface TmuxRunner {
  show(option: string): string | null;
  display(format: string): string | null;
  listKeys(table: string, key: string): string | null;
}

export interface ProbeReport {
  terminal: { type: string; program?: string; programVersion?: string };
  host: string;
  tty: { stdout: boolean; stdin: boolean };
  tmux: {
    inside: boolean;
    session?: string;
    pane?: string;
    mouse?: string;
    historyLimit?: string;
    copyMode?: boolean;
    wheelBindingUp?: string;
    yoloBlockDetected?: boolean;
  };
  webappTile: { inside: boolean; sessionId?: string };
  recommendations: string[];
}

export function classifyWebappTile(env: NodeJS.ProcessEnv): { inside: boolean; sessionId?: string } {
  // The webapp tile sets SESSION_ID (the container's bound session) AND
  // a common-api URL. Container entrypoints export this as
  // YOLO_API_URL; the substrate CLI auth contract calls it
  // YOLO_COMMON_API_URL. Treat either as evidence of being inside the
  // tile env — requiring only the substrate name made probe-scroll
  // false-negative for the common container case where YOLO_API_URL is
  // the only one set.
  const apiUrl = env.YOLO_COMMON_API_URL || env.YOLO_API_URL;
  const inside = Boolean(env.SESSION_ID && apiUrl);
  return inside ? { inside: true, sessionId: env.SESSION_ID } : { inside: false };
}

export function buildReport(ctx: ProbeEnv): ProbeReport {
  const env = ctx.env;
  const terminal = {
    type: env.TERM ?? "(unset)",
    program: env.TERM_PROGRAM,
    programVersion: env.TERM_PROGRAM_VERSION,
  };
  const tmuxInside = Boolean(env.TMUX);
  const tmux: ProbeReport["tmux"] = { inside: tmuxInside };
  if (tmuxInside) {
    tmux.session = ctx.tmux.display("#{session_name}") ?? undefined;
    tmux.pane = ctx.tmux.display("#{pane_index}") ?? undefined;
    tmux.mouse = ctx.tmux.show("mouse") ?? undefined;
    tmux.historyLimit = ctx.tmux.show("history-limit") ?? undefined;
    const inMode = ctx.tmux.display("#{pane_in_mode}");
    tmux.copyMode = inMode === "1" ? true : inMode === "0" ? false : undefined;
    // Prefer the ACTIVE keymap's table. `mode-keys vi` means tmux uses
    // copy-mode-vi for keystroke dispatch and copy-mode bindings are
    // inert; the inverse for `mode-keys emacs` (the default). Reading
    // the wrong table missed installed YOLO blocks for vi-keyed users
    // and falsely recommended `yolo-code tmux install`.
    const modeKeys = ctx.tmux.show("mode-keys");
    const primaryTable = modeKeys === "vi" ? "copy-mode-vi" : "copy-mode";
    const fallbackTable = modeKeys === "vi" ? "copy-mode" : "copy-mode-vi";
    const wheelUpPrimary = ctx.tmux.listKeys(primaryTable, "WheelUpPane");
    const wheelUpFallback = ctx.tmux.listKeys(fallbackTable, "WheelUpPane");
    tmux.wheelBindingUp = wheelUpPrimary ?? wheelUpFallback ?? undefined;
    if (tmux.wheelBindingUp) {
      // Crude marker: the yolo-code tmux snippet uses `-N3` for both keymaps.
      tmux.yoloBlockDetected = /-N3\s+-X\s+scroll-up/.test(tmux.wheelBindingUp);
    }
  }

  const webappTile = classifyWebappTile(env);
  const recommendations = buildRecommendations({ tmux, webappTile, tty: { stdout: ctx.stdoutIsTTY, stdin: ctx.stdinIsTTY } });

  return {
    terminal,
    host: ctx.platform,
    tty: { stdout: ctx.stdoutIsTTY, stdin: ctx.stdinIsTTY },
    tmux,
    webappTile,
    recommendations,
  };
}

function buildRecommendations(input: {
  tmux: ProbeReport["tmux"];
  webappTile: ProbeReport["webappTile"];
  tty: { stdout: boolean; stdin: boolean };
}): string[] {
  const recs: string[] = [];
  if (!input.tty.stdout) {
    recs.push("non-interactive stdout — recommendations may be incomplete");
  }
  if (input.webappTile.inside) {
    recs.push(
      "inside YOLO Studio webapp tile — the alt-screen wheel bridge owns scroll for codex/claude/vim. Trackpad batches into ~3 lines per RAF. Shift+wheel = page mode. Ctrl+Shift+S opens the full scrollback overlay.",
    );
  }
  if (input.tmux.inside) {
    if (input.tmux.mouse === "off") {
      recs.push(
        "tmux mouse is OFF — wheel events skip tmux and go straight to your host terminal (or xterm.js inside the webapp). This is the YOLO container default and matches the bridge design.",
      );
    } else if (input.tmux.mouse === "on") {
      if (input.webappTile.inside) {
        // Inside the webapp tile, scroll for alt-screen TUIs is owned
        // by Terminal.tsx's JS wheel handler — it intercepts in the
        // capture phase and synthesizes cursor/PgUp keys directly to
        // tmux copy-mode. tmux's own WheelUpPane bindings never fire
        // here, so recommending `yolo-code tmux install` would point
        // the user at a config that won't affect what they're seeing.
        recs.push(
          "tmux mouse is ON but you're inside the webapp tile — the JS wheel bridge in Terminal.tsx controls scroll for alt-screen TUIs here, so your tmux WheelUpPane bindings are not the relevant knob. `yolo-code tmux install` only helps when running these TUIs in a native terminal under your own tmux.",
        );
      } else if (input.tmux.yoloBlockDetected) {
        recs.push("tmux mouse is ON and the YOLO wheel-sensitivity block is installed — 3 lines per wheel tick in copy-mode.");
      } else {
        recs.push(
          "tmux mouse is ON but the YOLO wheel-sensitivity block is not detected — wheel events scroll 5 lines per tick (stock tmux) which feels brutal on a trackpad. Run `yolo-code tmux install` to tame it.",
        );
      }
    }
  } else if (!input.webappTile.inside) {
    recs.push("no tmux detected — yolo-code/codex/claude will use your terminal's native scrollback when alt-screen is off.");
  }
  return recs;
}

export function formatReport(r: ProbeReport): string {
  const lines: string[] = [];
  const termLabel = r.terminal.program
    ? `${r.terminal.type}  (${r.terminal.program}${r.terminal.programVersion ? " v" + r.terminal.programVersion : ""})`
    : r.terminal.type;
  lines.push(`terminal:     ${termLabel}`);
  lines.push(`host:         ${r.host}`);
  lines.push(`tty:          stdout=${r.tty.stdout ? "yes" : "no"}, stdin=${r.tty.stdin ? "yes" : "no"}`);

  if (r.tmux.inside) {
    const meta: string[] = [];
    if (r.tmux.session) meta.push(`session=${r.tmux.session}`);
    if (r.tmux.pane !== undefined) meta.push(`pane=${r.tmux.pane}`);
    lines.push(`tmux:         inside${meta.length ? "  (" + meta.join(", ") + ")" : ""}`);
    lines.push(`  mouse:      ${r.tmux.mouse ?? "unknown"}`);
    lines.push(`  history:    ${r.tmux.historyLimit ?? "unknown"}`);
    lines.push(
      `  copy-mode:  ${r.tmux.copyMode == null ? "unknown" : r.tmux.copyMode ? "active" : "idle"}`,
    );
    const yoloMark = r.tmux.yoloBlockDetected ? "  ✓ yolo-code tmux block" : "";
    lines.push(`  wheel-up:   ${r.tmux.wheelBindingUp ?? "unknown"}${yoloMark}`);
  } else {
    lines.push("tmux:         not running");
  }
  lines.push(
    `webapp tile:  ${r.webappTile.inside ? `yes${r.webappTile.sessionId ? "  (session=" + r.webappTile.sessionId.slice(0, 12) + "…)" : ""}` : "no"}`,
  );
  lines.push("");
  lines.push("Recommendations:");
  if (r.recommendations.length === 0) {
    lines.push("  (none)");
  } else {
    for (const rec of r.recommendations) {
      lines.push(`  • ${rec}`);
    }
  }
  return lines.join("\n");
}

// Concrete tmux runner backed by spawnSync. Returns null on any failure
// so the probe stays useful even when tmux isn't installed or refuses
// to answer (e.g. wrong server socket).
export function realTmuxRunner(): TmuxRunner {
  const run = (args: string[]): string | null => {
    try {
      const result = spawnSync("tmux", args, { encoding: "utf8", timeout: 1500 });
      if (result.status !== 0) return null;
      const out = (result.stdout ?? "").trim();
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  };
  return {
    show: (option) => run(["show-options", "-gv", option]),
    display: (format) => run(["display-message", "-p", format]),
    listKeys: (table, key) => run(["list-keys", "-T", table, key]),
  };
}

export async function runProbeScroll(): Promise<number> {
  const ctx: ProbeEnv = {
    env: process.env,
    platform: process.platform,
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    tmux: realTmuxRunner(),
  };
  const report = buildReport(ctx);
  process.stdout.write(formatReport(report) + "\n");
  return 0;
}
