import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillsBrowse, skillsValidate, parseSkillTarget } from "./skills-cmd.js";

let work: string;
let stdoutBuf: string;
let stderrBuf: string;
let origWrite: typeof process.stdout.write;
let origErrWrite: typeof process.stderr.write;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "yolo-skills-cmd-"));
  stdoutBuf = "";
  stderrBuf = "";
  origWrite = process.stdout.write.bind(process.stdout);
  origErrWrite = process.stderr.write.bind(process.stderr);
  // Capture writes for assertions while keeping the signature happy.
  (process.stdout.write as unknown) = (s: string | Uint8Array): boolean => {
    stdoutBuf += String(s);
    return true;
  };
  (process.stderr.write as unknown) = (s: string | Uint8Array): boolean => {
    stderrBuf += String(s);
    return true;
  };
});

afterEach(() => {
  (process.stdout.write as unknown) = origWrite;
  (process.stderr.write as unknown) = origErrWrite;
  rmSync(work, { recursive: true, force: true });
});

describe("skillsValidate(path)", () => {
  it("reports `ok:` for a well-formed SKILL.md", async () => {
    const dir = join(work, "good-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---
name: good-skill
description: Does a good thing.
---

# Good skill

Body here.
`,
    );
    const code = await skillsValidate(dir);
    assert.strictEqual(code, 0);
    assert.match(stdoutBuf, /^ok: good-skill/);
  });

  it("returns exit 1 on an unparseable SKILL.md", async () => {
    const dir = join(work, "bad-skill");
    mkdirSync(dir, { recursive: true });
    // No frontmatter at all.
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter here\n");
    const code = await skillsValidate(dir);
    assert.strictEqual(code, 1);
    assert.match(stderrBuf, /error:/);
  });

  it("returns exit 1 when target does not exist", async () => {
    const code = await skillsValidate(join(work, "nope"));
    assert.strictEqual(code, 1);
    assert.match(stderrBuf, /no SKILL\.md at/);
  });

  it("warns (but still exits 0) when name does not match the parent dir", async () => {
    const dir = join(work, "real-name");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---
name: different-name
description: Mismatch test.
---

body
`,
    );
    const code = await skillsValidate(dir);
    assert.strictEqual(code, 0);
    assert.match(stdoutBuf, /warn:.*does not match parent directory/);
  });
});

describe("skillsBrowse(opts)", () => {
  const fakeIndex = {
    version: 1,
    skills: {
      "alpha-one": {
        description: "Does the alpha thing for testing.",
        path: "skills/alpha-one",
        tags: ["alpha", "test"],
        endorsed: true,
        version: "1.0.0",
        license: "MIT",
      },
      "beta-two": {
        description: "Beta widget operations.",
        path: "skills/beta-two",
        tags: ["beta", "widget"],
        endorsed: false,
        version: "1.0.0",
        license: "MIT",
      },
      "frontend-design": {
        description: "Distinctive frontend interfaces.",
        path: "skills/frontend-design",
        tags: ["design", "ui"],
        endorsed: true,
        version: "1.0.0",
        license: "Apache-2.0",
      },
    },
  };

  it("lists every skill with no query", async () => {
    const r = await skillsBrowse({ fetcher: async () => fakeIndex });
    assert.strictEqual(r.ok, true);
    assert.match(r.text, /alpha-one/);
    assert.match(r.text, /beta-two/);
    assert.match(r.text, /frontend-design/);
    assert.match(r.text, /3 skills/);
  });

  it("filters by query against name + description + tags", async () => {
    const r = await skillsBrowse({ query: "design", fetcher: async () => fakeIndex });
    assert.strictEqual(r.ok, true);
    assert.match(r.text, /frontend-design/);
    assert.doesNotMatch(r.text, /alpha-one/);
    assert.doesNotMatch(r.text, /beta-two/);
    assert.match(r.text, /1 of 3 match/);
  });

  it("filters case-insensitively against tags", async () => {
    const r = await skillsBrowse({ query: "WIDGET", fetcher: async () => fakeIndex });
    assert.strictEqual(r.ok, true);
    assert.match(r.text, /beta-two/);
    assert.doesNotMatch(r.text, /alpha-one/);
  });

  it("returns a friendly empty-result message when nothing matches", async () => {
    const r = await skillsBrowse({ query: "nonexistent", fetcher: async () => fakeIndex });
    assert.strictEqual(r.ok, true);
    assert.match(r.text, /no skills match "nonexistent"/);
  });

  it("returns ok:false with a helpful message when the fetcher throws", async () => {
    const r = await skillsBrowse({
      fetcher: async () => {
        throw new Error("simulated network failure");
      },
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.text, /could not fetch registry/);
    assert.match(r.text, /simulated network failure/);
  });

  it("marks endorsed skills as `endorsed` and unendorsed as `available`", async () => {
    const r = await skillsBrowse({ fetcher: async () => fakeIndex });
    // endorsed=true rows show "endorsed", endorsed=false shows "available"
    const lines = r.text.split("\n");
    const alphaLine = lines.find((l) => l.startsWith("alpha-one"));
    const betaLine = lines.find((l) => l.startsWith("beta-two"));
    assert.match(alphaLine!, /endorsed/);
    assert.match(betaLine!, /available/);
  });
});

// Skill version pinning. `yolo-code skills install
// <name>@<version>` syntax is parsed here; the network-dependent install
// flow that consumes the parse result is exercised via the registry
// integration tests.
describe("parseSkillTarget(target)", () => {
  it("returns { name, version: null } for a bare name", () => {
    assert.deepStrictEqual(parseSkillTarget("example-skill"), {
      name: "example-skill",
      version: null,
    });
  });

  it("splits name and version on the first @", () => {
    assert.deepStrictEqual(parseSkillTarget("example-skill@1.3.0"), {
      name: "example-skill",
      version: "1.3.0",
    });
  });

  it("preserves semver suffixes after the @", () => {
    assert.deepStrictEqual(parseSkillTarget("example-skill@1.3.0-rc.1"), {
      name: "example-skill",
      version: "1.3.0-rc.1",
    });
  });

  it("treats an empty version (trailing @) as the literal empty string — the caller hard-fails on the registry lookup", () => {
    // Not a meaningful pin; caller surfaces a registry mismatch error
    // rather than silently treating empty as "latest." Splitting it
    // here keeps the parser simple and the validation centralized.
    assert.deepStrictEqual(parseSkillTarget("example-skill@"), {
      name: "example-skill",
      version: "",
    });
  });

  it("treats a leading @ as an empty name + version", () => {
    // Same shape — caller validates and surfaces the issue.
    assert.deepStrictEqual(parseSkillTarget("@1.3.0"), {
      name: "",
      version: "1.3.0",
    });
  });

  it("only splits on the FIRST @ (registry naming is allowed to contain @ in later positions, even if today's registry doesn't use it)", () => {
    assert.deepStrictEqual(parseSkillTarget("foo@bar@baz"), {
      name: "foo",
      version: "bar@baz",
    });
  });
});
