import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDiscovery,
  discoveryDisabled,
  clearDiscoveryCache,
  discoveryCachePath,
  mergeEnablePinsIntoActive,
  type LlmRelevanceFn,
} from "./discovery.js";
import { pinDisable, pinEnable } from "./pins.js";
import type { SkillRecord } from "./types.js";

let cwd: string;
let home: string;
let savedDisable: string | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "yolo-disc-cwd-"));
  home = mkdtempSync(join(tmpdir(), "yolo-disc-home-"));
  savedDisable = process.env.YOLO_CODE_SKILL_DISCOVERY;
  delete process.env.YOLO_CODE_SKILL_DISCOVERY;
});

afterEach(() => {
  if (savedDisable === undefined) delete process.env.YOLO_CODE_SKILL_DISCOVERY;
  else process.env.YOLO_CODE_SKILL_DISCOVERY = savedDisable;
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

const touch = (rel: string, contents = "") => {
  const path = join(cwd, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
};

describe("discoveryDisabled()", () => {
  it("returns false by default", () => {
    delete process.env.YOLO_CODE_SKILL_DISCOVERY;
    assert.strictEqual(discoveryDisabled(), false);
  });
  it("returns true when env var is `0`", () => {
    process.env.YOLO_CODE_SKILL_DISCOVERY = "0";
    assert.strictEqual(discoveryDisabled(), true);
  });
  it("returns true when env var is `false`", () => {
    process.env.YOLO_CODE_SKILL_DISCOVERY = "false";
    assert.strictEqual(discoveryDisabled(), true);
  });
});

describe("runDiscovery", () => {
  it("returns empty active set + reason 'disabled' when records is empty", async () => {
    const result = await runDiscovery({
      cwd,
      records: [],
      recentMessages: [],
      previousActive: ["foo"],
      llm: null,
      homeDir: home,
      noCache: true,
    });
    assert.strictEqual(result.active.length, 0);
    assert.strictEqual(result.reason, "disabled");
    assert.deepStrictEqual(result.deactivated, ["foo"]);
  });

  it("returns all records when catalog is small (<=5)", async () => {
    const records = [
      skill("a", "alpha"),
      skill("b", "beta"),
    ];
    const result = await runDiscovery({
      cwd,
      records,
      recentMessages: [],
      previousActive: [],
      llm: null,
      homeDir: home,
      noCache: true,
    });
    assert.strictEqual(result.reason, "all-included");
    assert.deepStrictEqual(result.active.map((r) => r.name), ["a", "b"]);
  });

  it("uses heuristic-only when candidates ≤ floor", async () => {
    touch("wrangler.jsonc", "{}");
    const records = [
      skill("cloudflare-deploy", "Cloudflare worker deploys", ["cloudflare"]),
      skill("ruby-thing", "Ruby on rails patterns", ["ruby"]),
      skill("python-thing", "Python pip workflows", ["python"]),
      skill("java-thing", "Java maven build", ["java"]),
      skill("kotlin-thing", "Kotlin gradle build", ["kotlin"]),
      skill("php-thing", "PHP composer build", ["php"]),
    ];
    const result = await runDiscovery({
      cwd,
      records,
      recentMessages: [],
      previousActive: [],
      llm: null,
      homeDir: home,
      noCache: true,
      llmFloor: 2,
    });
    assert.strictEqual(result.reason, "heuristic-only");
    assert.strictEqual(result.active.length, 1);
    assert.strictEqual(result.active[0]?.name, "cloudflare-deploy");
  });

  it("calls the LLM transport when candidates > floor", async () => {
    touch("package.json", "{}");
    touch("tsconfig.json", "{}");
    const records = [
      skill("ts-build", "TypeScript build hints", ["typescript"]),
      skill("npm-publish", "Publish to npm", ["npm"]),
      skill("node-test", "Run node tests", ["node"]),
      skill("js-format", "Format JS", ["javascript"]),
      skill("rust-build", "Build Rust", ["rust"]),
      skill("python-test", "Run python tests", ["python"]),
    ];
    let calls = 0;
    const llm: LlmRelevanceFn = async ({ candidates }) => {
      calls++;
      // LLM picks just two of the candidates.
      return candidates.slice(0, 2).map((c) => c.name);
    };
    const result = await runDiscovery({
      cwd,
      records,
      recentMessages: [],
      previousActive: [],
      llm,
      homeDir: home,
      noCache: true,
      llmFloor: 1,
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(result.reason, "llm");
    assert.strictEqual(result.active.length, 2);
  });

  it("falls back to heuristic candidates when the LLM throws", async () => {
    touch("package.json", "{}");
    const records = Array.from({ length: 10 }, (_, i) =>
      skill(`skill-${i}`, "javascript stuff", ["javascript"]),
    );
    const llm: LlmRelevanceFn = async () => {
      throw new Error("network down");
    };
    const warnings: string[] = [];
    const result = await runDiscovery({
      cwd,
      records,
      recentMessages: [],
      previousActive: [],
      llm,
      homeDir: home,
      noCache: true,
      llmFloor: 1,
      onWarn: (m) => warnings.push(m),
    });
    assert.strictEqual(result.reason, "llm-failed");
    assert.ok(result.active.length > 0);
    assert.ok(warnings.some((w) => w.includes("network down")));
  });

  it("hits the cache on a second call with identical inputs", async () => {
    touch("package.json", "{}");
    const records = Array.from({ length: 10 }, (_, i) =>
      skill(`skill-${i}`, "javascript stuff", ["javascript"]),
    );
    let calls = 0;
    const llm: LlmRelevanceFn = async ({ candidates }) => {
      calls++;
      return candidates.slice(0, 3).map((c) => c.name);
    };

    const first = await runDiscovery({
      cwd,
      records,
      recentMessages: ["hello"],
      previousActive: [],
      llm,
      homeDir: home,
      llmFloor: 1,
    });
    assert.strictEqual(first.reason, "llm");
    assert.strictEqual(calls, 1);

    const second = await runDiscovery({
      cwd,
      records,
      recentMessages: ["hello"],
      previousActive: first.active.map((r) => r.name),
      llm,
      homeDir: home,
      llmFloor: 1,
    });
    assert.strictEqual(second.reason, "cache");
    assert.strictEqual(calls, 1, "LLM should not be called again on cache hit");
    assert.deepStrictEqual(
      second.active.map((r) => r.name).sort(),
      first.active.map((r) => r.name).sort(),
    );
  });

  it("reports activated/deactivated diff vs. previousActive", async () => {
    const records = [skill("a", "alpha"), skill("b", "beta")];
    const result = await runDiscovery({
      cwd,
      records,
      recentMessages: [],
      previousActive: ["b", "c"],
      llm: null,
      homeDir: home,
      noCache: true,
    });
    assert.deepStrictEqual(result.activated, ["a"]);
    assert.deepStrictEqual(result.deactivated, ["c"]);
  });

  it("force-includes enabled-pinned skills the heuristic would have dropped", async () => {
    touch("package.json", "{}");
    pinEnable("force-on", home);
    const records = [
      skill("ts-build", "TypeScript build", ["typescript"]),
      skill("npm-publish", "npm publish flow", ["npm"]),
      skill("force-on", "Has nothing to do with this project", ["unrelated"]),
      skill("rust-thing", "rust build", ["rust"]),
      skill("python-thing", "python test", ["python"]),
      skill("kotlin-thing", "kotlin", ["kotlin"]),
    ];
    const result = await runDiscovery({
      cwd,
      records,
      recentMessages: [],
      previousActive: [],
      llm: null,
      homeDir: home,
      noCache: true,
      llmFloor: 1,
    });
    const names = result.active.map((r) => r.name);
    assert.ok(names.includes("force-on"), `expected force-on in active, got: ${names.join(", ")}`);
  });
});

describe("clearDiscoveryCache", () => {
  it("creates an empty cache file at the expected path", () => {
    clearDiscoveryCache(home);
    const path = discoveryCachePath(home);
    assert.ok(existsSync(path));
  });
});

describe("mergeEnablePinsIntoActive", () => {
  it("re-adds enabled-pinned skills that fell off the active list", () => {
    pinEnable("forced", home);
    const all = [skill("forced", "x"), skill("normal", "y")];
    const active = [all[1]!];
    const merged = mergeEnablePinsIntoActive(all, active, home);
    assert.deepStrictEqual(merged.map((r) => r.name).sort(), ["forced", "normal"]);
  });

  it("does nothing when no enable pins are set", () => {
    const all = [skill("a", "x"), skill("b", "y")];
    const active = [all[0]!];
    const merged = mergeEnablePinsIntoActive(all, active, home);
    assert.strictEqual(merged.length, 1);
  });

  it("ignores enable pins for skills that aren't installed", () => {
    pinEnable("ghost", home);
    const all = [skill("a", "x")];
    const active = [all[0]!];
    const merged = mergeEnablePinsIntoActive(all, active, home);
    assert.deepStrictEqual(merged.map((r) => r.name), ["a"]);
  });

  it("does not double-add a skill already in active", () => {
    pinEnable("a", home);
    const all = [skill("a", "x")];
    const merged = mergeEnablePinsIntoActive(all, all, home);
    assert.strictEqual(merged.length, 1);
  });

  it("filters disabled-pinned skills are already gone from `all` (caller responsibility)", () => {
    // Sanity: disable-pinning is applied via applyPinFilter before
    // discovery runs, so the merge helper never sees disabled skills.
    pinDisable("nope", home);
    const all = [skill("a", "x")];
    const merged = mergeEnablePinsIntoActive(all, all, home);
    assert.deepStrictEqual(merged.map((r) => r.name), ["a"]);
  });
});
