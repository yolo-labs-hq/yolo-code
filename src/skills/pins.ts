import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SkillRecord } from "./types.js";

export interface SkillPins {
  /** Skills the user has explicitly turned on. Stays active even when
   *  Phase 5d's discovery filter would have dropped them. */
  enabled: string[];
  /** Skills the user has explicitly turned off. Excluded from the active
   *  set regardless of discovery. */
  disabled: string[];
}

export function pinsFilePath(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".config", "yolo-code", "skills-pins.json");
}

export function readPins(homeDir?: string): SkillPins {
  const path = pinsFilePath(homeDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { enabled: [], disabled: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SkillPins>;
    return {
      enabled: arrayOfStrings(parsed.enabled),
      disabled: arrayOfStrings(parsed.disabled),
    };
  } catch {
    return { enabled: [], disabled: [] };
  }
}

function writePins(pins: SkillPins, homeDir?: string): void {
  const path = pinsFilePath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  const data: SkillPins = {
    enabled: [...new Set(pins.enabled)].sort(),
    disabled: [...new Set(pins.disabled)].sort(),
  };
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on non-POSIX filesystems */
  }
}

/** Mark `name` as enabled. Removes it from the disabled list if present.
 *  Idempotent. */
export function pinEnable(name: string, homeDir?: string): SkillPins {
  const pins = readPins(homeDir);
  const next: SkillPins = {
    enabled: [...new Set([...pins.enabled, name])],
    disabled: pins.disabled.filter((n) => n !== name),
  };
  writePins(next, homeDir);
  return next;
}

/** Mark `name` as disabled. Removes it from the enabled list if present. */
export function pinDisable(name: string, homeDir?: string): SkillPins {
  const pins = readPins(homeDir);
  const next: SkillPins = {
    enabled: pins.enabled.filter((n) => n !== name),
    disabled: [...new Set([...pins.disabled, name])],
  };
  writePins(next, homeDir);
  return next;
}

/** Drop any pin (enable or disable) for `name`. */
export function pinClear(name: string, homeDir?: string): SkillPins {
  const pins = readPins(homeDir);
  const next: SkillPins = {
    enabled: pins.enabled.filter((n) => n !== name),
    disabled: pins.disabled.filter((n) => n !== name),
  };
  writePins(next, homeDir);
  return next;
}

function arrayOfStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** Filter a list of records by user pins. Disabled pins remove the
 *  record. Enabled pins do nothing here (they matter once Phase 5d's
 *  discovery filter lands and would otherwise drop them). */
export function applyPinFilter(records: SkillRecord[], homeDir?: string): SkillRecord[] {
  const pins = readPins(homeDir);
  if (pins.disabled.length === 0) return records;
  const off = new Set(pins.disabled);
  return records.filter((r) => !off.has(r.name));
}
