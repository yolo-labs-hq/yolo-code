import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAllSkillsWithMeta } from "./loader.js";
import { applyPinFilter } from "./pins.js";
import { runDiscovery, type LlmRelevanceFn } from "./discovery.js";
import { addTrusted } from "./trust.js";
import { ToolExecutor } from "../tools/executor.js";
import { InMemorySkillCatalog } from "./types.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";

/* End-to-end check that the pieces hang together: a user drops a SKILL.md
 * in `.yolo/skills/`, trusts the project, the loader picks it up, discovery
 * preserves it, the system prompt advertises it, and the `skill` tool returns
 * its body when invoked. This is the deepest integration we can run without
 * touching the network. */

let cwd: string;
let home: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "yolo-e2e-cwd-"));
  home = mkdtempSync(join(tmpdir(), "yolo-e2e-home-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const writeSkill = (rel: string, name: string, description: string, body: string) => {
  const dir = join(cwd, rel, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
metadata:
  tags: [${name.split("-").join(", ")}]
---

${body}
`,
  );
};

describe("end-to-end: SKILL.md → catalog → system prompt → skill tool", () => {
  it("flows a project-scoped skill all the way through to a successful tool call", async () => {
    writeSkill(
      ".yolo/skills",
      "deploy-helper",
      "Helps deploy the project safely.",
      "# Deploy helper\n\n1. Run tests.\n2. Bump version.\n3. Push tag.",
    );
    addTrusted(cwd, home);

    // Loader: scope=project, project root scanned because we trusted cwd.
    const result = loadAllSkillsWithMeta({ cwd, trusted: true, homeDir: home });
    assert.strictEqual(result.catalog.list().length, 1);
    const record = result.catalog.get("deploy-helper");
    assert.ok(record, "loader should find the dropped SKILL.md");
    assert.strictEqual(record!.scope, "project");
    assert.match(record!.body, /Deploy helper/);

    // Pin filter is a no-op (no pins set).
    const pinFiltered = applyPinFilter(result.catalog.list(), home);
    assert.strictEqual(pinFiltered.length, 1);

    // Discovery: small catalog (< 5) → all-included branch.
    const discovery = await runDiscovery({
      cwd,
      records: pinFiltered,
      recentMessages: [],
      previousActive: [],
      llm: null,
      homeDir: home,
      noCache: true,
    });
    assert.strictEqual(discovery.reason, "all-included");
    assert.strictEqual(discovery.active.length, 1);

    // System prompt advertises the skill in its catalog block.
    const executor = new ToolExecutor();
    const catalog = new InMemorySkillCatalog(discovery.active);
    executor.setSkillCatalog(catalog);
    const prompt = buildSystemPrompt({
      cwd,
      tools: executor.list(),
      model: "@cf/test/model",
      activeSkills: discovery.active.map((r) => ({ name: r.name, description: r.description })),
    });
    assert.match(prompt, /deploy-helper/);
    assert.match(prompt, /Helps deploy the project safely/);

    // The `skill` tool is registered and returns the SKILL.md body when
    // called with the skill's name.
    const skillRun = await executor.run(
      { id: "tool-call-1", name: "skill", arguments: JSON.stringify({ name: "deploy-helper" }) },
      async () => "deny", // never asked — skill tool needsPermission=false
      { cwd },
    );
    assert.strictEqual(skillRun.ok, true, "skill tool call must succeed");
    assert.match(skillRun.content, /Deploy helper/);
    assert.match(skillRun.content, /Bump version/);
  });

  it("returns a friendly error from the skill tool when the requested name is unknown", async () => {
    writeSkill(".yolo/skills", "alpha", "Alpha skill.", "# Alpha\nbody.");
    addTrusted(cwd, home);
    const result = loadAllSkillsWithMeta({ cwd, trusted: true, homeDir: home });
    const executor = new ToolExecutor();
    executor.setSkillCatalog(new InMemorySkillCatalog(result.catalog.list()));

    const out = await executor.run(
      { id: "tc-2", name: "skill", arguments: JSON.stringify({ name: "ghost" }) },
      async () => "deny",
      { cwd },
    );
    assert.strictEqual(out.ok, true);
    assert.match(out.content, /unknown skill/);
    assert.match(out.content, /alpha/);
  });

  it("hides untrusted project skills from the loader catalog", () => {
    writeSkill(".yolo/skills", "secret-skill", "Should not load.", "# secret");
    // Note: not calling addTrusted, and not setting the env var.
    const result = loadAllSkillsWithMeta({ cwd, trusted: false, homeDir: home });
    assert.strictEqual(result.catalog.list().length, 0);
    assert.strictEqual(result.untrustedProjectRoots.length, 1);
  });

  it("survives a full discovery round-trip with a stub LLM (heuristic + LLM filter active)", async () => {
    // Make the project look like a Cloudflare worker so the heuristic hits.
    writeFileSync(join(cwd, "wrangler.jsonc"), "{}");
    writeFileSync(join(cwd, "package.json"), "{}");
    // Stage a mix of skills — most should drop on heuristic, the LLM trims further.
    for (let i = 0; i < 6; i++) {
      writeSkill(".yolo/skills", `unrelated-${i}`, `Unrelated ${i}`, "body");
    }
    writeSkill(
      ".yolo/skills",
      "cloudflare-deploy",
      "Deploy a Cloudflare worker via wrangler.",
      "# cf",
    );
    addTrusted(cwd, home);
    const loaded = loadAllSkillsWithMeta({ cwd, trusted: true, homeDir: home });
    const records = applyPinFilter(loaded.catalog.list(), home);
    assert.ok(records.length >= 7);

    let llmCalls = 0;
    const llm: LlmRelevanceFn = async ({ candidates }) => {
      llmCalls++;
      // Pick the first matching candidate name — proves we got real records.
      return candidates.slice(0, 1).map((c) => c.name);
    };

    const discovery = await runDiscovery({
      cwd,
      records,
      recentMessages: ["how do I ship this worker?"],
      previousActive: [],
      llm,
      homeDir: home,
      noCache: true,
      llmFloor: 0,
    });
    assert.strictEqual(llmCalls, 1, "LLM should be called when heuristic candidates > floor");
    // The LLM picked exactly one — the active set should contain it (modulo
    // any pinned-on additions, which there aren't here).
    assert.strictEqual(discovery.active.length, 1);
    assert.strictEqual(discovery.reason, "llm");
  });
});
