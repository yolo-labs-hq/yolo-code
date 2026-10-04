import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractProjectSignature, heuristicMatch, tokenize } from "./heuristic.js";
import type { SkillRecord } from "./types.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "yolo-heuristic-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const skill = (
  name: string,
  description: string,
  tags?: string[],
): SkillRecord => ({
  name,
  description,
  body: "body",
  path: `/tmp/${name}/SKILL.md`,
  scope: "user",
  metadata: tags ? { tags } : undefined,
});

const touch = (rel: string, contents = "") => {
  const path = join(work, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
};

describe("extractProjectSignature", () => {
  it("flags a Node + TypeScript project", () => {
    touch("package.json", "{}");
    touch("tsconfig.json", "{}");
    touch("src/index.ts", "");
    touch("src/util.ts", "");
    const sig = extractProjectSignature(work);
    assert.strictEqual(sig.primaryLanguage, "javascript"); // package.json wins first
    assert.ok(sig.tokens.includes("typescript"));
    assert.ok(sig.tokens.includes("npm"));
    assert.ok(sig.extensions.includes(".ts"));
  });

  it("flags a Cloudflare Worker project", () => {
    touch("package.json", "{}");
    touch("wrangler.jsonc", "{}");
    touch("src/index.ts", "");
    const sig = extractProjectSignature(work);
    assert.ok(sig.tokens.includes("cloudflare"));
    assert.ok(sig.tokens.includes("worker"));
    assert.ok(sig.tokens.includes("wrangler"));
  });

  it("flags Rust via Cargo.toml even with no other files", () => {
    touch("Cargo.toml", "[package]");
    const sig = extractProjectSignature(work);
    assert.strictEqual(sig.primaryLanguage, "rust");
    assert.ok(sig.tokens.includes("rust"));
  });

  it("infers primary language from extension counts when no marker present", () => {
    touch("a.py", "");
    touch("b.py", "");
    touch("c.py", "");
    touch("d.go", "");
    const sig = extractProjectSignature(work);
    assert.strictEqual(sig.primaryLanguage, "python");
  });

  it("returns empty signature for a non-existent cwd without throwing", () => {
    const sig = extractProjectSignature(join(work, "nope"));
    assert.deepStrictEqual(sig.topLevelFiles, []);
    assert.deepStrictEqual(sig.tokens, []);
    assert.strictEqual(sig.primaryLanguage, null);
  });
});

describe("heuristicMatch", () => {
  const records = [
    skill("cloudflare-worker-deploy", "Deploy Cloudflare Workers via wrangler", ["cloudflare", "worker"]),
    skill("pytest-runner", "Run pytest in a python repo"),
    skill("git-workflow", "Commit and PR conventions"),
    skill("rust-build", "Build rust projects with cargo", ["rust", "cargo"]),
  ];

  it("picks cloudflare skill from a wrangler.jsonc signal", () => {
    touch("wrangler.jsonc", "{}");
    touch("package.json", "{}");
    const sig = extractProjectSignature(work);
    const { candidates } = heuristicMatch(records, sig, []);
    const names = candidates.map((c) => c.name);
    assert.ok(names.includes("cloudflare-worker-deploy"), `got: ${names.join(", ")}`);
  });

  it("uses recent user messages as match signal", () => {
    const sig = extractProjectSignature(work);
    const { candidates } = heuristicMatch(records, sig, ["please help me with my pytest tests"]);
    const names = candidates.map((c) => c.name);
    assert.ok(names.includes("pytest-runner"), `got: ${names.join(", ")}`);
  });

  it("returns the empty set when no signals match", () => {
    const sig = extractProjectSignature(work);
    const { candidates } = heuristicMatch(records, sig, ["hello world"]);
    assert.strictEqual(candidates.length, 0);
  });

  it("matches on tag metadata even when description doesn't overlap", () => {
    touch("Cargo.toml", "");
    const sig = extractProjectSignature(work);
    const onlyTaggedSkill = skill(
      "tagged-only",
      "Some unrelated description.",
      ["rust"],
    );
    const { candidates } = heuristicMatch([onlyTaggedSkill], sig, []);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0]?.name, "tagged-only");
  });
});

describe("tokenize", () => {
  it("strips stopwords and short words", () => {
    const out = tokenize("the user wants to deploy a cloudflare worker");
    assert.ok(out.includes("deploy"));
    assert.ok(out.includes("cloudflare"));
    assert.ok(out.includes("worker"));
    assert.ok(!out.includes("the"));
    assert.ok(!out.includes("a"));
  });

  it("handles empty input", () => {
    assert.deepStrictEqual(tokenize(""), []);
  });
});
