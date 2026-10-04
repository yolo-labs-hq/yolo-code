import { describe, it } from "node:test";
import assert from "node:assert";
import { ToolExecutor } from "./executor.js";
import { InMemorySkillCatalog } from "../skills/types.js";

const ALWAYS_ALLOW = async () => "allow" as const;

function makeCatalog() {
  return new InMemorySkillCatalog([
    {
      name: "echo-test",
      description: "Reply with the string 'pong' when invoked.",
      body: "When the user asks for a ping, respond exactly: pong.",
      path: "/fake/echo-test/SKILL.md",
      scope: "project" as const,
    },
    {
      name: "summarize",
      description: "Summarize a file in three bullets.",
      body: "Read the file, then output three terse bullets.",
      path: "/fake/summarize/SKILL.md",
      scope: "user" as const,
    },
  ]);
}

describe("skill tool", () => {
  it("is auto-registered on a fresh executor", () => {
    const exec = new ToolExecutor([]);
    const names = exec.list().map((t) => t.name);
    assert.ok(names.includes("skill"), `expected 'skill' in tool list, got: ${names.join(",")}`);
  });

  it("returns the body when called with a known name", async () => {
    const exec = new ToolExecutor([]);
    exec.setSkillCatalog(makeCatalog());
    const result = await exec.run(
      { id: "1", name: "skill", arguments: JSON.stringify({ name: "echo-test" }) },
      ALWAYS_ALLOW,
      { cwd: process.cwd() },
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.content, /respond exactly: pong/);
  });

  it("errors with a friendly list when the name is unknown", async () => {
    const exec = new ToolExecutor([]);
    exec.setSkillCatalog(makeCatalog());
    const result = await exec.run(
      { id: "2", name: "skill", arguments: JSON.stringify({ name: "nope" }) },
      ALWAYS_ALLOW,
      { cwd: process.cwd() },
    );
    // The tool itself returns the error in its content; ok is true because
    // the run didn't throw.
    assert.strictEqual(result.ok, true);
    assert.match(result.content, /unknown skill "nope"/);
    assert.match(result.content, /echo-test/);
    assert.match(result.content, /summarize/);
  });

  it("reports gracefully when no catalog is bound", async () => {
    const exec = new ToolExecutor([]);
    const result = await exec.run(
      { id: "3", name: "skill", arguments: JSON.stringify({ name: "anything" }) },
      ALWAYS_ALLOW,
      { cwd: process.cwd() },
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.content, /No skills are available/i);
  });
});
