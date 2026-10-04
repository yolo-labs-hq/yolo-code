/**
 * StreamJsonEmitter — envelope shape + buffering tests.
 *
 * The webapp's lane-line formatter
 * (`webapp/components/grid/laneLineFormatter.ts`) consumes these envelopes
 * through the same parser it uses for claude. The shape contract these
 * tests pin is what makes that work.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { StreamJsonEmitter, type StreamJsonInit } from "./stream-json-emitter.js";

function makeEmitter(initOverrides: Partial<StreamJsonInit> = {}) {
  const lines: string[] = [];
  const emitter = new StreamJsonEmitter((line) => lines.push(line), {
    model: "@cf/test/model",
    tools: [{ name: "tool_a" }, { name: "tool_b" }],
    cwd: "/home/yolo/lanes/lane-x",
    sessionId: "sess-test",
    permissionMode: "bypassPermissions",
    ...initOverrides,
  });
  return { emitter, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
}

describe("StreamJsonEmitter.start", () => {
  it("emits a system/init envelope with cwd, session_id, model, and tools", () => {
    const { emitter, parsed } = makeEmitter();
    emitter.start();
    const events = parsed();
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(events[0], {
      type: "system",
      subtype: "init",
      cwd: "/home/yolo/lanes/lane-x",
      session_id: "sess-test",
      model: "@cf/test/model",
      tools: [{ name: "tool_a" }, { name: "tool_b" }],
      permissionMode: "bypassPermissions",
    });
  });
});

describe("StreamJsonEmitter — assistant turn buffering", () => {
  it("buffers text deltas + tool_use blocks into a single assistant envelope, flushed on tool_result", () => {
    const { emitter, parsed } = makeEmitter();
    // Don't include start() here — focus on the turn-level shape.
    emitter.recordTextDelta("I'll run the ");
    emitter.recordTextDelta("first tool.");
    emitter.recordToolUse({
      id: "call_1",
      name: "tasks_set",
      argumentsJson: '{"tasks":[{"id":"1","title":"X","status":"pending"}]}',
    });
    // Tool result triggers a flush of the assistant turn, then the user
    // envelope. Two events in order.
    emitter.recordToolResult({
      toolUseId: "call_1",
      content: "1 task set",
      isError: false,
    });

    const events = parsed();
    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(events[0], {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I'll run the first tool." },
          {
            type: "tool_use",
            id: "call_1",
            name: "tasks_set",
            input: { tasks: [{ id: "1", title: "X", status: "pending" }] },
          },
        ],
      },
    });
    assert.deepStrictEqual(events[1], {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "1 task set",
            is_error: false,
          },
        ],
      },
    });
  });

  it("preserves text/tool_use ordering when text appears between tool_use blocks", () => {
    const { emitter, parsed } = makeEmitter();
    emitter.recordTextDelta("step one ");
    emitter.recordToolUse({ id: "c1", name: "t1", argumentsJson: "{}" });
    emitter.recordTextDelta("step two ");
    emitter.recordToolUse({ id: "c2", name: "t2", argumentsJson: "{}" });
    emitter.recordToolResult({ toolUseId: "c1", content: "ok", isError: false });

    const events = parsed();
    assert.deepStrictEqual(events[0].message.content, [
      { type: "text", text: "step one " },
      { type: "tool_use", id: "c1", name: "t1", input: {} },
      { type: "text", text: "step two " },
      { type: "tool_use", id: "c2", name: "t2", input: {} },
    ]);
  });

  it("keeps malformed tool arguments as a raw string when JSON.parse fails", () => {
    const { emitter, parsed } = makeEmitter();
    emitter.recordToolUse({ id: "c1", name: "t1", argumentsJson: "not-json {" });
    emitter.recordToolResult({ toolUseId: "c1", content: "ok", isError: false });
    const events = parsed();
    assert.deepStrictEqual(events[0].message.content[0], {
      type: "tool_use",
      id: "c1",
      name: "t1",
      input: "not-json {",
    });
  });

  it("marks is_error: true on a failed tool result", () => {
    const { emitter, parsed } = makeEmitter();
    emitter.recordToolUse({ id: "c1", name: "t1", argumentsJson: "{}" });
    emitter.recordToolResult({ toolUseId: "c1", content: "boom", isError: true });
    const events = parsed();
    assert.strictEqual(events[1].message.content[0].is_error, true);
  });

  it("does not emit an assistant envelope when there is no buffered content", () => {
    const { emitter, parsed } = makeEmitter();
    // Only a tool_result with no preceding text/tool_use shouldn't synthesize
    // an empty assistant envelope.
    emitter.recordToolResult({ toolUseId: "c0", content: "ok", isError: false });
    const events = parsed();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, "user");
  });
});

describe("StreamJsonEmitter.finish", () => {
  it("flushes a trailing text-only assistant turn and emits the run-final result envelope", () => {
    const { emitter, parsed } = makeEmitter();
    emitter.recordTextDelta("Final answer ");
    emitter.recordTextDelta("from the model.");
    emitter.finish({
      subtype: "success",
      isError: false,
      durationMs: 12_345,
      numTurns: 3,
      result: "Final answer from the model.",
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const events = parsed();
    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(events[0], {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Final answer from the model." }],
      },
    });
    assert.deepStrictEqual(events[1], {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 12_345,
      num_turns: 3,
      session_id: "sess-test",
      model: "@cf/test/model",
      result: "Final answer from the model.",
      usage: { input_tokens: 100, output_tokens: 50 },
    });
  });

  it("emits only the result envelope when nothing was buffered", () => {
    const { emitter, parsed } = makeEmitter();
    emitter.finish({
      subtype: "error_aborted",
      isError: true,
      durationMs: 0,
      numTurns: 0,
      result: "aborted",
      usage: null,
    });
    const events = parsed();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, "result");
    assert.strictEqual(events[0].subtype, "error_aborted");
    assert.strictEqual(events[0].is_error, true);
  });
});

describe("StreamJsonEmitter — full-run shape", () => {
  it("produces an init → assistant → user → assistant → result sequence the lane formatter recognizes", () => {
    const { emitter, parsed } = makeEmitter();
    emitter.start();
    emitter.recordTextDelta("Setting up tasks.");
    emitter.recordToolUse({
      id: "c1",
      name: "tasks_set",
      argumentsJson: '{"tasks":[{"id":"1","title":"do thing","status":"pending"}]}',
    });
    emitter.recordToolResult({ toolUseId: "c1", content: "1 task set", isError: false });
    emitter.recordTextDelta("Done.");
    emitter.finish({
      subtype: "success",
      isError: false,
      durationMs: 1000,
      numTurns: 2,
      result: "Setting up tasks.Done.",
      usage: null,
    });

    const events = parsed();
    assert.deepStrictEqual(
      events.map((e) => e.type),
      ["system", "assistant", "user", "assistant", "result"],
    );
    assert.strictEqual(events[0].subtype, "init");
    assert.strictEqual(events[1].message.content[0].type, "text");
    assert.strictEqual(events[1].message.content[1].type, "tool_use");
    assert.strictEqual(events[2].message.content[0].type, "tool_result");
    assert.deepStrictEqual(events[3].message.content[0], { type: "text", text: "Done." });
    assert.strictEqual(events[4].subtype, "success");
  });
});

describe("StreamJsonEmitter — every line is single-NDJSON", () => {
  it("never embeds a newline inside an envelope", () => {
    const { emitter, lines } = makeEmitter();
    emitter.start();
    emitter.recordTextDelta("line one\nline two\nline three");
    emitter.recordToolUse({
      id: "c1",
      name: "t1",
      argumentsJson: '{"value":"multi\\nline"}',
    });
    emitter.recordToolResult({
      toolUseId: "c1",
      content: "result\nwith\nnewlines",
      isError: false,
    });
    emitter.finish({
      subtype: "success",
      isError: false,
      durationMs: 0,
      numTurns: 1,
      result: "",
      usage: null,
    });
    // Every emitted line is a complete JSON envelope with no embedded
    // newlines — the lane-runner ingests one line at a time. JSON.stringify
    // escapes \n inside strings, so even multi-line tool args / results
    // serialize to a single line each.
    for (const line of lines) {
      assert.strictEqual(line.includes("\n"), false);
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });
});
