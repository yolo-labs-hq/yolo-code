import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { Usage } from "../agent/messages.js";
import type { Theme } from "./theme.js";
import type { ReasoningEffort } from "../config.js";
import type { Mode } from "../mode.js";
import { calculateCost } from "../pricing.js";
import { quietUiEnabled } from "./octavius.js";

/** Horizontal illumination wave over the word "thinking". A bright
 *  "head" sweeps left→right with two dimmer trailing letters, then the
 *  word goes dark for a few ticks before the next sweep. Ticks at
 *  ~220 ms — every tick triggers an Ink frame commit, and xterm.js
 *  front-ends with external scroll containers thrash on every commit,
 *  so we err on the slow side. Set YOLO_CODE_QUIET_UI=1 to freeze the
 *  wave entirely (renders "thinking" dimmed but static). */
function ThinkingPulse({ color }: { color: string }) {
  const word = "thinking";
  const [tick, setTick] = useState(0);
  const frozen = quietUiEnabled();
  useEffect(() => {
    if (frozen) return;
    const id = setInterval(() => setTick((t) => (t + 1) % (word.length + 4)), 220);
    return () => clearInterval(id);
  }, [frozen]);
  if (frozen) {
    return (
      <Text color={color} dimColor>
        {word}
      </Text>
    );
  }
  return (
    <>
      {word.split("").map((ch, i) => {
        const dist = tick - i;
        const bold = dist === 0;
        const dim = dist < 0 || dist > 2;
        return (
          <Text key={i} color={color} bold={bold} dimColor={dim}>
            {ch}
          </Text>
        );
      })}
    </>
  );
}

interface Props {
  model: string;
  usage: Usage | null;
  thinking: boolean;
  turnStartedAt: number | null;
  theme: Theme;
  mode: Mode;
  effort: ReasoningEffort;
  contextLimit: number;
  hasUpdate?: boolean;
  latestVersion?: string | null;
}

export function StatusBar({ model, usage, thinking, turnStartedAt, theme, mode, effort, contextLimit, hasUpdate, latestVersion }: Props) {
  const [now, setNow] = useState(Date.now());
  const modeColor =
    mode === "plan" ? theme.modeBadge.plan : mode === "auto" ? theme.modeBadge.auto : theme.modeBadge.edit;
  const warn = usage && usage.prompt_tokens / contextLimit >= 0.8;

  // Track the previous turn's prompt_tokens so we can show a per-turn
  // delta in the status bar. Operators see trajectory ("ctx 47% (+3.2k)")
  // not just the current level — making it possible to catch a runaway
  // growth pattern (large tool output, no compaction) before hitting
  // the 80% warning. Updated only when prompt_tokens actually changed
  // (re-renders during streaming don't re-snapshot).
  //
  // Resets to null when `usage` clears — /clear and session switches
  // both pass `null` and the next turn's first delta should be against
  // the new conversation, not the previous one (codex round 1 P2).
  const prevPromptTokensRef = useRef<number | null>(null);
  const previousPromptTokens = prevPromptTokensRef.current;
  useEffect(() => {
    if (usage === null) {
      prevPromptTokensRef.current = null;
      return;
    }
    if (usage.prompt_tokens !== prevPromptTokensRef.current) {
      prevPromptTokensRef.current = usage.prompt_tokens;
    }
  }, [usage]);

  useEffect(() => {
    if (!thinking || turnStartedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [thinking, turnStartedAt]);

  const elapsed = turnStartedAt !== null ? formatElapsed(now - turnStartedAt) : null;

  const leftParts: string[] = [`${shortModel(model)}`, effort];

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={modeColor} bold>
          [{mode}]
        </Text>
        <Text> </Text>
        {thinking ? (
          <Box>
            <ThinkingPulse color={theme.spinner} />
            {elapsed ? (
              <Text color={theme.spinner} dimColor>
                {` · ${elapsed}`}
              </Text>
            ) : null}
          </Box>
        ) : (
          <Text color={theme.info.color} dimColor={theme.info.dim}>
            {leftParts.join("  ·  ")}  ·  ready
          </Text>
        )}
      </Box>
      {usage && (
        <Box>
          <Text color={theme.info.color} dimColor={theme.info.dim}>
            {`in ${formatTokens(usage.prompt_tokens)}`}
            {(() => {
              const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
              return cached ? ` (${formatTokens(cached)} cached)` : "";
            })()}
            {`  ·  out ${formatTokens(usage.completion_tokens)}  ·  ctx `}
          </Text>
          {/* Inline progress bar — colored by threshold so an operator
              scanning the row catches the trajectory before reading the
              number. ASCII blocks (no special font dep). */}
          <Text color={ctxColor(usage.prompt_tokens, contextLimit, theme)}>
            {ctxBar(usage.prompt_tokens, contextLimit, 10)}
          </Text>
          <Text color={theme.info.color} dimColor={theme.info.dim}>
            {` ${Math.round((usage.prompt_tokens / contextLimit) * 100)}%`}
            {(() => {
              if (
                previousPromptTokens === null ||
                previousPromptTokens === usage.prompt_tokens
              ) {
                return "";
              }
              const delta = usage.prompt_tokens - previousPromptTokens;
              const sign = delta >= 0 ? "+" : "−";
              return ` (${sign}${formatTokens(Math.abs(delta))})`;
            })()}
            {`  ·  $${calculateCost(
              usage.prompt_tokens,
              usage.completion_tokens,
              usage.prompt_tokens_details?.cached_tokens ?? 0,
            ).total.toFixed(5)}`}
          </Text>
          {warn ? (
            <Text color={theme.warn} bold>
              {"  ·  "}/compact recommended
            </Text>
          ) : null}
          {hasUpdate ? (
            <Text color={theme.warn} bold>
              {"  ·  "}update available{latestVersion ? ` → ${latestVersion}` : ""} · run /update
            </Text>
          ) : null}
        </Box>
      )}
    </Box>
  );
}

/** Render a fixed-width Unicode block progress bar for the context-usage
 *  ratio. Filled cells use ▰ (heavy bar), empty cells use ▱ (light bar) —
 *  both are widely supported in monospace fonts and align cleanly with
 *  ASCII columns. */
export function ctxBar(used: number, limit: number, width: number): string {
  if (limit <= 0 || width <= 0) return "";
  const pct = Math.min(1, Math.max(0, used / limit));
  const filled = Math.round(pct * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/** Threshold-colored bar:
 *    < 50% → assistant color (neutral / "fine")
 *    50–80% → permission color (yellow-ish — pay attention)
 *    ≥ 80%  → warn color (the same color as the /compact recommendation
 *             so the eye lands on a consistent cue) */
export function ctxColor(used: number, limit: number, theme: Theme): string | undefined {
  if (limit <= 0) return undefined;
  const pct = used / limit;
  if (pct >= 0.8) return theme.warn;
  if (pct >= 0.5) return theme.permission;
  return theme.assistant ?? theme.info.color;
}

/** Compact token count with k/M suffix so the status bar stays
 *  readable for large contexts. 12_345 → "12.3k"; 1_234_567 → "1.23M". */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? k.toFixed(0) : k >= 10 ? k.toFixed(1) : k.toFixed(2)}k`;
  }
  const m = n / 1_000_000;
  return `${m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2)}M`;
}

function shortModel(m: string): string {
  const last = m.split("/").at(-1) ?? m;
  return last;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}
