import { describe, it } from "node:test";
import assert from "node:assert";
import { ToolExecutor } from "./executor.js";
import type { ToolSpec } from "./registry.js";

const ALWAYS_ALLOW = async () => "allow" as const;

describe("ToolExecutor abort handling", () => {
  it("rethrows AbortError from tool runs", async () => {
    const abortingTool: ToolSpec = {
      name: "aborting_tool",
      description: "throws AbortError",
      parameters: { type: "object", properties: {} },
      needsPermission: false,
      async run() {
        throw new DOMException("aborted", "AbortError");
      },
    };

    const exec = new ToolExecutor([abortingTool]);

    await assert.rejects(
      exec.run(
        { id: "1", name: "aborting_tool", arguments: "{}" },
        ALWAYS_ALLOW,
        { cwd: process.cwd() },
      ),
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );
  });
});

// 2026-05-13: list/revoke session permissions for the /permissions
// slash command UX. The mechanism existed (allow_session in the
// modal), but listSessionPermissions + revokeSessionPermission give
// operators a way to see what they've granted and take it back.
describe("ToolExecutor session permissions list/revoke", () => {
  const needsPermTool: ToolSpec = {
    name: "perm_tool",
    description: "test",
    parameters: { type: "object", properties: {} },
    needsPermission: true,
    async run() {
      return "ran";
    },
  };

  const bashTool: ToolSpec = {
    name: "bash",
    description: "shell",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    needsPermission: true,
    async run() {
      return "ran";
    },
  };

  it("listSessionPermissions returns empty when none granted", () => {
    const exec = new ToolExecutor([needsPermTool]);
    assert.deepStrictEqual(exec.listSessionPermissions(), []);
  });

  it("listSessionPermissions surfaces tool-name and bash:verb shapes", async () => {
    const exec = new ToolExecutor([needsPermTool, bashTool]);
    // Trigger an allow_session for the plain tool.
    await exec.run(
      { id: "1", name: "perm_tool", arguments: "{}" },
      async () => "allow_session",
      { cwd: process.cwd() },
    );
    // And for `bash git ...`.
    await exec.run(
      { id: "2", name: "bash", arguments: JSON.stringify({ command: "git status" }) },
      async () => "allow_session",
      { cwd: process.cwd() },
    );
    assert.deepStrictEqual(exec.listSessionPermissions(), ["bash:git", "perm_tool"]);
  });

  it("revokeSessionPermission removes a granted key and returns true", async () => {
    const exec = new ToolExecutor([needsPermTool]);
    await exec.run(
      { id: "1", name: "perm_tool", arguments: "{}" },
      async () => "allow_session",
      { cwd: process.cwd() },
    );
    assert.strictEqual(exec.revokeSessionPermission("perm_tool"), true);
    assert.deepStrictEqual(exec.listSessionPermissions(), []);
  });

  it("revokeSessionPermission returns false for an unknown key", () => {
    const exec = new ToolExecutor([needsPermTool]);
    assert.strictEqual(exec.revokeSessionPermission("ghost"), false);
  });

  it("clearSessionPermissions wipes all entries", async () => {
    const exec = new ToolExecutor([needsPermTool, bashTool]);
    await exec.run(
      { id: "1", name: "perm_tool", arguments: "{}" },
      async () => "allow_session",
      { cwd: process.cwd() },
    );
    await exec.run(
      { id: "2", name: "bash", arguments: JSON.stringify({ command: "ls -la" }) },
      async () => "allow_session",
      { cwd: process.cwd() },
    );
    assert.strictEqual(exec.listSessionPermissions().length, 2);
    exec.clearSessionPermissions();
    assert.deepStrictEqual(exec.listSessionPermissions(), []);
  });

  it("after a revoke, the next call re-prompts (not silently allowed)", async () => {
    const exec = new ToolExecutor([needsPermTool]);
    let promptCount = 0;
    const asker = async () => {
      promptCount++;
      return "allow_session" as const;
    };
    await exec.run({ id: "1", name: "perm_tool", arguments: "{}" }, asker, { cwd: process.cwd() });
    // Now allowed for the session — second call should NOT prompt.
    await exec.run({ id: "2", name: "perm_tool", arguments: "{}" }, asker, { cwd: process.cwd() });
    assert.strictEqual(promptCount, 1);
    // Revoke and try again — should prompt once more.
    assert.strictEqual(exec.revokeSessionPermission("perm_tool"), true);
    await exec.run({ id: "3", name: "perm_tool", arguments: "{}" }, asker, { cwd: process.cwd() });
    assert.strictEqual(promptCount, 2);
  });
});
