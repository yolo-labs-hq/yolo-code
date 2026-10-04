import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildReport,
  classifyWebappTile,
  formatReport,
  type ProbeEnv,
  type TmuxRunner,
} from "./probe-scroll-cmd.js";

function fakeTmux(answers: Partial<{
  showOptions: Record<string, string>;
  displays: Record<string, string>;
  listKeys: Record<string, string>; // key = `${table}::${key}`
}> = {}): TmuxRunner {
  return {
    show: (option) => answers.showOptions?.[option] ?? null,
    display: (fmt) => answers.displays?.[fmt] ?? null,
    listKeys: (table, key) => answers.listKeys?.[`${table}::${key}`] ?? null,
  };
}

function noopTmux(): TmuxRunner {
  return { show: () => null, display: () => null, listKeys: () => null };
}

describe("classifyWebappTile", () => {
  it("detects webapp tile when SESSION_ID and YOLO_COMMON_API_URL are both set", () => {
    const r = classifyWebappTile({ SESSION_ID: "abc123", YOLO_COMMON_API_URL: "https://api.yolo.studio" });
    assert.strictEqual(r.inside, true);
    assert.strictEqual(r.sessionId, "abc123");
  });

  it("does not flag a stale shell with only one of the two vars", () => {
    assert.strictEqual(classifyWebappTile({ SESSION_ID: "abc" }).inside, false);
    assert.strictEqual(classifyWebappTile({ YOLO_COMMON_API_URL: "https://api" }).inside, false);
    assert.strictEqual(classifyWebappTile({}).inside, false);
  });

  it("detects webapp tile via YOLO_API_URL (the container-entrypoint alias) (codex R12 P2)", () => {
    // Container entrypoints export YOLO_API_URL; the substrate CLI auth
    // contract uses YOLO_COMMON_API_URL. Either is a valid signal.
    const r = classifyWebappTile({ SESSION_ID: "abc", YOLO_API_URL: "https://api.yolo.studio" });
    assert.strictEqual(r.inside, true);
    assert.strictEqual(r.sessionId, "abc");
  });
});

describe("buildReport (no tmux)", () => {
  it("reports terminal type and host with no tmux subsection", () => {
    const ctx: ProbeEnv = {
      env: { TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.1" },
      platform: "darwin",
      stdoutIsTTY: true,
      stdinIsTTY: true,
      tmux: noopTmux(),
    };
    const r = buildReport(ctx);
    assert.strictEqual(r.terminal.type, "xterm-256color");
    assert.strictEqual(r.terminal.program, "iTerm.app");
    assert.strictEqual(r.host, "darwin");
    assert.strictEqual(r.tmux.inside, false);
    assert.strictEqual(r.webappTile.inside, false);
    assert.ok(r.recommendations.some((s) => /no tmux detected/.test(s)));
  });
});

describe("buildReport (inside tmux, no yolo block)", () => {
  it("flags stock 5-line wheel and recommends `yolo-code tmux install`", () => {
    const ctx: ProbeEnv = {
      env: { TERM: "tmux-256color", TMUX: "/tmp/tmux-1000/default,1234,0" },
      platform: "darwin",
      stdoutIsTTY: true,
      stdinIsTTY: true,
      tmux: fakeTmux({
        showOptions: { mouse: "on", "history-limit": "50000" },
        displays: { "#{session_name}": "main", "#{pane_index}": "0", "#{pane_in_mode}": "0" },
        listKeys: {
          "copy-mode::WheelUpPane": "bind-key -T copy-mode WheelUpPane select-pane \\; send-keys -X -N 5 scroll-up",
        },
      }),
    };
    const r = buildReport(ctx);
    assert.strictEqual(r.tmux.inside, true);
    assert.strictEqual(r.tmux.mouse, "on");
    assert.strictEqual(r.tmux.historyLimit, "50000");
    assert.strictEqual(r.tmux.copyMode, false);
    assert.strictEqual(r.tmux.yoloBlockDetected, false);
    assert.ok(r.recommendations.some((s) => /yolo-code tmux install/.test(s)));
  });
});

describe("buildReport (mode-keys vi)", () => {
  it("reads the copy-mode-vi binding as the primary table for vi users (codex R12 P2)", () => {
    // User has mode-keys=vi and installed the YOLO block, but only the
    // vi table was customized (the emacs table still has the stock
    // 5-line binding). Previously we read copy-mode first and missed
    // the YOLO install — falsely recommended re-installing.
    const ctx: ProbeEnv = {
      env: { TMUX: "/tmp/tmux/x" },
      platform: "linux",
      stdoutIsTTY: true,
      stdinIsTTY: true,
      tmux: fakeTmux({
        showOptions: { mouse: "on", "history-limit": "50000", "mode-keys": "vi" },
        listKeys: {
          "copy-mode::WheelUpPane":
            "bind-key -T copy-mode WheelUpPane select-pane \\; send-keys -X -N 5 scroll-up",
          "copy-mode-vi::WheelUpPane":
            "bind-key -T copy-mode-vi WheelUpPane send -N3 -X scroll-up",
        },
      }),
    };
    const r = buildReport(ctx);
    assert.strictEqual(r.tmux.yoloBlockDetected, true);
    assert.match(r.tmux.wheelBindingUp ?? "", /copy-mode-vi/);
    assert.ok(!r.recommendations.some((s) => /Run `yolo-code tmux install`/.test(s)));
  });

  it("default mode-keys (emacs) reads copy-mode first", () => {
    const ctx: ProbeEnv = {
      env: { TMUX: "/tmp/tmux/x" },
      platform: "linux",
      stdoutIsTTY: true,
      stdinIsTTY: true,
      tmux: fakeTmux({
        showOptions: { mouse: "on", "mode-keys": "emacs" },
        listKeys: {
          "copy-mode::WheelUpPane":
            "bind-key -T copy-mode WheelUpPane send -N3 -X scroll-up",
          "copy-mode-vi::WheelUpPane":
            "bind-key -T copy-mode-vi WheelUpPane send-keys -X -N 5 scroll-up",
        },
      }),
    };
    const r = buildReport(ctx);
    assert.match(r.tmux.wheelBindingUp ?? "", /^bind-key -T copy-mode /);
    assert.strictEqual(r.tmux.yoloBlockDetected, true);
  });
});

describe("buildReport (inside tmux, yolo block installed)", () => {
  it("detects the -N3 marker and skips the install recommendation", () => {
    const ctx: ProbeEnv = {
      env: { TERM: "tmux-256color", TMUX: "/tmp/tmux/default,1,0" },
      platform: "darwin",
      stdoutIsTTY: true,
      stdinIsTTY: true,
      tmux: fakeTmux({
        showOptions: { mouse: "on", "history-limit": "50000" },
        listKeys: {
          "copy-mode::WheelUpPane": "bind-key -T copy-mode WheelUpPane send -N3 -X scroll-up",
        },
      }),
    };
    const r = buildReport(ctx);
    assert.strictEqual(r.tmux.yoloBlockDetected, true);
    assert.ok(r.recommendations.some((s) => /YOLO wheel-sensitivity block is installed/.test(s)));
    assert.ok(!r.recommendations.some((s) => /yolo-code tmux install/.test(s)));
  });
});

describe("buildReport (webapp tile)", () => {
  it("flags the alt-screen bridge as the scroll owner inside the tile", () => {
    const ctx: ProbeEnv = {
      env: {
        SESSION_ID: "69f98c3529805f24dc2df4ad",
        YOLO_COMMON_API_URL: "https://api.yolo.studio",
        TERM: "xterm-256color",
      },
      platform: "linux",
      stdoutIsTTY: true,
      stdinIsTTY: true,
      tmux: noopTmux(),
    };
    const r = buildReport(ctx);
    assert.strictEqual(r.webappTile.inside, true);
    assert.ok(r.recommendations.some((s) => /alt-screen wheel bridge/.test(s)));
  });

  it("inside webapp tile + tmux mouse on, does NOT recommend `yolo-code tmux install` (codex R3 P2)", () => {
    // The JS bridge in Terminal.tsx intercepts wheel events in the capture
    // phase, so the user's tmux WheelUpPane bindings never fire in this
    // environment. Recommending the tmux config would misdirect.
    const ctx: ProbeEnv = {
      env: {
        SESSION_ID: "sess",
        YOLO_COMMON_API_URL: "https://api.yolo.studio",
        TMUX: "/tmp/tmux/x",
      },
      platform: "linux",
      stdoutIsTTY: true,
      stdinIsTTY: true,
      tmux: fakeTmux({ showOptions: { mouse: "on" } }),
    };
    const r = buildReport(ctx);
    assert.strictEqual(r.webappTile.inside, true);
    assert.ok(!r.recommendations.some((s) => /Run `yolo-code tmux install`/.test(s)));
    assert.ok(r.recommendations.some((s) => /JS wheel bridge in Terminal\.tsx controls scroll/.test(s)));
  });
});

describe("buildReport (tmux mouse off)", () => {
  it("notes the wheel passes through to the host terminal / xterm.js", () => {
    const ctx: ProbeEnv = {
      env: { TMUX: "/tmp/tmux/x" },
      platform: "linux",
      stdoutIsTTY: true,
      stdinIsTTY: true,
      tmux: fakeTmux({ showOptions: { mouse: "off" } }),
    };
    const r = buildReport(ctx);
    assert.strictEqual(r.tmux.mouse, "off");
    assert.ok(r.recommendations.some((s) => /tmux mouse is OFF/.test(s)));
  });
});

describe("formatReport", () => {
  it("renders all major sections", () => {
    const out = formatReport({
      terminal: { type: "xterm-256color", program: "iTerm.app", programVersion: "3.5.1" },
      host: "darwin",
      tty: { stdout: true, stdin: true },
      tmux: {
        inside: true,
        session: "main",
        pane: "0",
        mouse: "on",
        historyLimit: "50000",
        copyMode: false,
        wheelBindingUp: "bind-key -T copy-mode WheelUpPane send -N3 -X scroll-up",
        yoloBlockDetected: true,
      },
      webappTile: { inside: false },
      recommendations: ["test rec"],
    });
    assert.match(out, /terminal:.*xterm-256color.*iTerm\.app/);
    assert.match(out, /host:\s+darwin/);
    assert.match(out, /tmux:\s+inside\s+\(session=main, pane=0\)/);
    assert.match(out, /mouse:\s+on/);
    assert.match(out, /wheel-up:.*✓ yolo-code tmux block/);
    assert.match(out, /webapp tile:\s+no/);
    assert.match(out, /Recommendations:[\s\S]*• test rec/);
  });
});
