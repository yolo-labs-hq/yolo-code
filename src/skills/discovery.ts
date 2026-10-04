import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import {
  extractProjectSignature,
  heuristicMatch,
  type ProjectSignature,
} from "./heuristic.js";
import { readPins } from "./pins.js";
import type { SkillRecord } from "./types.js";

/** Below this candidate count we skip the LLM step — heuristic alone is
 *  enough signal and the round-trip cost isn't worth it. Tunable via
 *  YOLO_SKILL_DISCOVERY_LLM_FLOOR. */
const DEFAULT_LLM_FLOOR = 5;

/** Hard cap on how many candidate skills we send to the LLM relevance
 *  pass. Mostly defensive — if the catalog is enormous the heuristic
 *  should already trim it, but this protects token budget regardless. */
const LLM_CANDIDATE_CAP = 30;

export type DiscoveryReason =
  | "disabled"        // YOLO_CODE_SKILL_DISCOVERY=0 or no records
  | "all-included"    // catalog is small enough to skip filtering entirely
  | "heuristic-only"  // ≤ floor candidates after heuristic; LLM skipped
  | "llm"             // heuristic + LLM relevance call
  | "cache"           // cache hit on (catalog hash, signature hash)
  | "llm-failed";     // LLM call errored; fell back to heuristic candidates

export interface DiscoveryResult {
  /** Records the model should see in its catalog this turn. Already has
   *  pin filter (disable + force-on for enabled) applied. */
  active: SkillRecord[];
  /** Diff vs. `previousActive` (names). */
  activated: string[];
  deactivated: string[];
  /** Why we ended up with this set — useful for debug events. */
  reason: DiscoveryReason;
  /** Cache key under which the result was stored / retrieved. */
  cacheKey: string;
  /** The signature used for matching. */
  signature: ProjectSignature;
}

export interface LlmRelevanceParams {
  candidates: SkillRecord[];
  signature: ProjectSignature;
  recentMessages: string[];
}

/** Production transport lives in discovery-llm.ts. Tests inject a stub. */
export type LlmRelevanceFn = (
  params: LlmRelevanceParams,
  signal?: AbortSignal,
) => Promise<string[]>;

export interface RunDiscoveryOpts {
  cwd: string;
  /** Full catalog after `applyPinFilter` (disabled pins already removed). */
  records: SkillRecord[];
  /** Last few user messages — usually the trailing 3, capped to 500 chars
   *  each by the caller. */
  recentMessages: string[];
  /** Names of skills that were active in the previous turn / session,
   *  used for the diff. Empty on session start. */
  previousActive: string[];
  /** Injected LLM transport. Pass `null` to skip the LLM step entirely
   *  (e.g. when no router credentials are available). */
  llm: LlmRelevanceFn | null;
  /** Override home dir (tests). */
  homeDir?: string;
  /** Surface internal warnings (cache decode failures, malformed LLM
   *  responses). */
  onWarn?: (msg: string) => void;
  /** Disable the on-disk cache (tests, also `YOLO_CODE_SKILL_DISCOVERY=0`
   *  callers).*/
  noCache?: boolean;
  /** Override the LLM-skipping floor (default 5). */
  llmFloor?: number;
  signal?: AbortSignal;
}

export function discoveryDisabled(): boolean {
  const v = process.env.YOLO_CODE_SKILL_DISCOVERY;
  return v === "0" || v === "false";
}

export async function runDiscovery(opts: RunDiscoveryOpts): Promise<DiscoveryResult> {
  const signature = extractProjectSignature(opts.cwd);
  const records = opts.records;

  // Empty catalog → nothing to discover.
  if (records.length === 0) {
    return {
      active: [],
      activated: [],
      deactivated: [...opts.previousActive],
      reason: "disabled",
      cacheKey: "",
      signature,
    };
  }

  // Catalog is tiny enough that there's no value in filtering. The
  // session prefix can carry all of it.
  const SMALL_CATALOG = 5;
  if (records.length <= SMALL_CATALOG) {
    const active = mergeEnablePinsIntoActive(records, records, opts.homeDir);
    return finalize(active, opts.previousActive, "all-included", "", signature);
  }

  const cacheKey = computeCacheKey(records, signature, opts.recentMessages);
  if (!opts.noCache) {
    const cached = readCacheEntry(cacheKey, opts.homeDir);
    if (cached) {
      const cachedRecords = records.filter((r) => cached.activeNames.includes(r.name));
      const active = mergeEnablePinsIntoActive(records, cachedRecords, opts.homeDir);
      return finalize(active, opts.previousActive, "cache", cacheKey, signature);
    }
  }

  const { candidates } = heuristicMatch(records, signature, opts.recentMessages);
  const floor = opts.llmFloor ?? readFloorEnv() ?? DEFAULT_LLM_FLOOR;

  // Heuristic dropped enough — skip the LLM round-trip entirely.
  if (candidates.length <= floor || !opts.llm) {
    const active = mergeEnablePinsIntoActive(records, candidates, opts.homeDir);
    if (!opts.noCache) {
      writeCacheEntry(cacheKey, active.map((r) => r.name), opts.homeDir);
    }
    return finalize(active, opts.previousActive, "heuristic-only", cacheKey, signature);
  }

  // LLM relevance pass. Cap candidates so we don't blow token budget on
  // a 200-skill catalog that all matched generic tokens.
  const truncated = candidates.slice(0, LLM_CANDIDATE_CAP);
  let pickedNames: string[];
  try {
    pickedNames = await opts.llm(
      {
        candidates: truncated,
        signature,
        recentMessages: opts.recentMessages,
      },
      opts.signal,
    );
  } catch (e) {
    opts.onWarn?.(`skill-discovery LLM call failed: ${(e as Error).message} (falling back to heuristic candidates)`);
    const active = mergeEnablePinsIntoActive(records, candidates, opts.homeDir);
    return finalize(active, opts.previousActive, "llm-failed", cacheKey, signature);
  }

  const validNames = new Set(records.map((r) => r.name));
  const filteredNames = pickedNames.filter((n) => validNames.has(n));
  const llmPicked = records.filter((r) => filteredNames.includes(r.name));
  const active = mergeEnablePinsIntoActive(records, llmPicked, opts.homeDir);

  if (!opts.noCache) {
    writeCacheEntry(cacheKey, active.map((r) => r.name), opts.homeDir);
  }
  return finalize(active, opts.previousActive, "llm", cacheKey, signature);
}

function readFloorEnv(): number | null {
  const raw = process.env.YOLO_SKILL_DISCOVERY_LLM_FLOOR;
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Given the loader's full record set + the discovery active set, ensure
 *  any `enabled`-pinned skill is in the active set (and de-duplicated). */
export function mergeEnablePinsIntoActive(
  fullCatalog: SkillRecord[],
  active: SkillRecord[],
  homeDir?: string,
): SkillRecord[] {
  const pins = readPins(homeDir);
  if (pins.enabled.length === 0) return active;
  const seen = new Set(active.map((r) => r.name));
  const out = [...active];
  for (const r of fullCatalog) {
    if (pins.enabled.includes(r.name) && !seen.has(r.name)) {
      out.push(r);
      seen.add(r.name);
    }
  }
  return out;
}

function finalize(
  active: SkillRecord[],
  previousActive: string[],
  reason: DiscoveryReason,
  cacheKey: string,
  signature: ProjectSignature,
): DiscoveryResult {
  const prev = new Set(previousActive);
  const next = new Set(active.map((r) => r.name));
  const activated = [...next].filter((n) => !prev.has(n)).sort();
  const deactivated = [...prev].filter((n) => !next.has(n)).sort();
  return { active, activated, deactivated, reason, cacheKey, signature };
}

/* --------------------------------- cache ------------------------------- */

interface CacheFile {
  version: 1;
  entries: Record<string, { activeNames: string[]; storedAt: string }>;
}

const CACHE_MAX_ENTRIES = 64;

export function discoveryCachePath(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".config", "yolo-code", "skills-cache.json");
}

function readCache(homeDir?: string): CacheFile {
  const path = discoveryCachePath(homeDir);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<CacheFile>;
    if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      return parsed as CacheFile;
    }
  } catch {
    /* missing or malformed → fresh cache */
  }
  return { version: 1, entries: {} };
}

function readCacheEntry(
  key: string,
  homeDir?: string,
): { activeNames: string[]; storedAt: string } | null {
  const cache = readCache(homeDir);
  return cache.entries[key] ?? null;
}

function writeCacheEntry(key: string, activeNames: string[], homeDir?: string): void {
  const path = discoveryCachePath(homeDir);
  const cache = readCache(homeDir);
  cache.entries[key] = { activeNames, storedAt: new Date().toISOString() };
  // Trim oldest entries if we exceed the cap.
  const keys = Object.keys(cache.entries);
  if (keys.length > CACHE_MAX_ENTRIES) {
    const sorted = keys
      .map((k) => ({ k, t: cache.entries[k]!.storedAt }))
      .sort((a, b) => a.t.localeCompare(b.t));
    for (const { k } of sorted.slice(0, keys.length - CACHE_MAX_ENTRIES)) {
      delete cache.entries[k];
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2) + "\n", "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
}

export function clearDiscoveryCache(homeDir?: string): void {
  const path = discoveryCachePath(homeDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, entries: {} }, null, 2) + "\n", "utf8");
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
}

/** Compute the cache key for a given catalog + signature + recent messages.
 *  Catalog hash covers (name, description) so editing a SKILL.md
 *  invalidates the cache. */
function computeCacheKey(
  records: SkillRecord[],
  signature: ProjectSignature,
  recentMessages: string[],
): string {
  const catalogHash = createHash("sha256")
    .update(
      records
        .map((r) => `${r.name}\x00${r.description}`)
        .sort()
        .join(""),
    )
    .digest("hex")
    .slice(0, 16);
  const sigInput = [
    ...signature.topLevelFiles,
    "|",
    ...signature.extensions,
    "|",
    signature.primaryLanguage ?? "",
    "|",
    ...recentMessages.map((m) => m.slice(0, 500)),
  ].join("");
  const sigHash = createHash("sha256").update(sigInput).digest("hex").slice(0, 16);
  return `${catalogHash}.${sigHash}`;
}
