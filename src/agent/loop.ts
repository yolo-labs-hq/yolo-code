import { runKimi } from "./client.js";
import { compactMessages } from "./compact.js";
import { toOpenAIToolDefs, type ToolSpec } from "../tools/registry.js";
import type { ToolExecutor, PermissionAsker, ToolResult } from "../tools/executor.js";
import { sanitizeString, stripOldImages } from "./messages.js";
import type { ChatMessage, ToolCall, Usage } from "./messages.js";
import type { Task } from "../tasks-state.js";
import { logTurnDebug, logTurnTokenMetrics, buildTurnTokenMetrics } from "../cost-debug.js";
import { stripHistoricalReasoning } from "./strip-reasoning.js";
import {
  loadSafetyLimits,
  type SafetyLimits,
  type TokenBreakdown,
} from "./token-limits.js";
import { buildContext, mergeTurnIntoHistory } from "./context-builder.js";
import { clearOutputHashCache } from "./tool-output-summarizer.js";
import { isTraceEnabled, redact, traceEvent } from "../trace-log.js";

/** Same-tool loop guard: when an assistant emits N consecutive
 *  iterations where every tool_call shares the same `function.name`,
 *  refuse to execute further and bail out of the turn. Catches
 *  repeated mutating calls without progress. Env override:
 *  YOLO_CODE_LOOP_GUARD_THRESHOLD (default 5). Set to 0 to disable. */
export const DEFAULT_LOOP_GUARD_THRESHOLD = 5;
export function loopGuardThreshold(): number {
  const raw = process.env.YOLO_CODE_LOOP_GUARD_THRESHOLD;
  if (raw === undefined) return DEFAULT_LOOP_GUARD_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LOOP_GUARD_THRESHOLD;
}

/** Mutating-verb set. Tool names whose leading verb segment matches
 *  one of these are guard-eligible. */
const MUTATING_VERBS = new Set([
  "create", "update", "delete", "remove", "set", "add", "insert", "apply",
  "start", "stop", "cancel", "pause", "resume", "complete", "fail",
  "dismiss", "transfer", "publish", "modify", "mutate", "swap", "archive",
  "close", "propose", "claim", "report", "heartbeat", "edit", "write",
  "spawn", "destroy", "kill", "reset", "invalidate", "expire", "revoke",
  "grant", "enable", "disable", "push", "pull", "sync", "migrate",
  "rollback", "merge", "rebase", "fork", "clone", "init", "bootstrap",
  "open", "send", "deploy", "trigger", "rotate", "reload",
]);

/** Read-only-verb set. Tool names whose leading verb segment matches
 *  one of these are exempt from the same-tool loop guard. */
const READ_ONLY_VERBS = new Set([
  "get", "list", "find", "read", "show", "view", "describe", "inspect",
  "check", "watch", "poll", "wait", "grep", "glob", "search", "fetch",
  "expand", "render", "preview", "peek", "browse", "count", "ls", "cat",
  "head", "tail", "stat", "diff",
]);

/** Decide read-only vs mutating by SCANNING SEGMENTS LEFT TO RIGHT.
 *  The first segment that matches either set wins. This handles
 *  shapes like `mcp_yolo_studio_studio_list_tiles` (first verb-shaped
 *  segment is `get` → read-only) and
 *  `mcp_yolo_studio_studio_update_tile_status` (first verb is
 *  `update` → mutating) without the regex-overlap trap codex
 *  flagged in round 2.
 *
 *  Default for tools whose name contains no recognized verb (e.g.
 *  `bash`, `skill`, `expand_artifact`): NOT read-only, so the guard
 *  applies. Conservative — false positives are worse than false
 *  negatives for a loop guard, since the threshold is wide enough
 *  that legitimate non-verb tools won't trip at 5 consecutive calls. */
export function isReadOnlyToolName(name: string): boolean {
  for (const segment of name.split("_")) {
    if (!segment) continue;
    const lower = segment.toLowerCase();
    if (MUTATING_VERBS.has(lower)) return false;
    if (READ_ONLY_VERBS.has(lower)) return true;
  }
  return false;
}

/** Walk back from the end of `messages` counting consecutive
 *  assistant turns whose tool_calls all share `expectedName`. Stops
 *  at any non-assistant message, an assistant with no tool_calls, or
 *  an assistant whose tool_calls contain a different tool name. The
 *  current (just-pushed) assistant message is included in the count. */
export function countConsecutiveSameToolName(
  messages: ChatMessage[],
  expectedName: string,
): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) break;
    if (m.role === "tool") continue;
    if (m.role !== "assistant") break;
    if (!m.tool_calls || m.tool_calls.length === 0) break;
    if (!m.tool_calls.every((tc) => tc.function.name === expectedName)) break;
    count++;
  }
  return count;
}

export interface AgentCallbacks {
  onAssistantStart?: () => void;
  onReasoningDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onToolCallStart?: (index: number, id: string, name: string) => void;
  onToolCallArgs?: (index: number, delta: string) => void;
  onToolCallFinalized?: (call: ToolCall) => void;
  onUsage?: (usage: Usage) => void;
  onAssistantFinal?: (msg: ChatMessage) => void;
  onToolResult?: (result: ToolResult) => void;
  onTasks?: (tasks: Task[]) => void;
  /** Fired when the upstream returned 429 and we are about to wait
   *  before retrying. Lets the UI tell the user we're paused, not failed. */
  onRateLimit?: (delayMs: number, message: string, attempt: number) => void;
  /** Fired when the iteration limit was hit and the loop is about to
   *  auto-compact + retry. Surfaces a "compacting…" status to the user
   *  so a long pause doesn't look like the turn died. */
  onAutoCompact?: (info: { iterations: number }) => void;
  /** Fired when the iteration limit was hit a second time after auto-
   *  compact and the loop is about to hard-stop. Lets the CLI exit
   *  with a distinct status code (3) for scripting / CI use. */
  onIterationLimit?: (info: { iterations: number; pendingCalls: number }) => void;
  /** Fired when the same-tool loop guard trips — the model has called
   *  the same tool name N consecutive times in this turn. Lets the UI
   *  show an explicit "stopped to avoid a loop" line rather than
   *  silently dropping out. */
  onLoopGuardTripped?: (info: {
    toolName: string;
    consecutiveCalls: number;
    iter: number;
  }) => void;
  askPermission: PermissionAsker;
}

export interface AgentTurnOpts {
  accountId: string;
  apiToken: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  executor: ToolExecutor;
  cwd: string;
  signal: AbortSignal;
  callbacks: AgentCallbacks;
  maxToolIterations?: number;
  temperature?: number;
  maxCompletionTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  coauthor?: { name: string; email: string };
  sessionId?: string;
  /** Drop image_url parts from user messages older than this many turns. */
  keepLastImageTurns?: number;
  /** Static system prompt messages (first in context). */
  systemMessages?: ChatMessage[];
  /** Session/project-specific prompt messages (second in context). */
  sessionMessages?: ChatMessage[];
  /** When set, route through yolo-router-cf at `${baseUrl}/v1/chat/completions`
   *  instead of calling Cloudflare Workers AI directly. */
  baseUrl?: string;
}

export async function runAgentTurn(opts: AgentTurnOpts): Promise<void> {
  const limits = loadSafetyLimits();
  const max = opts.maxToolIterations ?? limits.maxToolIterations;
  const toolDefs = toOpenAIToolDefs(opts.tools);

  // Build a name → originalName lookup so the loop guard classifies
  // MCP-wrapped tools by their SEMANTIC name (e.g. "get_run") rather
  // than the server-prefixed wrapper (e.g.
  // "mcp_<user_server_name>_studio_list_tiles") whose first verb-shaped
  // segment may live in the configurable server prefix. Codex round
  // 3 P2 on commit bb997165 — a server named "watch" or "create"
  // would otherwise alias a read-only/mutating verb and either
  // disable the guard or trip it incorrectly.
  const originalToolNameByPrefixed = new Map<string, string>();
  for (const t of opts.tools) {
    if (t.originalName) originalToolNameByPrefixed.set(t.name, t.originalName);
  }
  function classifierName(prefixedName: string): string {
    return originalToolNameByPrefixed.get(prefixedName) ?? prefixedName;
  }
  let turn = 0;
  let lastUsage: Usage | null = null;
  const turnStartedAt = Date.now();

  if (isTraceEnabled()) {
    traceEvent("turn.lifecycle.start", {
      sessionId: opts.sessionId,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      maxToolIterations: max,
      historyLength: opts.messages.length,
      toolCount: opts.tools.length,
      // routerBaseUrl in config isn't URL-validated (the request path
      // tolerates non-absolute values like "localhost:8787"), so eager
      // `new URL(...)` here would crash the whole turn when tracing is
      // on. Fall back to the raw string if parsing fails — the trace is
      // diagnostic, not a control plane.
      baseUrl: safeHostFromUrl(opts.baseUrl),
    });
  }

  // Extract prefix messages if provided, otherwise infer from opts.messages
  const systemMessages = opts.systemMessages ?? extractSystemMessages(opts.messages);
  const sessionMessages = opts.sessionMessages ?? [];

  // Allow one auto-compaction + restart when the iteration loop hits its
  // budget — most "limit hit" cases are genuinely-large work (project
  // scaffolds, multi-file refactors), not runaway loops, and forcing the
  // user to manually /compact + re-prompt is annoying. Capped at 1 per
  // turn so a real runaway loop still terminates cleanly. Disable with
  // YOLO_CODE_AUTO_COMPACT_ON_LIMIT=0.
  let autoCompactsRemaining =
    process.env.YOLO_CODE_AUTO_COMPACT_ON_LIMIT === "0" ? 0 : 1;
  let iter = 0;

  iterLoop: while (true) {
  for (; iter < max; iter++) {
    turn++;
    const previousMessages = opts.messages.slice();
    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    let content = "";
    let reasoning = "";
    const iterStartedAt = Date.now();
    if (isTraceEnabled()) {
      traceEvent("turn.lifecycle.assistant_phase_start", {
        sessionId: opts.sessionId,
        turn,
        iter,
      });
    }
    opts.callbacks.onAssistantStart?.();

    const stripReasoning = process.env.YOLO_CODE_STRIP_REASONING === "1";
    const shadowStrip = process.env.YOLO_CODE_SHADOW_STRIP === "1";
    const keepLastRaw = process.env.YOLO_CODE_REASONING_KEEP_LAST;
    const keepLast = keepLastRaw ? parseInt(keepLastRaw, 10) : 1;

    let apiMessages = opts.messages;
    let shadowStripMetrics:
      | { originalApproxTokens: number; strippedApproxTokens: number; savingsPct: number }
      | undefined;

    if (stripReasoning || shadowStrip) {
      const stripped = stripHistoricalReasoning(opts.messages, {
        keepLast: Number.isNaN(keepLast) ? 1 : keepLast,
      });
      if (shadowStrip) {
        const originalSections = analyzePromptSections(opts.messages);
        const strippedSections = analyzePromptSections(stripped);
        const originalApproxTokens = originalSections.reduce(
          (sum, s) => sum + s.approxTokens,
          0,
        );
        const strippedApproxTokens = strippedSections.reduce(
          (sum, s) => sum + s.approxTokens,
          0,
        );
        shadowStripMetrics = {
          originalApproxTokens,
          strippedApproxTokens,
          savingsPct:
            originalApproxTokens > 0
              ? Math.round(
                  ((originalApproxTokens - strippedApproxTokens) / originalApproxTokens) * 100,
                )
              : 0,
        };
      }
      if (stripReasoning) {
        apiMessages = stripped;
      }
    }

    if (opts.keepLastImageTurns !== undefined) {
      apiMessages = stripOldImages(apiMessages, opts.keepLastImageTurns);
    }

    // Build bounded context instead of sending full history.
    // artifactStore is the executor's shared store — wiring it through
    // lets the tool-output summarizer's dedup hits reference art_N IDs
    // that expand_artifact can resolve (rather than opaque
    // result_id=<hash> refs that have no retrieval path).
    const currentUserMessage = findCurrentUserMessage(apiMessages);
    const context = buildContext({
      allMessages: apiMessages,
      systemMessages,
      sessionMessages,
      toolDefs,
      limits,
      currentUserMessage,
      artifactStore: opts.executor.getArtifactStore(),
    });

    // Log per-turn token metrics
    if (opts.sessionId) {
      void logTurnTokenMetrics(
        buildTurnTokenMetrics(
          opts.sessionId,
          turn,
          context.breakdown,
          opts.maxCompletionTokens ?? limits.maxCompletionTokens,
          context.wasCompacted,
          context.removedCount,
          context.exceedsLimit,
        ),
      );
    }

    if (context.exceedsLimit) {
      // Compact and retry within the remaining recovery budget when skills
      // and tool results exceed the configured context limit.
      if (autoCompactsRemaining > 0) {
        autoCompactsRemaining--;
        if (isTraceEnabled()) {
          traceEvent("turn.lifecycle.auto_compact_attempt", {
            sessionId: opts.sessionId,
            turn,
            iter,
            reason: "context_exceeds_limit",
          });
        }
        opts.callbacks.onAutoCompact?.({ iterations: iter });
        try {
          const result = await compactMessages({
            accountId: opts.accountId,
            apiToken: opts.apiToken,
            model: opts.model,
            messages: opts.messages,
            signal: opts.signal,
            baseUrl: opts.baseUrl,
          });
          opts.messages.length = 0;
          opts.messages.push(...result.newMessages);
          if (isTraceEnabled()) {
            traceEvent("turn.lifecycle.auto_compact_done", {
              sessionId: opts.sessionId,
              turn,
              replacedCount: result.replacedCount,
              newHistoryLength: opts.messages.length,
              reason: "context_exceeds_limit",
            });
          }
          iter = 0;
          continue iterLoop;
        } catch (e) {
          if ((e as Error).name === "AbortError") throw e;
          if (isTraceEnabled()) {
            traceEvent("turn.lifecycle.auto_compact_failed", {
              sessionId: opts.sessionId,
              turn,
              error: (e as Error).message ?? String(e),
              reason: "context_exceeds_limit",
            });
          }
          // Fall through to the user-visible error message below.
        }
      }
      const text = `I cannot continue: the conversation context exceeds the safety limit of ${limits.maxInputTokensPerRequest} tokens. Try running /compact or /clear to reduce context size.`;
      // Stream the text through onTextDelta so the UI's evt.text
      // populates; pushing only into opts.messages + onAssistantFinal
      // leaves the chat event with empty text and the user staring at
      // a blank turn.
      opts.callbacks.onTextDelta?.(text);
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: text,
      };
      opts.messages.push(assistantMsg);
      opts.callbacks.onAssistantFinal?.(assistantMsg);
      return;
    }

    const events = runKimi({
      accountId: opts.accountId,
      apiToken: opts.apiToken,
      model: opts.model,
      messages: context.messages,
      tools: toolDefs,
      signal: opts.signal,
      temperature: opts.temperature,
      maxCompletionTokens: opts.maxCompletionTokens ?? limits.maxCompletionTokens,
      reasoningEffort: opts.reasoningEffort,
      sessionId: opts.sessionId,
      baseUrl: opts.baseUrl,
    });

    for await (const ev of events) {
      switch (ev.type) {
        case "reasoning":
          reasoning += ev.delta;
          opts.callbacks.onReasoningDelta?.(ev.delta);
          break;
        case "text":
          content += ev.delta;
          opts.callbacks.onTextDelta?.(ev.delta);
          break;
        case "tool_call_start":
          opts.callbacks.onToolCallStart?.(ev.index, ev.id, ev.name);
          break;
        case "tool_call_args":
          opts.callbacks.onToolCallArgs?.(ev.index, ev.argsDelta);
          break;
        case "tool_call_complete": {
          const safeArgs = validateToolArguments(ev.arguments);
          const call: ToolCall = {
            id: ev.id,
            type: "function",
            function: { name: ev.name, arguments: safeArgs },
          };
          toolCalls.push(call);
          opts.callbacks.onToolCallFinalized?.(call);
          break;
        }
        case "rate_limited":
          opts.callbacks.onRateLimit?.(ev.delayMs, ev.message, ev.attempt);
          break;
        case "usage":
          lastUsage = ev.usage;
          opts.callbacks.onUsage?.(ev.usage);
          break;
        case "done":
          break;
      }
    }

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: content ? sanitizeString(content) : null,
      ...(reasoning ? { reasoning_content: sanitizeString(reasoning) } : {}),
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((tc) => ({
              ...tc,
              function: {
                name: tc.function.name,
                arguments: sanitizeString(tc.function.arguments),
              },
            })),
          }
        : {}),
    };
    opts.messages.push(assistantMsg);
    opts.callbacks.onAssistantFinal?.(assistantMsg);

    if (isTraceEnabled()) {
      traceEvent("turn.lifecycle.assistant_phase_end", {
        sessionId: opts.sessionId,
        turn,
        iter,
        elapsedMs: Date.now() - iterStartedAt,
        textBytes: content.length,
        reasoningBytes: reasoning.length,
        toolCallCount: toolCalls.length,
        toolNames: toolCalls.map((tc) => tc.function.name),
      });
    }

    if (toolCalls.length === 0) {
      if (opts.sessionId && lastUsage) {
        void logTurnDebug({
          sessionId: opts.sessionId,
          turn,
          messages: opts.messages,
          previousMessages,
          toolResults,
          usage: lastUsage,
          shadowStrip: shadowStripMetrics,
        });
      }
      if (isTraceEnabled()) {
        traceEvent("turn.lifecycle.final", {
          sessionId: opts.sessionId,
          turn,
          iter,
          outcome: "assistant_terminal",
          totalElapsedMs: Date.now() - turnStartedAt,
        });
      }
      return;
    }

    // Loop guard: if every tool call in this iteration targets the
    // same NON-READ-ONLY tool name AND we've now emitted that pattern
    // N consecutive iterations in a row, refuse to execute and bail.
    // Mixed-tool iterations and read-only tools are exempt.
    const guardThreshold = loopGuardThreshold();
    if (
      guardThreshold > 0 &&
      toolCalls.length > 0 &&
      toolCalls.every((tc) => tc.function.name === toolCalls[0]!.function.name) &&
      // Classify by ORIGINAL tool name (MCP) so the server prefix
      // can't shadow the verb — codex round 3 P2.
      !isReadOnlyToolName(classifierName(toolCalls[0]!.function.name))
    ) {
      const guardedName = toolCalls[0]!.function.name;
      const consecutive = countConsecutiveSameToolName(opts.messages, guardedName);
      if (consecutive >= guardThreshold) {
        const guidance = `LOOP_GUARD_TRIPPED: yolo-code refused to execute another \`${guardedName}\` call — that's ${consecutive} consecutive iterations targeting the same tool. The previous calls succeeded; calling again is unlikely to produce a different outcome. To revise an existing entity, use the matching \`update\` / \`mutate\` tool instead. If you are polling for state, that's fine but stop and tell the operator what you observed before continuing. If you cannot make progress, summarize the situation to the operator and ask for guidance.`;
        // Synthesize a tool result for every emitted call so the
        // message tree stays coherent (every tool_call_id must have
        // a matching tool reply, otherwise the next API call rejects)
        // AND fire onToolResult so the UI's running-tool rows
        // transition to a final state instead of staying stuck
        // (codex P2 round 1).
        for (const tc of toolCalls) {
          opts.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: guidance,
            name: tc.function.name,
          });
          const guardResult: ToolResult = {
            tool_call_id: tc.id,
            name: tc.function.name,
            content: guidance,
            ok: false,
            rawBytes: guidance.length,
            reducedBytes: guidance.length,
          };
          toolResults.push(guardResult);
          opts.callbacks.onToolResult?.(guardResult);
        }
        opts.callbacks.onLoopGuardTripped?.({
          toolName: guardedName,
          consecutiveCalls: consecutive,
          iter,
        });
        if (isTraceEnabled()) {
          traceEvent("turn.lifecycle.loop_guard_tripped", {
            sessionId: opts.sessionId,
            turn,
            iter,
            toolName: guardedName,
            consecutiveCalls: consecutive,
            threshold: guardThreshold,
          });
        }
        // Hard-stop the turn: don't let the model retry within this
        // turn. The synthetic tool message is in history so a
        // subsequent user prompt can prod the model to reason about
        // the block.
        if (opts.sessionId && lastUsage) {
          void logTurnDebug({
            sessionId: opts.sessionId,
            turn,
            messages: opts.messages,
            previousMessages,
            toolResults,
            usage: lastUsage,
            shadowStrip: shadowStripMetrics,
          });
        }
        return;
      }
    }

    if (isTraceEnabled()) {
      traceEvent("turn.lifecycle.tool_phase_start", {
        sessionId: opts.sessionId,
        turn,
        iter,
        toolCallCount: toolCalls.length,
      });
    }

    const toolPhaseStartedAt = Date.now();
    for (const tc of toolCalls) {
      if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");
      const result = await opts.executor.run(
        { id: tc.id, name: tc.function.name, arguments: tc.function.arguments },
        opts.callbacks.askPermission,
        { cwd: opts.cwd, signal: opts.signal, onTasks: opts.callbacks.onTasks, coauthor: opts.coauthor },
      );
      toolResults.push(result);
      opts.messages.push({
        role: "tool",
        tool_call_id: result.tool_call_id,
        content: sanitizeString(result.content),
        name: result.name,
      });
      opts.callbacks.onToolResult?.(result);
    }

    if (isTraceEnabled()) {
      let okCount = 0;
      let errCount = 0;
      let totalRaw = 0;
      let totalReduced = 0;
      for (const r of toolResults) {
        if (r.ok) okCount++; else errCount++;
        totalRaw += r.rawBytes ?? 0;
        totalReduced += r.reducedBytes ?? 0;
      }
      traceEvent("turn.lifecycle.tool_phase_end", {
        sessionId: opts.sessionId,
        turn,
        iter,
        elapsedMs: Date.now() - toolPhaseStartedAt,
        okCount,
        errCount,
        totalRawBytes: totalRaw,
        totalReducedBytes: totalReduced,
      });
    }

    if (opts.sessionId && lastUsage) {
      void logTurnDebug({
        sessionId: opts.sessionId,
        turn,
        messages: opts.messages,
        previousMessages,
        toolResults,
        usage: lastUsage,
        shadowStrip: shadowStripMetrics,
      });
    }
  }

  // Inner for-loop exited because we hit `max` iterations. Try one
  // auto-compaction + restart before giving up.
  if (autoCompactsRemaining > 0) {
    autoCompactsRemaining--;
    if (isTraceEnabled()) {
      traceEvent("turn.lifecycle.auto_compact_attempt", {
        sessionId: opts.sessionId,
        turn,
        iter,
        iterations: iter,
      });
    }
    opts.callbacks.onAutoCompact?.({ iterations: iter });
    try {
      const result = await compactMessages({
        accountId: opts.accountId,
        apiToken: opts.apiToken,
        model: opts.model,
        messages: opts.messages,
        signal: opts.signal,
        baseUrl: opts.baseUrl,
      });
      // Mutate opts.messages in place so the for loop's references
      // (and any closures the callbacks captured) see the new state.
      opts.messages.length = 0;
      opts.messages.push(...result.newMessages);
      if (isTraceEnabled()) {
        traceEvent("turn.lifecycle.auto_compact_done", {
          sessionId: opts.sessionId,
          turn,
          replacedCount: result.replacedCount,
          newHistoryLength: opts.messages.length,
        });
      }
      iter = 0;
      continue iterLoop;
    } catch (e) {
      // Abort propagates; any other compaction error falls through to
      // the hard-stop message so the user knows what happened.
      if ((e as Error).name === "AbortError") throw e;
      if (isTraceEnabled()) {
        traceEvent("turn.lifecycle.auto_compact_failed", {
          sessionId: opts.sessionId,
          turn,
          error: (e as Error).message ?? String(e),
        });
      }
    }
  }
  break iterLoop;
  }

  // Graceful stop when limit is hit (and auto-compact already used).
  const remaining = toolCallsFromMessages(opts.messages);
  if (isTraceEnabled()) {
    traceEvent("turn.lifecycle.iteration_limit", {
      sessionId: opts.sessionId,
      turn,
      iter,
      max,
      pendingCalls: remaining,
    });
  }
  opts.callbacks.onIterationLimit?.({ iterations: iter, pendingCalls: remaining });
  const iterText = `I reached the tool iteration limit (${max}) again after auto-compacting context. There ${remaining === 1 ? "is" : "are"} ${remaining} pending tool call${remaining === 1 ? "" : "s"} that could not be executed. Run /compact or /clear to reset context, or rephrase your request to a smaller scope.`;
  // Stream via onTextDelta — same fix as the context-exceeded path
  // above. Without this the UI would render an empty turn even though
  // the message is correctly added to history.
  opts.callbacks.onTextDelta?.(iterText);
  const assistantMsg: ChatMessage = {
    role: "assistant",
    content: iterText,
  };
  opts.messages.push(assistantMsg);
  opts.callbacks.onAssistantFinal?.(assistantMsg);
  if (isTraceEnabled()) {
    traceEvent("turn.lifecycle.final", {
      sessionId: opts.sessionId,
      turn,
      iter,
      outcome: "iteration_limit",
      totalElapsedMs: Date.now() - turnStartedAt,
    });
  }
}

// Best-effort URL host extraction for trace events. Returns the host
// when input parses as a valid absolute URL with a populated host;
// otherwise returns the (truncated) raw string. `new URL("localhost:8787")`
// surprisingly does NOT throw — it parses `localhost:` as a custom
// scheme and returns an empty host, which would silently blank out
// the trace field for the exact local-router config we want to
// diagnose. Guarding on `url.host` truthiness catches that case.
// Diagnostic — never throws.
function safeHostFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.host) return url.host;
  } catch {
    /* fall through */
  }
  // Fall-through path: the raw string was not a parseable URL with a
  // host (e.g. "localhost:8787"). Run regex redaction so embedded
  // credentials like "user:pass@host" or "host?api_key=…" don't land
  // in the trace verbatim. The redaction is best-effort but covers the
  // known URL-credential shapes (UrlPassword + QueryParam patterns).
  const redacted = redact(value);
  return redacted.length > 80 ? redacted.slice(0, 80) + "…" : redacted;
}

function extractSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const end = messages.findIndex((m) => m.role !== "system");
  return end === -1 ? messages.slice() : messages.slice(0, end);
}

function findCurrentUserMessage(messages: ChatMessage[]): ChatMessage | null {
  // Find the last user message that is not part of the prefix
  const prefixEnd = messages.findIndex((m) => m.role !== "system");
  const history = prefixEnd === -1 ? [] : messages.slice(prefixEnd);
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "user") {
      return history[i]!;
    }
  }
  return null;
}

function toolCallsFromMessages(messages: ChatMessage[]): number {
  let count = 0;
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      count += m.tool_calls.length;
    }
  }
  return count;
}

function validateToolArguments(raw: string): string {
  if (!raw || !raw.trim()) return "{}";
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return "{}";
  }
}

// Re-export for compatibility
function analyzePromptSections(messages: ChatMessage[]): { role: string; chars: number; approxTokens: number }[] {
  return messages.map((m) => {
    let chars = 0;
    if (typeof m.content === "string") {
      chars = m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "text") chars += p.text.length;
      }
    }
    if (m.reasoning_content) chars += m.reasoning_content.length;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += tc.function.name.length + tc.function.arguments.length;
      }
    }
    return { role: m.role, chars, approxTokens: Math.ceil(chars / 4) };
  });
}
