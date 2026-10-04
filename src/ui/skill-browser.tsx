// Interactive skill browser TUI. Replaces the text-dump rendering of
// `/skills browse` (which printed a padded-column table into a single
// `info` event — operators reported it as cluttered and unusable).
//
// Layout:
//   ╭─ Skill browser ─────────────────────────────────────╮
//   │ /<filter>            …                              │
//   │ ● example-skill  installed   Author a …       │
//   │ ◇ vitest-runner        endorsed    Run vitest …     │
//   │ ▶ debugging-and-…      available   Systematic …    ← cursor
//   │ ─── debugging-and-error-recovery ───                │
//   │ Systematic root-cause debugging. Use when tests …   │
//   │ tags: debug, error · license: MIT · version: 1.0.0  │
//   │ ↑↓ navigate · / filter · enter install · u unins…   │
//   ╰─────────────────────────────────────────────────────╯
//
// Keyboard:
//   ↑/k / ↓/j   move cursor
//   /           start filter (chars append; backspace; enter exits filter)
//   esc         cancel filter (or close browser if filter empty)
//   enter       install focused skill (or no-op if already installed)
//   u           uninstall focused skill (only if installed)
//   r           refresh registry from network (bypass 10-min cache)
//   q           close browser

import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { SkillBrowserEntry, SkillBrowserState } from "../cli/skills-cmd.js";
import type { Theme } from "./theme.js";

export type SkillBrowserAction =
  | { kind: "close" }
  | { kind: "install"; name: string }
  | { kind: "uninstall"; name: string }
  | { kind: "refresh" };

interface Props {
  state: SkillBrowserState;
  /** Loading state — set by parent while a refresh / install is in flight.
   *  Disables keypress handlers and shows a footer hint. */
  busy: boolean;
  /** Optional last-action status line shown in the footer ("installing
   *  example-skill…", "installed", "error: …"). */
  status: string | null;
  /** Seeds the filter text on first render. Used when the operator
   *  invokes `/skills search <term>` — the parsed query is passed
   *  through so they don't have to retype it (codex round 1 P2). */
  initialFilter?: string;
  onAction: (a: SkillBrowserAction) => void;
  theme: Theme;
}

const MIN_LIST_ROWS = 6;
const MAX_LIST_ROWS = 20;
const DETAIL_ROWS = 7; // separator + description (≤3 wrapped lines) + tags/license + spacer + footer

export function SkillBrowser({ state, busy, status, initialFilter, onAction, theme }: Props) {
  const { columns, rows } = useWindowSize();
  // Codex round 1 P2: respect narrow terminals (split panes, SSH).
  // The old `Math.max(60, ...)` forced the bordered box wider than
  // the screen and Ink overflowed. Floor of 20 keeps something
  // renderable; ceiling of 120 prevents the detail pane from
  // ballooning on ultrawide terminals.
  const totalWidth = Math.max(20, Math.min(columns - 2, 120));
  // List window sizing — leave room for header (3) + detail pane (DETAIL_ROWS)
  // + filter line (1) + footer (1) + borders (2).
  const listRows = Math.max(
    MIN_LIST_ROWS,
    Math.min(MAX_LIST_ROWS, rows - DETAIL_ROWS - 7),
  );

  const [filter, setFilter] = useState(initialFilter ?? "");
  const [filterMode, setFilterMode] = useState(false);
  const [cursor, setCursor] = useState(0);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return state.entries;
    return state.entries.filter((e) => {
      const hay = [e.name, e.description, ...e.tags].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [filter, state.entries]);

  // Clamp the cursor when the filter changes the list length.
  useEffect(() => {
    if (cursor >= filtered.length) {
      setCursor(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, cursor]);

  // Window of visible rows around the cursor.
  const windowStart = Math.max(
    0,
    Math.min(cursor - Math.floor(listRows / 2), filtered.length - listRows),
  );
  const windowEnd = Math.min(filtered.length, windowStart + listRows);
  const visible = filtered.slice(windowStart, windowEnd);

  const focused = filtered[cursor] ?? null;

  useInput((input, key) => {
    if (busy) return;

    if (filterMode) {
      if (key.return) {
        setFilterMode(false);
        return;
      }
      if (key.escape) {
        setFilter("");
        setFilterMode(false);
        return;
      }
      if (key.backspace || key.delete) {
        setFilter((f) => f.slice(0, -1));
        return;
      }
      // Ignore arrow keys / ctrl while typing.
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.ctrl || key.meta) {
        return;
      }
      if (input && input.length === 1 && !key.tab) {
        setFilter((f) => f + input);
      }
      return;
    }

    if (key.escape || input === "q") {
      onAction({ kind: "close" });
      return;
    }
    if (input === "/") {
      setFilterMode(true);
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(filtered.length - 1, c + 1));
      return;
    }
    if (key.pageUp) {
      setCursor((c) => Math.max(0, c - listRows));
      return;
    }
    if (key.pageDown) {
      setCursor((c) => Math.min(filtered.length - 1, c + listRows));
      return;
    }
    if (input === "g") {
      setCursor(0);
      return;
    }
    if (input === "G") {
      setCursor(Math.max(0, filtered.length - 1));
      return;
    }
    if (input === "r") {
      onAction({ kind: "refresh" });
      return;
    }
    if (key.return) {
      if (focused && !focused.installed) onAction({ kind: "install", name: focused.name });
      return;
    }
    if (input === "u" && focused && focused.installed) {
      onAction({ kind: "uninstall", name: focused.name });
      return;
    }
  });

  // Row layout — scales with `totalWidth` so narrow terminals don't
  // overflow the bordered box (codex round 2 P2 + round 3 P3).
  // Fixed per-row overhead: 2-char cursor + 2-char marker + 4 spacer
  // chars = 8 chars. Everything else (name / status text /
  // description) flexes. Breakpoints are keyed on `innerWidth`
  // (the post-border width — what an operator perceives as "the
  // pane is N columns wide") so the stated thresholds match
  // reality:
  //
  //   ≥ 50 inner cols (≥ 54 outer):
  //       name(<=28) · status(9) · desc(rest) — the "wide" layout
  //   30 – 49 inner cols (split-pane SSH):
  //       name(<=18) · description (status marker conveys state via
  //       color; status TEXT dropped)
  //   < 30 inner cols (very narrow):
  //       name only (truncated), description hidden
  const innerWidth = Math.max(8, totalWidth - 4); // -4 = border + paddingX*2
  const flexWidth = Math.max(4, innerWidth - 8); // 8 = cursor/marker/spacer overhead
  const longestName = Math.max(4, ...filtered.map((e) => e.name.length));
  const showStatusText = innerWidth >= 50;
  const showDescription = innerWidth >= 30;
  const STATUS_W = showStatusText ? 9 : 0;
  const NAME_W = showDescription
    ? Math.min(showStatusText ? 28 : 18, longestName, Math.max(6, flexWidth - STATUS_W - 12))
    : Math.min(longestName, flexWidth);
  const descWidth = Math.max(0, flexWidth - NAME_W - STATUS_W);

  // Header
  const header = (
    <Box flexDirection="column">
      <Text color={theme.accent} bold>
        Skill browser
      </Text>
      <Text color={theme.info.color} dimColor={theme.info.dim}>
        {state.error
          ? `offline — could not fetch registry: ${truncate(state.error, totalWidth - 30)}`
          : `${filtered.length} of ${state.total} skills${filter ? ` matching "${filter}"` : ""}`}
      </Text>
    </Box>
  );

  // Filter line (always shown; shows current text or hint)
  const filterLine = (
    <Box>
      <Text color={theme.info.color} dimColor={!filterMode && filter.length === 0}>
        {filterMode ? "/ " : filter.length > 0 ? "/ " : "  "}
        {filter || (filterMode ? "(type to filter, enter to exit)" : "press / to filter")}
        {filterMode ? "_" : ""}
      </Text>
    </Box>
  );

  // List body
  const list = (
    <Box flexDirection="column">
      {visible.length === 0 ? (
        <Text color={theme.info.color} dimColor={theme.info.dim}>
          {state.error ? "(no skills — registry unreachable)" : "(no matches)"}
        </Text>
      ) : (
        visible.map((entry, i) => {
          const absIdx = windowStart + i;
          const isCursor = absIdx === cursor;
          const marker = entry.installed ? "●" : entry.endorsed ? "◇" : "○";
          const status = entry.installed ? "installed" : entry.endorsed ? "endorsed " : "available";
          const desc = showDescription
            ? truncate(entry.description.replace(/\s+/g, " "), descWidth)
            : "";
          const nameCell = truncate(entry.name, NAME_W).padEnd(NAME_W);
          return (
            <Text
              key={entry.name}
              color={isCursor ? theme.accent : undefined}
              bold={isCursor}
            >
              {isCursor ? "▶ " : "  "}
              <Text color={statusColor(entry, theme)}>{marker}</Text>{" "}
              <Text>{nameCell}</Text>
              {showStatusText ? (
                <>
                  {"  "}
                  <Text color={statusColor(entry, theme)}>{status.padEnd(STATUS_W)}</Text>
                </>
              ) : null}
              {showDescription ? (
                <>
                  {"  "}
                  <Text color={isCursor ? theme.accent : theme.info.color} dimColor={!isCursor && theme.info.dim}>{desc}</Text>
                </>
              ) : null}
            </Text>
          );
        })
      )}
      {/* Window indicator when there's more above/below */}
      {filtered.length > visible.length && (
        <Text color={theme.info.color} dimColor={theme.info.dim}>
          {`  ↕ ${windowStart + 1}–${windowEnd} of ${filtered.length}${windowStart > 0 ? "  ↑ more above" : ""}${windowEnd < filtered.length ? "  ↓ more below" : ""}`}
        </Text>
      )}
    </Box>
  );

  // Detail pane for the focused entry
  const detail = focused ? (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.accent}>
        {"─── "}
        <Text bold>{focused.name}</Text>
        {focused.version ? <Text color={theme.info.color} dimColor={theme.info.dim}>{` v${focused.version}`}</Text> : null}
        {" ───"}
      </Text>
      <Text>{wrap(focused.description || "(no description)", totalWidth - 4, 3)}</Text>
      <Text color={theme.info.color} dimColor={theme.info.dim}>
        {[
          focused.tags.length > 0 ? `tags: ${focused.tags.join(", ")}` : null,
          focused.license ? `license: ${focused.license}` : null,
          focused.installed ? "✓ installed" : focused.endorsed ? "endorsed" : "available",
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
    </Box>
  ) : null;

  // Footer (keybinds + status)
  const footer = (
    <Box marginTop={1}>
      <Text color={theme.info.color} dimColor={theme.info.dim}>
        {status
          ? status
          : focused
            ? `↑↓ navigate · / filter · ${focused.installed ? "u uninstall" : "enter install"} · r refresh · q close`
            : "↑↓ navigate · / filter · r refresh · q close"}
      </Text>
    </Box>
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} width={totalWidth}>
      {header}
      <Box marginTop={1}>{filterLine}</Box>
      <Box marginTop={1} flexDirection="column">
        {list}
      </Box>
      {detail}
      {footer}
    </Box>
  );
}

function statusColor(entry: SkillBrowserEntry, theme: Theme): string | undefined {
  if (entry.installed) return theme.accent;
  if (entry.endorsed) return theme.permission;
  return undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}

/** Word-wrap a string to `width` columns, capped at `maxLines`. The last
 *  line is truncated with an ellipsis if the body overflows. */
function wrap(s: string, width: number, maxLines: number): string {
  const words = s.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > width) {
      if (cur) lines.push(cur);
      cur = word;
      if (lines.length >= maxLines) {
        lines[maxLines - 1] = truncate(lines[maxLines - 1] ?? "", width);
        return lines.join("\n");
      }
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = truncate(lines[maxLines - 1] ?? "", width);
  }
  return lines.join("\n");
}
