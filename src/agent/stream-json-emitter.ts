/**
 * Stream-JSON envelope emitter for `yolo-code --output-format stream-json`.
 *
 * Mirrors Claude Code's stream-json shape close enough that the existing
 * lane-line formatter (`webapp/components/grid/laneLineFormatter.ts`) can
 * ingest both agents through the same parser — no webapp-side branching.
 *
 * Envelopes (one per NDJSON line on stdout):
 *
 *   {"type":"system","subtype":"init","model":"...","tools":[...],"cwd":"...","session_id":"..."}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."},{"type":"tool_use","id":"...","name":"...","input":{...}}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...","content":"...","is_error":false}]}}
 *   {"type":"result","subtype":"success|error_*","is_error":false,"duration_ms":...,"num_turns":...,"session_id":"...","model":"...","result":"...","usage":{...}}
 *
 * Buffering rules:
 *   - Text deltas + tool_use blocks accumulate into a per-turn `assistant`
 *     envelope. The envelope is flushed on the next `recordToolResult` call
 *     (which signals that the turn that produced the tool call is over) and
 *     unconditionally at `finish()`.
 *   - `recordToolResult` flushes the pending assistant turn first, then
 *     emits the user/tool_result envelope. This preserves Claude's ordering
 *     (assistant turn → user turn → next assistant turn).
 *
 * Why a stateful object instead of a free function per event:
 *   The assistant envelope spans multiple model callbacks (`onTextDelta`,
 *   `onToolCallFinalized`) and only completes when the turn ends. The
 *   emitter holds that in-flight state, so the call-site stays clean.
 */

export type Writer = (line: string) => void;

export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface StreamJsonInit {
  model: string;
  tools: ReadonlyArray<{ name: string }>;
  cwd: string;
  sessionId: string;
  permissionMode: "default" | "bypassPermissions";
}

export type StreamJsonResultSubtype =
  | "success"
  | "error_max_turns"
  | "error_aborted"
  | "error_permission_denied"
  | "error_loop_guard"
  | "error";

export interface StreamJsonFinish {
  subtype: StreamJsonResultSubtype;
  isError: boolean;
  durationMs: number;
  numTurns: number;
  result: string;
  usage: unknown;
}

export class StreamJsonEmitter {
  private pendingText = "";
  private pendingBlocks: AssistantBlock[] = [];

  constructor(
    private readonly write: Writer,
    private readonly init: StreamJsonInit,
  ) {}

  /** Emit the session init envelope. Call once at startup. */
  start(): void {
    this.write(
      JSON.stringify({
        type: "system",
        subtype: "init",
        cwd: this.init.cwd,
        session_id: this.init.sessionId,
        model: this.init.model,
        tools: this.init.tools.map((t) => ({ name: t.name })),
        permissionMode: this.init.permissionMode,
      }),
    );
  }

  /** Accumulate an assistant text delta into the current turn's pending text. */
  recordTextDelta(delta: string): void {
    this.pendingText += delta;
  }

  /** Append a tool_use block to the current turn. Drains any pending text into
   *  a text block first so the order of blocks within the assistant envelope
   *  matches the order the model emitted them. */
  recordToolUse(call: { id: string; name: string; argumentsJson: string }): void {
    this.drainPendingText();
    let input: unknown;
    try {
      input = JSON.parse(call.argumentsJson);
    } catch {
      // Malformed tool args — keep the raw string so downstream consumers
      // can still see what the model emitted.
      input = call.argumentsJson;
    }
    this.pendingBlocks.push({ type: "tool_use", id: call.id, name: call.name, input });
  }

  /** Flush the pending assistant turn (if any), then emit a user/tool_result
   *  envelope. Called when a tool result comes back from the executor. */
  recordToolResult(result: { toolUseId: string; content: string; isError: boolean }): void {
    this.flushPendingAssistant();
    this.write(
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: result.toolUseId,
              content: result.content,
              is_error: result.isError,
            },
          ],
        },
      }),
    );
  }

  /** Flush any remaining assistant turn (e.g. a final text-only answer with no
   *  tool calls) and emit the run-final `result` envelope. Call once at end. */
  finish(final: StreamJsonFinish): void {
    this.flushPendingAssistant();
    this.write(
      JSON.stringify({
        type: "result",
        subtype: final.subtype,
        is_error: final.isError,
        duration_ms: final.durationMs,
        num_turns: final.numTurns,
        session_id: this.init.sessionId,
        model: this.init.model,
        result: final.result,
        usage: final.usage,
      }),
    );
  }

  private drainPendingText(): void {
    if (this.pendingText.length === 0) return;
    this.pendingBlocks.push({ type: "text", text: this.pendingText });
    this.pendingText = "";
  }

  private flushPendingAssistant(): void {
    this.drainPendingText();
    if (this.pendingBlocks.length === 0) return;
    this.write(
      JSON.stringify({
        type: "assistant",
        message: { content: this.pendingBlocks },
      }),
    );
    this.pendingBlocks = [];
  }
}
