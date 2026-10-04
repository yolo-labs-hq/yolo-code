import React, { useState, useEffect, useRef } from "react";
import { Text, useInput } from "ink";
import chalk from "chalk";
import { logTrace } from "../trace-log.js";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string, display?: string) => void;
  onHistoryUp?: () => void;
  onHistoryDown?: () => void;
  onClearQueueItem?: (text: string) => void;
  focus?: boolean;
  mask?: string;
  enablePaste?: boolean;
  traceEnabled?: boolean;
  traceSessionId?: string;
}

const PASTE_CHAR_THRESHOLD = 200;
const PASTE_NEWLINE_THRESHOLD = 1;
const PASTE_AUTOSUBMIT_MS = 250;

export function shouldTreatAsPaste(input: string): boolean {
  if (input.length >= PASTE_CHAR_THRESHOLD) return true;
  const newlines = (input.match(/\n/g) ?? []).length;
  return newlines >= PASTE_NEWLINE_THRESHOLD;
}

function newPasteId(): string {
  return Math.random().toString(36).slice(2, 7);
}

function countLines(s: string): number {
  return s.split("\n").length;
}

function findWordBoundaryForward(text: string, pos: number): number {
  while (pos < text.length && /\w/.test(text[pos]!)) pos++;
  while (pos < text.length && !/\w/.test(text[pos]!)) pos++;
  return pos;
}

function findWordBoundaryBackward(text: string, pos: number): number {
  while (pos > 0 && !/\w/.test(text[pos - 1]!)) pos--;
  while (pos > 0 && /\w/.test(text[pos - 1]!)) pos--;
  return pos;
}

export function CustomTextInput({
  value,
  onChange,
  onSubmit,
  onHistoryUp,
  onHistoryDown,
  onClearQueueItem,
  focus = true,
  mask,
  enablePaste = false,
  traceEnabled = false,
  traceSessionId,
}: Props) {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const pastesRef = useRef<Map<string, string>>(new Map());
  const autoSubmitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hadAutoSubmitTimerRef = useRef(false);
  const lastPasteWasManualEnterRef = useRef(false);

  function clearAutoSubmitTimer(reason?: string) {
    if (autoSubmitTimerRef.current) {
      clearTimeout(autoSubmitTimerRef.current);
      autoSubmitTimerRef.current = null;
      if (traceEnabled && reason) {
        void logTrace({
          event: "input.paste_autosubmit_reset",
          sessionId: traceSessionId,
          reason,
          placeholderCount: pastesRef.current.size,
        });
      }
    }
  }

  function submitResolved(displayValue: string, source: "enter" | "paste-autosubmit" | "newline-paste") {
    const { full, hasPastes } = resolvePastePlaceholders(displayValue, pastesRef.current);
    const requiredManualEnter =
      source === "enter" && hasPastes && !hadAutoSubmitTimerRef.current;
    if (traceEnabled) {
      void logTrace({
        event: "input.submit",
        sessionId: traceSessionId,
        source,
        hasPastes,
        placeholderCount: pastesRef.current.size,
        requiredManualEnter,
        displayPreview: displayValue.slice(0, 200),
        fullPreview: full.slice(0, 200),
        fullLength: full.length,
        displayLength: displayValue.length,
      });
    }
    onSubmit(full, hasPastes ? displayValue : undefined);
    pastesRef.current.clear();
    clearAutoSubmitTimer();
    hadAutoSubmitTimerRef.current = false;
    lastPasteWasManualEnterRef.current = false;
    setCursorOffset(0);
  }

  function scheduleAutoSubmit(displayValue: string) {
    clearAutoSubmitTimer();
    hadAutoSubmitTimerRef.current = true;
    if (traceEnabled) {
      void logTrace({
        event: "input.paste_autosubmit_scheduled",
        sessionId: traceSessionId,
        displayPreview: displayValue.slice(0, 200),
        placeholderCount: pastesRef.current.size,
        delayMs: PASTE_AUTOSUBMIT_MS,
      });
    }
    autoSubmitTimerRef.current = setTimeout(() => {
      autoSubmitTimerRef.current = null;
      if (traceEnabled) {
        void logTrace({
          event: "input.paste_autosubmit_fired",
          sessionId: traceSessionId,
          displayPreview: displayValue.slice(0, 200),
          placeholderCount: pastesRef.current.size,
        });
      }
      submitResolved(displayValue, "paste-autosubmit");
    }, PASTE_AUTOSUBMIT_MS);
  }

  useEffect(() => {
    if (!focus) return;
    setCursorOffset((prev) => (prev > value.length ? value.length : prev));
  }, [value, focus]);

  useEffect(() => () => clearAutoSubmitTimer(), []);

  useInput(
    (input, key) => {
      if (!focus) return;

      if (key.ctrl && input === "c") return;
      if (key.ctrl && input === "r") return;
      if (key.ctrl && input === "o") return;
      if (key.tab) return;

      if (key.return) {
        if (autoSubmitTimerRef.current && traceEnabled) {
          void logTrace({
            event: "input.paste_autosubmit_preempted_by_enter",
            sessionId: traceSessionId,
            placeholderCount: pastesRef.current.size,
          });
        }
        submitResolved(value, "enter");
        return;
      }

      if (key.upArrow) {
        clearAutoSubmitTimer("history-up");
        onHistoryUp?.();
        return;
      }

      if (key.downArrow) {
        clearAutoSubmitTimer("history-down");
        onHistoryDown?.();
        return;
      }

      let nextCursor = cursorOffset;
      let nextValue = value;
      let didDelete = false;

      if (key.leftArrow) {
        clearAutoSubmitTimer();
        if (key.meta) {
          nextCursor = findWordBoundaryBackward(value, cursorOffset);
        } else {
          nextCursor = cursorOffset - 1;
        }
      } else if (key.rightArrow) {
        clearAutoSubmitTimer();
        if (key.meta) {
          nextCursor = findWordBoundaryForward(value, cursorOffset);
        } else {
          nextCursor = cursorOffset + 1;
        }
      } else if (key.meta && input === "b") {
        clearAutoSubmitTimer();
        nextCursor = findWordBoundaryBackward(value, cursorOffset);
      } else if (key.meta && input === "f") {
        clearAutoSubmitTimer();
        nextCursor = findWordBoundaryForward(value, cursorOffset);
      } else if (key.meta && input === "d") {
        clearAutoSubmitTimer();
        didDelete = true;
        const boundary = findWordBoundaryForward(value, cursorOffset);
        nextValue = value.slice(0, cursorOffset) + value.slice(boundary);
      } else if (key.home || (key.ctrl && input === "a")) {
        clearAutoSubmitTimer();
        nextCursor = 0;
      } else if (key.end || (key.ctrl && input === "e")) {
        clearAutoSubmitTimer();
        nextCursor = value.length;
      } else if (key.backspace) {
        clearAutoSubmitTimer();
        didDelete = true;
        const tokenBoundary = enablePaste
          ? findPasteTokenEndingAt(value, cursorOffset, pastesRef.current)
          : -1;
        if (tokenBoundary >= 0) {
          const token = value.slice(tokenBoundary, cursorOffset);
          pastesRef.current.delete(token);
          nextValue = value.slice(0, tokenBoundary) + value.slice(cursorOffset);
          nextCursor = tokenBoundary;
        } else if (key.meta || (key.ctrl && input === "w")) {
          const boundary = findWordBoundaryBackward(value, cursorOffset);
          nextValue = value.slice(0, boundary) + value.slice(cursorOffset);
          nextCursor = boundary;
        } else if (key.ctrl) {
          const boundary = findWordBoundaryBackward(value, cursorOffset);
          nextValue = value.slice(0, boundary) + value.slice(cursorOffset);
          nextCursor = boundary;
        } else {
          if (cursorOffset > 0) {
            nextValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
            nextCursor = cursorOffset - 1;
          }
        }
      } else if (key.delete) {
        clearAutoSubmitTimer();
        didDelete = true;
        if (key.meta || key.ctrl) {
          const boundary = findWordBoundaryForward(value, cursorOffset);
          nextValue = value.slice(0, cursorOffset) + value.slice(boundary);
        } else {
          nextValue = value.slice(0, cursorOffset) + value.slice(cursorOffset + 1);
        }
      } else if (key.ctrl && input === "w") {
        clearAutoSubmitTimer();
        didDelete = true;
        const boundary = findWordBoundaryBackward(value, cursorOffset);
        nextValue = value.slice(0, boundary) + value.slice(cursorOffset);
        nextCursor = boundary;
      } else if (key.ctrl && input === "u") {
        clearAutoSubmitTimer();
        didDelete = true;
        nextValue = value.slice(cursorOffset);
        nextCursor = 0;
      } else if (key.ctrl && input === "k") {
        clearAutoSubmitTimer();
        didDelete = true;
        nextValue = value.slice(0, cursorOffset);
      } else if (input.length > 0 && !key.ctrl && !key.meta) {
        clearAutoSubmitTimer("user-typed");
        let toInsert = input;
        let submitAfterInsert = false;
        // Bulk chunks that end with CR/LF mean the sender appended Enter
        // to submit — e.g. the YOLO Studio TileInput shortcut bar pastes
        // "Commit all changes...\r" through ttyd, and Ink delivers the
        // whole chunk as a single useInput call with key.return = false.
        // Without this branch the string lands in the input field but
        // the turn never runs, which is exactly the "text appears but
        // doesn't submit" symptom users hit on the Commit & Push button.
        if (/[\r\n]$/.test(toInsert)) {
          submitAfterInsert = true;
          toInsert = toInsert.replace(/[\r\n]+$/, "");
        }
        // Strip the trailing newline BEFORE running the paste heuristic
        // so single-line shortcut prompts (e.g. "Commit all changes...\r")
        // don't get mis-classified as multi-line pastes and replaced
        // with a `[pasted 1 line #…]` placeholder in history/queue.
        const looksLikePaste = enablePaste && shouldTreatAsPaste(toInsert);
        let placeholderInserted: { placeholder: string; lines: number; bytes: number } | null = null;
        if (looksLikePaste && toInsert.length > 0) {
          const lines = countLines(toInsert);
          const id = newPasteId();
          const placeholder = `[pasted ${lines} line${lines === 1 ? "" : "s"} #${id}]`;
          pastesRef.current.set(placeholder, toInsert);
          placeholderInserted = { placeholder, lines, bytes: toInsert.length };
          toInsert = placeholder;
        }
        nextValue = value.slice(0, cursorOffset) + toInsert + value.slice(cursorOffset);
        nextCursor = cursorOffset + toInsert.length;
        if (placeholderInserted && traceEnabled) {
          void logTrace({
            event: "input.placeholder_insert",
            sessionId: traceSessionId,
            placeholder: placeholderInserted.placeholder,
            lines: placeholderInserted.lines,
            bytes: placeholderInserted.bytes,
            placeholderCount: pastesRef.current.size,
            submitAfterInsert,
          });
        }
        if (submitAfterInsert) {
          // Flush the value through onChange first so any controlled-
          // input parent sees the final state, then fire onSubmit.
          if (nextValue !== value) onChange(nextValue);
          submitResolved(nextValue, "newline-paste");
          return;
        }
        if (enablePaste && isOnlyPastePlaceholders(nextValue, pastesRef.current)) {
          scheduleAutoSubmit(nextValue);
        }
      }

      if (nextCursor < 0) nextCursor = 0;
      if (nextCursor > nextValue.length) nextCursor = nextValue.length;

      if (didDelete && nextValue === "" && value !== "") {
        onClearQueueItem?.(value);
      }

      if (nextCursor !== cursorOffset) {
        setCursorOffset(nextCursor);
      }
      if (nextValue !== value) {
        onChange(nextValue);
      }
    },
    { isActive: focus },
  );

  const displayValue = mask ? mask.repeat(value.length) : value;

  let renderedValue = "";
  let i = 0;
  for (const char of displayValue) {
    renderedValue += i === cursorOffset ? chalk.inverse(char) : char;
    i++;
  }
  if (displayValue.length === 0) {
    renderedValue = chalk.inverse(" ");
  } else if (cursorOffset === displayValue.length) {
    renderedValue += chalk.inverse(" ");
  }

  return <Text>{renderedValue}</Text>;
}

export function resolvePastePlaceholders(
  value: string,
  pastes: Map<string, string>,
): { full: string; hasPastes: boolean } {
  let full = value;
  let hasPastes = false;
  for (const [placeholder, fullText] of pastes) {
    if (full.includes(placeholder)) {
      full = full.split(placeholder).join(fullText);
      hasPastes = true;
    }
  }
  return { full, hasPastes };
}

export function isOnlyPastePlaceholders(value: string, pastes: Map<string, string>): boolean {
  if (pastes.size === 0) return false;
  let rest = value;
  for (const placeholder of pastes.keys()) {
    rest = rest.split(placeholder).join("");
  }
  return rest.trim().length === 0;
}

function findPasteTokenEndingAt(
  value: string,
  pos: number,
  pastes: Map<string, string>,
): number {
  if (pos <= 0 || value[pos - 1] !== "]") return -1;
  for (const placeholder of pastes.keys()) {
    if (placeholder.length > pos) continue;
    const start = pos - placeholder.length;
    if (value.slice(start, pos) === placeholder) return start;
  }
  return -1;
}
