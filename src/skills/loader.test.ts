import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillFile, scanScope, loadAllSkills, loadAllSkillsWithMeta, parseFrontmatter } from "./loader.js";

/* ----------------------------- fixtures ----------------------------- */

/** Three SKILL.md fixtures patterned after `agentskills/skills-ref/`.
 *  We vendor them inline so tests don't reach the network. */
const FIXTURES: Record<string, string> = {
  "pdf-extraction/SKILL.md": `---
name: pdf-extraction
description: Extract text and tables from PDF files using pdfminer or pypdf.
license: Apache-2.0
allowed-tools:
  - bash
  - read
metadata:
  tags: [pdf, extraction, document]
---

# PDF Extraction

Use \`pdfminer.six\` for text extraction. Fall back to \`pypdf\` for forms.
`,

  "git-workflow/SKILL.md": `---
name: git-workflow
description: "Commit, branch, and PR conventions: small commits, conventional messages, PRs that fit on one screen."
license: MIT
metadata:
  tags: [git, workflow]
  authors:
    - yolo-team
---

# Git workflow

1. Branch from main.
2. Commit early and often.
3. Open a PR before the diff exceeds 400 lines.
`,

  "vitest-runner/SKILL.md": `---
name: vitest-runner
description: |
  Run vitest with the project's own config. Prefer \`vitest run path\` over watch mode
  during agent sessions to avoid leaving processes behind.
compatibility: vitest >=1.0
allowed-tools: [bash]
---

# Vitest runner

Use \`vitest run --reporter=basic <path>\` for targeted runs.
`,
};

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "yolo-skills-test-"));
  for (const [rel, body] of Object.entries(FIXTURES)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/* ----------------------------- parseSkillFile ----------------------------- */

describe("parseSkillFile", () => {
  it("parses a valid SKILL.md with all optional fields", () => {
    const result = parseSkillFile(join(root, "pdf-extraction/SKILL.md"));
    assert.ok("record" in result, "expected success");
    const r = (result as { record: { name: string; description: string; license?: string; allowedTools?: string[]; body: string; metadata?: Record<string, unknown> } }).record;
    assert.strictEqual(r.name, "pdf-extraction");
    assert.match(r.description, /^Extract text/);
    assert.strictEqual(r.license, "Apache-2.0");
    assert.deepStrictEqual(r.allowedTools, ["bash", "read"]);
    assert.ok(r.body.startsWith("# PDF Extraction"));
    assert.ok(r.metadata);
  });

  it("handles quoted-scalar descriptions with colons inside", () => {
    const result = parseSkillFile(join(root, "git-workflow/SKILL.md"));
    assert.ok("record" in result);
    const r = (result as { record: { description: string } }).record;
    assert.match(r.description, /Commit, branch, and PR conventions/);
    assert.match(r.description, /one screen/);
  });

  it("handles `|`-style block scalars and inline lists", () => {
    const result = parseSkillFile(join(root, "vitest-runner/SKILL.md"));
    assert.ok("record" in result);
    const r = (result as { record: { description: string; allowedTools?: string[]; compatibility?: string } }).record;
    assert.match(r.description, /Run vitest/);
    assert.deepStrictEqual(r.allowedTools, ["bash"]);
    assert.strictEqual(r.compatibility, "vitest >=1.0");
  });

  it("returns an error when description is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-skills-bad-"));
    try {
      const path = join(dir, "SKILL.md");
      writeFileSync(path, `---\nname: oops\n---\n\nBody only.\n`, "utf8");
      const result = parseSkillFile(path);
      assert.ok("error" in result, `expected error, got ${JSON.stringify(result)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns but accepts when name does not match parent dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-skills-mismatch-"));
    try {
      const subdir = join(dir, "actual-dir");
      mkdirSync(subdir);
      const path = join(subdir, "SKILL.md");
      writeFileSync(path, `---\nname: claimed-name\ndescription: fine\n---\nbody\n`, "utf8");
      const result = parseSkillFile(path);
      assert.ok("record" in result);
      const r = result as { record: { name: string }; warnings: string[] };
      assert.strictEqual(r.record.name, "claimed-name");
      assert.ok(r.warnings.some((w) => w.includes("does not match")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an error when frontmatter is unparseable garbage", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-skills-garbage-"));
    try {
      const path = join(dir, "SKILL.md");
      // Frontmatter delimiter present but no key:value pairs at all.
      writeFileSync(path, `---\nthis is not yaml\nat all\n---\nbody\n`, "utf8");
      const result = parseSkillFile(path);
      // Either error (no description) or warning-only — but we must not crash.
      assert.ok("error" in result || "record" in result);
      if ("error" in result) {
        assert.match(result.error, /missing 'description'|unparseable/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ----------------------------- parseFrontmatter ----------------------------- */

describe("parseFrontmatter", () => {
  it("recovers from awkward unquoted values via the lenient fallback", () => {
    const fm = parseFrontmatter("description: Use http://example.com — even with colons.");
    assert.ok(fm);
    assert.match(String(fm!.description), /http:\/\/example\.com/);
  });
});

/* ----------------------------- scanScope + loadAllSkills ----------------------------- */

describe("scanScope", () => {
  it("finds all three SKILL.md fixtures under the test root", () => {
    const records = scanScope(root, "user");
    const names = records.map((r) => r.name).sort();
    assert.deepStrictEqual(names, ["git-workflow", "pdf-extraction", "vitest-runner"]);
    for (const r of records) assert.strictEqual(r.scope, "user");
  });

  it("skips .git and node_modules directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-skills-skip-"));
    try {
      const ng = join(dir, "node_modules", "fake-pkg");
      mkdirSync(ng, { recursive: true });
      writeFileSync(join(ng, "SKILL.md"), `---\nname: fake\ndescription: should be ignored\n---\nbody\n`, "utf8");
      const records = scanScope(dir, "user");
      assert.strictEqual(records.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadAllSkills (collision rules)", () => {
  it("project scope wins over user scope when names collide", () => {
    const home = mkdtempSync(join(tmpdir(), "yolo-skills-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "yolo-skills-cwd-"));
    try {
      // user-scope skill at $HOME/.yolo/skills/dup
      const userDir = join(home, ".yolo", "skills", "dup");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(join(userDir, "SKILL.md"), `---\nname: dup\ndescription: user copy\n---\nUSER\n`, "utf8");
      // project-scope skill at $cwd/.agents/skills/dup
      const projDir = join(cwd, ".agents", "skills", "dup");
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, "SKILL.md"), `---\nname: dup\ndescription: project copy\n---\nPROJECT\n`, "utf8");

      const warnings: string[] = [];
      const result = loadAllSkillsWithMeta({ cwd, trusted: true, homeDir: home, onWarn: (m) => warnings.push(m) });
      const winner = result.catalog.get("dup");
      assert.ok(winner);
      assert.strictEqual(winner!.scope, "project");
      assert.match(winner!.body, /PROJECT/);
      assert.ok(
        warnings.some((w) => w.includes("dup") && w.toLowerCase().includes("shadow")),
        `expected shadow warning, got: ${warnings.join(" | ")}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("skips project-scope skills when not trusted, but loads user-scope", () => {
    const home = mkdtempSync(join(tmpdir(), "yolo-skills-home2-"));
    const cwd = mkdtempSync(join(tmpdir(), "yolo-skills-cwd2-"));
    try {
      const userDir = join(home, ".yolo", "skills", "u1");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(join(userDir, "SKILL.md"), `---\nname: u1\ndescription: user one\n---\nU\n`, "utf8");
      const projDir = join(cwd, ".yolo", "skills", "p1");
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, "SKILL.md"), `---\nname: p1\ndescription: project one\n---\nP\n`, "utf8");

      const result = loadAllSkillsWithMeta({ cwd, trusted: false, homeDir: home });
      assert.ok(result.catalog.get("u1"));
      assert.strictEqual(result.catalog.get("p1"), undefined);
      assert.ok(result.untrustedProjectRoots.length > 0);
      assert.strictEqual(result.projectRoots.length, 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("loadAllSkills returns a catalog directly", () => {
    const home = mkdtempSync(join(tmpdir(), "yolo-skills-home3-"));
    const cwd = mkdtempSync(join(tmpdir(), "yolo-skills-cwd3-"));
    try {
      const reg = join(home, ".config", "yolo-code", "skills", "registry-one");
      mkdirSync(reg, { recursive: true });
      writeFileSync(join(reg, "SKILL.md"), `---\nname: registry-one\ndescription: from registry\n---\nR\n`, "utf8");
      const cat = loadAllSkills({ cwd, trusted: true, homeDir: home });
      assert.strictEqual(cat.list().length, 1);
      assert.strictEqual(cat.byScope("registry").length, 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
