import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTrusted, isTrusted, removeTrusted, readTrusted, trustFilePath } from "./trust.js";

let home: string;
let savedEnv: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yolo-trust-"));
  savedEnv = process.env.YOLO_TRUST_PROJECT_SKILLS;
  delete process.env.YOLO_TRUST_PROJECT_SKILLS;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.YOLO_TRUST_PROJECT_SKILLS;
  else process.env.YOLO_TRUST_PROJECT_SKILLS = savedEnv;
  rmSync(home, { recursive: true, force: true });
});

describe("trust round-trip", () => {
  it("round-trips a single cwd through add/check/remove", () => {
    const cwd = "/tmp/some-project";
    assert.strictEqual(isTrusted(cwd, home), false);
    addTrusted(cwd, home);
    assert.strictEqual(isTrusted(cwd, home), true);
    assert.deepStrictEqual(readTrusted(home), [cwd]);
    removeTrusted(cwd, home);
    assert.strictEqual(isTrusted(cwd, home), false);
    assert.deepStrictEqual(readTrusted(home), []);
  });

  it("normalizes paths via resolve so equivalent cwds match", () => {
    const cwd = "/tmp/foo/../foo";
    addTrusted(cwd, home);
    assert.strictEqual(isTrusted("/tmp/foo", home), true);
  });

  it("creates the trust file with chmod 600 (POSIX best-effort)", () => {
    addTrusted("/tmp/x", home);
    const path = trustFilePath(home);
    assert.ok(existsSync(path));
    if (process.platform !== "win32") {
      const mode = statSync(path).mode & 0o777;
      assert.strictEqual(mode, 0o600);
    }
  });

  it("env override force-trusts every cwd", () => {
    process.env.YOLO_TRUST_PROJECT_SKILLS = "1";
    assert.strictEqual(isTrusted("/never-added", home), true);
  });

  it("returns empty list when file does not exist", () => {
    assert.deepStrictEqual(readTrusted(home), []);
  });

  it("dedupes when adding the same path twice", () => {
    addTrusted("/tmp/dup", home);
    addTrusted("/tmp/dup", home);
    assert.strictEqual(readTrusted(home).length, 1);
  });
});
