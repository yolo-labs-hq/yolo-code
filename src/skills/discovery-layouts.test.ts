import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDiscovery, type LlmRelevanceFn } from "./discovery.js";
import type { SkillRecord } from "./types.js";

/* Synthetic project-layout matrix: for each canonical project shape, the
 * heuristic should pick out the right family of skills. The LLM step is
 * stubbed so these tests exercise heuristic + orchestrator wiring without
 * leaving the runtime. */

let cwd: string;
let home: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "yolo-layout-cwd-"));
  home = mkdtempSync(join(tmpdir(), "yolo-layout-home-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const skill = (name: string, description: string, tags?: string[]): SkillRecord => ({
  name,
  description,
  body: `body of ${name}`,
  path: `/tmp/${name}/SKILL.md`,
  scope: "user",
  metadata: tags ? { tags } : undefined,
});

const file = (rel: string, contents = "") => {
  const path = join(cwd, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
};

/** A library of skills covering the major stacks the seed registry targets. */
const REGISTRY: SkillRecord[] = [
  skill("cloudflare-worker-deploy", "Deploy a Cloudflare Worker via wrangler", ["cloudflare", "worker", "wrangler"]),
  skill("next-15-app-router", "Patterns for Next.js 15 App Router", ["next", "react", "app-router"]),
  skill("vitest-runner", "Run vitest with the project's own config", ["vitest", "test"]),
  skill("rust-build", "Build Rust projects with cargo", ["rust", "cargo"]),
  skill("python-test", "Run pytest against a python repo", ["python", "pytest"]),
  skill("go-build", "Build go projects", ["go", "golang"]),
  skill("git-workflow", "Conventional commits and PR conventions", ["git", "github"]),
  skill("mcp-server-debug", "Diagnose an MCP server", ["mcp", "debug"]),
];

/** A stub that returns whatever the heuristic handed it — used as a sanity
 *  baseline. Real LLMs would narrow further; tests asserting the heuristic
 *  shape don't care about that narrowing. */
const passThroughLlm: LlmRelevanceFn = async ({ candidates }) =>
  candidates.map((c) => c.name);

describe("synthetic project layouts → expected active skills", () => {
  it("Cloudflare Worker repo → cloudflare-worker-deploy + git-workflow surface", async () => {
    file("wrangler.jsonc", "{}");
    file("package.json", "{}");
    file("src/index.ts", "");
    const result = await runDiscovery({
      cwd,
      records: REGISTRY,
      recentMessages: [],
      previousActive: [],
      llm: passThroughLlm,
      homeDir: home,
      noCache: true,
      llmFloor: 0,
    });
    const names = result.active.map((r) => r.name);
    assert.ok(names.includes("cloudflare-worker-deploy"), `expected cloudflare-worker-deploy; got ${names.join(", ")}`);
    // Anti-cases: nothing rust-flavored should leak in.
    assert.ok(!names.includes("rust-build"));
    assert.ok(!names.includes("go-build"));
  });

  it("Next.js 15 webapp → next-15-app-router + vitest-runner surface", async () => {
    file("package.json", JSON.stringify({ dependencies: { next: "15.0.0" } }));
    file("next.config.ts", "");
    file("tsconfig.json", "{}");
    file("app/layout.tsx", "");
    file("app/page.tsx", "");
    const result = await runDiscovery({
      cwd,
      records: REGISTRY,
      recentMessages: [],
      previousActive: [],
      llm: passThroughLlm,
      homeDir: home,
      noCache: true,
      llmFloor: 0,
    });
    const names = result.active.map((r) => r.name);
    assert.ok(names.includes("next-15-app-router"), `expected next-15-app-router; got ${names.join(", ")}`);
    assert.ok(!names.includes("rust-build"));
    assert.ok(!names.includes("python-test"));
  });

  it("Rust crate → rust-build surfaces, JS/Python skills don't", async () => {
    file("Cargo.toml", "[package]\nname = \"x\"");
    file("src/main.rs", "fn main(){}");
    const result = await runDiscovery({
      cwd,
      records: REGISTRY,
      recentMessages: [],
      previousActive: [],
      llm: passThroughLlm,
      homeDir: home,
      noCache: true,
      llmFloor: 0,
    });
    const names = result.active.map((r) => r.name);
    assert.ok(names.includes("rust-build"));
    assert.ok(!names.includes("cloudflare-worker-deploy"));
    assert.ok(!names.includes("next-15-app-router"));
    assert.ok(!names.includes("python-test"));
  });

  it("Python package → python-test surfaces", async () => {
    file("pyproject.toml", "[project]\nname = \"x\"");
    file("src/x/__init__.py", "");
    file("tests/test_x.py", "");
    const result = await runDiscovery({
      cwd,
      records: REGISTRY,
      recentMessages: [],
      previousActive: [],
      llm: passThroughLlm,
      homeDir: home,
      noCache: true,
      llmFloor: 0,
    });
    const names = result.active.map((r) => r.name);
    assert.ok(names.includes("python-test"));
    assert.ok(!names.includes("cloudflare-worker-deploy"));
  });

  it("Go module → go-build surfaces", async () => {
    file("go.mod", "module x\n");
    file("main.go", "package main");
    const result = await runDiscovery({
      cwd,
      records: REGISTRY,
      recentMessages: [],
      previousActive: [],
      llm: passThroughLlm,
      homeDir: home,
      noCache: true,
      llmFloor: 0,
    });
    const names = result.active.map((r) => r.name);
    assert.ok(names.includes("go-build"));
  });

  it("user-message signal can pull a skill in even when the cwd is empty", async () => {
    // Empty cwd, no project signals — only the message tells us the user
    // wants Rust help.
    const result = await runDiscovery({
      cwd,
      records: REGISTRY,
      recentMessages: ["I'm trying to fix a cargo build error"],
      previousActive: [],
      llm: passThroughLlm,
      homeDir: home,
      noCache: true,
      llmFloor: 0,
    });
    const names = result.active.map((r) => r.name);
    assert.ok(names.includes("rust-build"), `expected rust-build via message; got ${names.join(", ")}`);
  });

  it("multi-stack repo (Next.js + Cargo) surfaces skills for both", async () => {
    file("package.json", "{}");
    file("next.config.ts", "");
    file("Cargo.toml", "[package]");
    file("src/main.rs", "");
    file("app/page.tsx", "");
    const result = await runDiscovery({
      cwd,
      records: REGISTRY,
      recentMessages: [],
      previousActive: [],
      llm: passThroughLlm,
      homeDir: home,
      noCache: true,
      llmFloor: 0,
    });
    const names = result.active.map((r) => r.name);
    assert.ok(names.includes("next-15-app-router"));
    assert.ok(names.includes("rust-build"));
  });

  it("returns empty active set when no signals match anything in the catalog", async () => {
    // Empty cwd, neutral message.
    const result = await runDiscovery({
      cwd,
      records: REGISTRY,
      recentMessages: ["hello"],
      previousActive: [],
      llm: passThroughLlm,
      homeDir: home,
      noCache: true,
      llmFloor: 0,
    });
    assert.strictEqual(result.active.length, 0);
    // Reason should reflect the heuristic short-circuit (0 candidates ≤ floor=0).
    assert.strictEqual(result.reason, "heuristic-only");
  });
});
