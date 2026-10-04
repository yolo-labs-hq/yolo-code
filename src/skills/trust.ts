import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ENV_FORCE_TRUST = "YOLO_TRUST_PROJECT_SKILLS";

interface TrustedFile {
  trusted: string[];
}

export function trustFilePath(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".config", "yolo-code", "trusted-projects.json");
}

export function readTrusted(homeDir?: string): string[] {
  const path = trustFilePath(homeDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TrustedFile>;
    if (parsed && Array.isArray(parsed.trusted)) {
      return parsed.trusted.filter((p): p is string => typeof p === "string");
    }
    return [];
  } catch {
    return [];
  }
}

function writeTrusted(list: string[], homeDir?: string): void {
  const path = trustFilePath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  const data: TrustedFile = { trusted: [...new Set(list)].sort() };
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on non-POSIX filesystems */
  }
}

/** Returns true when project-scoped skills under this cwd should load.
 *  The env override `YOLO_TRUST_PROJECT_SKILLS=1` force-trusts everywhere
 *  (used in tests and headless sandboxes until the slash command lands). */
export function isTrusted(cwd: string, homeDir?: string): boolean {
  if (process.env[ENV_FORCE_TRUST] === "1") return true;
  const target = resolve(cwd);
  return readTrusted(homeDir).some((p) => resolve(p) === target);
}

export function addTrusted(cwd: string, homeDir?: string): void {
  const target = resolve(cwd);
  const list = readTrusted(homeDir);
  if (!list.some((p) => resolve(p) === target)) list.push(target);
  writeTrusted(list, homeDir);
}

export function removeTrusted(cwd: string, homeDir?: string): void {
  const target = resolve(cwd);
  const list = readTrusted(homeDir).filter((p) => resolve(p) !== target);
  writeTrusted(list, homeDir);
}
