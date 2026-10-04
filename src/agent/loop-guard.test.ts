// Same-tool repetition and read-only classification coverage.

import { describe, it } from "node:test";
import assert from "node:assert";
import { countConsecutiveSameToolName, isReadOnlyToolName } from "./loop.js";
import type { ChatMessage } from "./messages.js";

function assistantWithCall(name: string, args = "{}", id = `tc_${Math.random()}`): ChatMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      { id, type: "function", function: { name, arguments: args } },
    ],
  };
}

function toolReply(id: string, name: string, content = ""): ChatMessage {
  return { role: "tool", tool_call_id: id, name, content };
}

describe("countConsecutiveSameToolName", () => {
  it("counts a single trailing assistant call", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      assistantWithCall("studio.create_note"),
    ];
    assert.strictEqual(countConsecutiveSameToolName(msgs, "studio.create_note"), 1);
  });

  it("counts consecutive same-name calls across tool replies", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      assistantWithCall("studio.create_note", "{}", "tc1"),
      toolReply("tc1", "studio.create_note", "{}"),
      assistantWithCall("studio.create_note", "{}", "tc2"),
      toolReply("tc2", "studio.create_note", "{}"),
      assistantWithCall("studio.create_note", "{}", "tc3"),
    ];
    assert.strictEqual(countConsecutiveSameToolName(msgs, "studio.create_note"), 3);
  });

  it("counts even when arguments differ — the user's actual bug", () => {
    // Different arguments still count toward repetition of the same tool.
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      assistantWithCall("studio.create_note", `{"name":"a"}`, "tc1"),
      toolReply("tc1", "studio.create_note", "{}"),
      assistantWithCall("studio.create_note", `{"name":"b"}`, "tc2"),
      toolReply("tc2", "studio.create_note", "{}"),
      assistantWithCall("studio.create_note", `{"name":"c"}`, "tc3"),
    ];
    assert.strictEqual(countConsecutiveSameToolName(msgs, "studio.create_note"), 3);
  });

  it("breaks chain on assistant with no tool_calls (plain text reply)", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      assistantWithCall("studio.create_note", "{}", "tc1"),
      toolReply("tc1", "studio.create_note", "{}"),
      { role: "assistant", content: "ok, let me think" },
      assistantWithCall("studio.create_note", "{}", "tc2"),
    ];
    // Chain interrupted by the text-only assistant turn.
    assert.strictEqual(countConsecutiveSameToolName(msgs, "studio.create_note"), 1);
  });

  it("breaks chain on assistant with different tool name", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      assistantWithCall("studio.create_note", "{}", "tc1"),
      toolReply("tc1", "studio.create_note", "{}"),
      assistantWithCall("studio.list_tiles", "{}", "tc2"),
      toolReply("tc2", "studio.list_tiles", "{}"),
      assistantWithCall("studio.create_note", "{}", "tc3"),
    ];
    assert.strictEqual(countConsecutiveSameToolName(msgs, "studio.create_note"), 1);
  });

  it("breaks chain when an assistant emits multiple tool_calls with mixed names", () => {
    // Multi-tool iterations are NOT a loop signal. The guard should
    // treat the mixed-name assistant message as a chain break.
    const mixed: ChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "tc_mixed_a", type: "function", function: { name: "studio.create_note", arguments: "{}" } },
        { id: "tc_mixed_b", type: "function", function: { name: "studio.list_tiles", arguments: "{}" } },
      ],
    };
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      assistantWithCall("studio.create_note", "{}", "tc1"),
      toolReply("tc1", "studio.create_note", "{}"),
      mixed,
    ];
    assert.strictEqual(countConsecutiveSameToolName(msgs, "studio.create_note"), 0);
  });

  it("returns 0 for an empty history", () => {
    assert.strictEqual(countConsecutiveSameToolName([], "studio.create_note"), 0);
  });

  it("isReadOnlyToolName classifies polling tools as read-only", () => {
    // Bare yolo-code built-in tools.
    assert.strictEqual(isReadOnlyToolName("read"), true);
    assert.strictEqual(isReadOnlyToolName("grep"), true);
    assert.strictEqual(isReadOnlyToolName("glob"), true);
    assert.strictEqual(isReadOnlyToolName("web_fetch"), true);
    assert.strictEqual(isReadOnlyToolName("web_search"), true);
    // MCP-prefixed workspace tools.
    assert.strictEqual(isReadOnlyToolName("mcp_yolo_studio_studio_list_tiles"), true);
    assert.strictEqual(
      isReadOnlyToolName("mcp_yolo_studio_studio_get_workspace_context"),
      true,
    );
    assert.strictEqual(
      isReadOnlyToolName("mcp_yolo_studio_studio_wait_for_artifact"),
      true,
    );
  });

  it("isReadOnlyToolName classifies mutating tools as NOT read-only", () => {
    // These are the tools we DO want the guard to fire on.
    assert.strictEqual(isReadOnlyToolName("mcp_yolo_studio_studio_create_desktop"), false);
    assert.strictEqual(isReadOnlyToolName("mcp_yolo_studio_studio_publish_artifact"), false);
    assert.strictEqual(isReadOnlyToolName("mcp_yolo_studio_studio_close_work_stream"), false);
    // Built-in mutating tools.
    assert.strictEqual(isReadOnlyToolName("write"), false);
    assert.strictEqual(isReadOnlyToolName("edit"), false);
    assert.strictEqual(isReadOnlyToolName("bash"), false);
  });

  it("classifier handles MCP tool names with non-underscore separators after sanitization (codex round 4 P1)", () => {
    // Raw MCP tool names can use `.`, `-`, etc. The adapter
    // sanitizes them via [^a-zA-Z0-9_] → _ before storing as
    // originalName. Verify the sanitized forms classify correctly.
    assert.strictEqual(isReadOnlyToolName("db_get_run"), true); // sanitized from "db.get_run"
    assert.strictEqual(isReadOnlyToolName("read_file"), true); // sanitized from "read-file"
    assert.strictEqual(isReadOnlyToolName("api_v1_list_users"), true); // dotted namespace
    // Raw forms WITHOUT sanitization fail — documents why the
    // adapter MUST sanitize.
    assert.strictEqual(isReadOnlyToolName("db.get_run"), false); // single segment, no match
    assert.strictEqual(isReadOnlyToolName("read-file"), false); // single segment, no match
  });

  it("classifier uses the ORIGINAL MCP tool name (codex round 3 P2)", () => {
    // An MCP server named `watch` prefixes every one of its tools
    // with `mcp_watch_*`. The PREFIXED name starts with `watch`
    // (a read-only verb) so the raw segment-scan classifies it as
    // read-only — but the SEMANTIC tool name (e.g. "delete_thing")
    // is what we should classify on. In `runAgentTurn`, we build
    // a Map<prefixedName, originalName> from ToolSpec.originalName
    // and feed the original name to isReadOnlyToolName. This test
    // documents both shapes side-by-side so a future regression is
    // visible at the unit-test level.
    assert.strictEqual(isReadOnlyToolName("mcp_watch_delete_thing"), true); // prefixed → wrong (won't reach guard in practice)
    assert.strictEqual(isReadOnlyToolName("delete_thing"), false); // original → correct
    assert.strictEqual(isReadOnlyToolName("mcp_render_update_node"), true); // prefixed → wrong
    assert.strictEqual(isReadOnlyToolName("update_node"), false); // original → correct
  });

  it("mutating verb wins when a tool name mixes mutating + read-only verbs (codex round 2 P2)", () => {
    // The original read-only regex matched any `_status` segment as
    // read-only, which exempted `studio_update_tile_status` from the
    // guard. Mutating verb wins now.
    assert.strictEqual(
      isReadOnlyToolName("mcp_yolo_studio_studio_update_tile_status"),
      false,
    );
    assert.strictEqual(
      isReadOnlyToolName("mcp_yolo_studio_studio_remove_tile"),
      false,
    );
    assert.strictEqual(isReadOnlyToolName("update_view"), false);
    assert.strictEqual(isReadOnlyToolName("delete_list"), false);
    assert.strictEqual(isReadOnlyToolName("apply_search"), false);
    assert.strictEqual(isReadOnlyToolName("set_show"), false);
    // …but pure read shapes (verb=get/check with status as the noun)
    // still classify as read-only.
    assert.strictEqual(isReadOnlyToolName("get_status"), true);
    assert.strictEqual(isReadOnlyToolName("check_status"), true);
    assert.strictEqual(isReadOnlyToolName("mcp_app_get_health_status"), true);
  });

  it("stops at the user-message boundary", () => {
    // Two turns separated by a user message — only the second turn's
    // assistant calls count toward the consecutive run.
    const msgs: ChatMessage[] = [
      { role: "user", content: "go1" },
      assistantWithCall("studio.create_note", "{}", "tc1"),
      toolReply("tc1", "studio.create_note", "{}"),
      { role: "user", content: "go2" },
      assistantWithCall("studio.create_note", "{}", "tc2"),
    ];
    assert.strictEqual(countConsecutiveSameToolName(msgs, "studio.create_note"), 1);
  });
});
