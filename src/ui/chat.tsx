import React from "react";
import { Box, Static, Text } from "ink";
import { ToolView, type ToolEventState } from "./tool-view.js";
import { MD } from "./markdown.js";
import type { Theme } from "./theme.js";

export type ChatEvent =
  | { kind: "user"; key: string; text: string; images?: string[] }
  | {
      kind: "assistant";
      key: string;
      id: number;
      text: string;
      reasoning: string;
      streaming: boolean;
      /** Set on onAssistantFinal: true iff this assistant turn emitted
       *  ≥1 tool call. Used by the renderer to decide whether a turn
       *  with empty text + reasoning should fall back to showing the
       *  reasoning so the user isn't staring at an invisible turn.
       *  Stays `undefined` while streaming; the renderer treats
       *  undefined as "still unknown — defer to streaming state". */
      hadToolCalls?: boolean;
    }
  | ({ kind: "tool"; key: string } & ToolEventState)
  | { kind: "info"; key: string; text: string }
  | { kind: "error"; key: string; text: string };

interface Props {
  events: ChatEvent[];
  showReasoning: boolean;
  theme: Theme;
  verbose?: boolean;
}

/** An event is "finalized" once it can't change: user messages, info,
 *  error, done assistants, and done/error tools. Streaming assistants and
 *  running tools must keep re-rendering as tokens arrive. */
function isFinalized(e: ChatEvent): boolean {
  if (e.kind === "assistant") return !e.streaming;
  if (e.kind === "tool") return e.status !== "running";
  return true;
}

/** Find the boundary between finalized events (safe to commit to Ink's
 *  <Static>, which renders each item exactly once) and live events
 *  (re-rendered on every state change). The boundary is the index of the
 *  FIRST non-finalized event; everything before it is static even if a
 *  later event flips back to non-final (rare but possible via retry). */
function staticCutoff(events: ChatEvent[]): number {
  for (let i = 0; i < events.length; i++) {
    if (!isFinalized(events[i]!)) return i;
  }
  return events.length;
}

export const ChatView = React.memo(function ChatView({ events, showReasoning, theme, verbose }: Props) {
  const cutoff = staticCutoff(events);
  const finalized = events.slice(0, cutoff);
  const live = events.slice(cutoff);

  return (
    <>
      {/* <Static> commits each event to the terminal exactly once —
       *  finalized events never re-render, which kills the per-token
       *  flicker that came from re-rendering the full transcript on
       *  every streaming delta. */}
      <Static items={finalized}>
        {(e, i) => {
          const prev = finalized[i - 1];
          const showSeparator =
            e.kind === "user" && prev && (prev.kind === "assistant" || prev.kind === "tool");
          return (
            <Box key={e.key} flexDirection="column">
              {showSeparator && (
                <Box marginY={1}>
                  <Text color={theme.info.color} dimColor={theme.info.dim}>
                    {"─".repeat(40)}
                  </Text>
                </Box>
              )}
              <EventView evt={e} showReasoning={showReasoning} theme={theme} verbose={verbose} />
            </Box>
          );
        }}
      </Static>
      {/* Live region: streaming assistant + any in-flight tools. */}
      <Box flexDirection="column">
        {live.map((e, i) => {
          const prev = i === 0 ? finalized[finalized.length - 1] : live[i - 1];
          const showSeparator =
            e.kind === "user" && prev && (prev.kind === "assistant" || prev.kind === "tool");
          return (
            <Box key={e.key} flexDirection="column">
              {showSeparator && (
                <Box marginY={1}>
                  <Text color={theme.info.color} dimColor={theme.info.dim}>
                    {"─".repeat(40)}
                  </Text>
                </Box>
              )}
              <EventView evt={e} showReasoning={showReasoning} theme={theme} verbose={verbose} />
            </Box>
          );
        })}
      </Box>
    </>
  );
});

const EventView = React.memo(function EventView({
  evt,
  showReasoning,
  theme,
  verbose,
}: {
  evt: ChatEvent;
  showReasoning: boolean;
  theme: Theme;
  verbose?: boolean;
}) {
  if (evt.kind === "user") {
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color={theme.user}>
            ›{" "}
          </Text>
          <Text bold>{evt.text}</Text>
        </Box>
        {evt.images && evt.images.length > 0 && (
          <Box paddingLeft={2}>
            <Text color={theme.info.color} dimColor={theme.info.dim}>
              🖼️ {evt.images.join(", ")}
            </Text>
          </Box>
        )}
      </Box>
    );
  }
  if (evt.kind === "assistant") {
    // Silent-turn fallback: when a finalized assistant turn produced
    // NO text and NO tool calls but DID produce reasoning, surface
    // the reasoning so the user isn't staring at an invisible turn.
    // Common with reasoning models (kimi-k2.6 + reasoning_effort) on
    // "the task is already done" conversation shapes — the model
    // thinks for 200+ tokens then emits nothing actionable.
    // `hadToolCalls === false` (explicit, not undefined) means the
    // turn is finalized AND tool-less; while streaming, hadToolCalls
    // is undefined and we don't trigger the fallback to avoid
    // flickering it on for half a token of latency.
    const showReasoningFallback =
      !evt.text && evt.hadToolCalls === false && !!evt.reasoning;
    const shouldShowReasoning = (showReasoning && evt.reasoning) || showReasoningFallback;
    return (
      <Box flexDirection="column" paddingLeft={2}>
        {shouldShowReasoning ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text color={theme.reasoning.color} dimColor={theme.reasoning.dim}>
              {showReasoningFallback ? "thinking… (no response — try /reasoning to expand, or rephrase) " : "thinking… "}
              {evt.reasoning.length > 400 ? evt.reasoning.slice(0, 400) + "…" : evt.reasoning}
            </Text>
          </Box>
        ) : null}
        {evt.text ? <MD text={evt.text} theme={theme} /> : null}
      </Box>
    );
  }
  if (evt.kind === "tool") {
    return <ToolView evt={evt} verbose={verbose} />;
  }
  if (evt.kind === "info") {
    return (
      <Box paddingLeft={2}>
        <Text>
          <Text color={theme.info.color} dimColor={theme.info.dim}>· </Text>
          {evt.text}
        </Text>
      </Box>
    );
  }
  return (
    <Box paddingLeft={2}>
      <Text color={theme.error}>
        ! {evt.text}
      </Text>
    </Box>
  );
});
