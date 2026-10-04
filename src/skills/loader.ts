import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  type SkillCatalog,
  InMemorySkillCatalog,
  type SkillRecord,
  type SkillScope,
} from "./types.js";

const SCAN_MAX_DEPTH = 4;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".cache"]);
const NAME_MAX_LEN = 64;
const DESCRIPTION_MAX_LEN = 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface ParseSuccess {
  record: SkillRecord;
  warnings: string[];
}

export interface ParseError {
  error: string;
}

export type ParseResult = ParseSuccess | ParseError;

/** Parse a SKILL.md file: YAML frontmatter + markdown body, lenient validation.
 *  Returns `{error}` only when the file has no description or unparseable
 *  frontmatter. Other issues (name mismatch, length, malformed scalars) are
 *  surfaced as warnings while still returning a record. */
export function parseSkillFile(path: string): ParseResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { error: `cannot read ${path}: ${(e as Error).message}` };
  }

  const split = splitFrontmatter(raw);
  if (!split) {
    return { error: `no frontmatter in ${path}` };
  }
  const { frontmatter, body } = split;

  const fm = parseFrontmatter(frontmatter);
  if (!fm) {
    return { error: `unparseable YAML frontmatter in ${path}` };
  }

  const warnings: string[] = [];
  const description = strField(fm, "description");
  if (!description) {
    return { error: `missing 'description' in ${path}` };
  }
  if (description.length > DESCRIPTION_MAX_LEN) {
    warnings.push(`${path}: description is ${description.length} chars (>${DESCRIPTION_MAX_LEN}, will be used as-is)`);
  }

  const dirName = basename(dirname(path));
  let name = strField(fm, "name") ?? dirName;
  if (!name) {
    return { error: `missing 'name' and could not infer from path ${path}` };
  }
  if (name !== dirName) {
    warnings.push(`${path}: name '${name}' does not match parent directory '${dirName}'`);
  }
  if (name.length > NAME_MAX_LEN) {
    warnings.push(`${path}: name '${name}' is ${name.length} chars (>${NAME_MAX_LEN})`);
  }
  if (!NAME_RE.test(name)) {
    warnings.push(`${path}: name '${name}' is not kebab-case`);
  }

  const license = strField(fm, "license");
  const compatibility = strField(fm, "compatibility");
  const allowedTools = listField(fm, "allowed-tools") ?? listField(fm, "allowedTools");
  const metadata = objField(fm, "metadata");

  return {
    record: {
      name,
      description,
      body: body.trim(),
      path,
      // scope is set by scanScope/loadAllSkills, not parseSkillFile.
      scope: "project",
      license,
      compatibility,
      allowedTools,
      metadata,
    },
    warnings,
  };
}

/** Walk subdirectories under rootDir looking for `SKILL.md`. Max depth 4,
 *  skips `.git` / `node_modules` and similar. Returns parsed records with
 *  the supplied scope stamped onto each. Skipped/errored files are silently
 *  dropped — log via the optional `onWarn` callback. */
export function scanScope(
  rootDir: string,
  scope: SkillScope,
  opts: { onWarn?: (msg: string) => void } = {},
): SkillRecord[] {
  const out: SkillRecord[] = [];
  walk(rootDir, 0);
  return out;

  function walk(dir: string, depth: number): void {
    if (depth > SCAN_MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes("SKILL.md")) {
      const p = join(dir, "SKILL.md");
      const result = parseSkillFile(p);
      if ("error" in result) {
        opts.onWarn?.(`skipped ${p}: ${result.error}`);
      } else {
        for (const w of result.warnings) opts.onWarn?.(w);
        out.push({ ...result.record, scope });
      }
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      const sub = join(dir, entry);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(sub);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(sub, depth + 1);
    }
  }
}

export interface LoadAllOpts {
  cwd: string;
  /** When false, project-scoped skill directories under `cwd` are not loaded. */
  trusted: boolean;
  /** Override home dir (tests). */
  homeDir?: string;
  /** Warning callback. */
  onWarn?: (msg: string) => void;
  /** Whether project skills exist (project-level dirs that would have been loaded if trusted).
   *  This flag is exposed via `loadAllSkillsWithMeta`. */
}

export interface LoadAllResult {
  catalog: SkillCatalog;
  /** Project-level skill roots actually scanned (only when trusted). */
  projectRoots: string[];
  /** Project-level skill roots that exist on disk but were skipped due to trust. */
  untrustedProjectRoots: string[];
  warnings: string[];
}

/** Load skills from all scopes. Project > user > registry; within a scope,
 *  the first-found wins and shadowed entries are warned. */
export function loadAllSkills(opts: LoadAllOpts): SkillCatalog {
  return loadAllSkillsWithMeta(opts).catalog;
}

export function loadAllSkillsWithMeta(opts: LoadAllOpts): LoadAllResult {
  const home = opts.homeDir ?? homedir();
  const warnings: string[] = [];
  const onWarn = (msg: string) => {
    warnings.push(msg);
    opts.onWarn?.(msg);
  };

  const projectRootCandidates = [
    join(opts.cwd, ".yolo", "skills"),
    join(opts.cwd, ".agents", "skills"),
    join(opts.cwd, ".claude", "skills"),
  ];
  const userRoots = [
    join(home, ".yolo", "skills"),
    join(home, ".agents", "skills"),
  ];
  const registryRoots = [
    join(home, ".config", "yolo-code", "skills"),
  ];

  const projectRoots = projectRootCandidates.filter(dirExists);
  const projectActive = opts.trusted ? projectRoots : [];
  const untrustedProjectRoots = opts.trusted ? [] : projectRoots;

  const projectRecords = projectActive.flatMap((r) => scanScope(r, "project", { onWarn }));
  const userRecords = userRoots
    .filter(dirExists)
    .flatMap((r) => scanScope(r, "user", { onWarn }));
  const registryRecords = registryRoots
    .filter(dirExists)
    .flatMap((r) => scanScope(r, "registry", { onWarn }));

  const seen = new Map<string, SkillRecord>();
  const accept = (r: SkillRecord) => {
    const existing = seen.get(r.name);
    if (!existing) {
      seen.set(r.name, r);
      return;
    }
    onWarn(`skill '${r.name}' at ${r.path} shadowed by ${existing.scope}-scope entry at ${existing.path}`);
  };
  for (const r of dedupeWithinScope(projectRecords, onWarn)) accept(r);
  for (const r of dedupeWithinScope(userRecords, onWarn)) accept(r);
  for (const r of dedupeWithinScope(registryRecords, onWarn)) accept(r);

  return {
    catalog: new InMemorySkillCatalog([...seen.values()]),
    projectRoots: projectActive,
    untrustedProjectRoots,
    warnings,
  };
}

function dedupeWithinScope(records: SkillRecord[], onWarn: (msg: string) => void): SkillRecord[] {
  const seen = new Map<string, SkillRecord>();
  for (const r of records) {
    const existing = seen.get(r.name);
    if (!existing) {
      seen.set(r.name, r);
      continue;
    }
    onWarn(`duplicate skill '${r.name}' in ${r.scope} scope: keeping ${existing.path}, ignoring ${r.path}`);
  }
  return [...seen.values()];
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/* ----------------------------- frontmatter ----------------------------- */

interface Split {
  frontmatter: string;
  body: string;
}

function splitFrontmatter(raw: string): Split | null {
  // Tolerate a leading BOM and CRLF line endings.
  const text = raw.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      return {
        frontmatter: lines.slice(1, i).join("\n"),
        body: lines.slice(i + 1).join("\n"),
      };
    }
  }
  return null;
}

type Scalar = string | number | boolean;
type FmValue = Scalar | string[] | Record<string, unknown>;
type FmObject = Record<string, FmValue>;

/** Lenient YAML frontmatter parser. Supports the subset used by SKILL.md:
 *  - top-level `key: scalar`
 *  - top-level `key: [a, b, c]` and block-list `key:\n  - a\n  - b`
 *  - nested 2-space-indented mapping (one level deep) for `metadata:`
 *  - `>` and `|` block scalars folded/literal-style
 *  - quoted-scalar fallback when an unquoted value contains `:` / special chars
 *
 *  Returns `null` on completely unparseable input. */
export function parseFrontmatter(yaml: string): FmObject | null {
  if (!yaml.trim()) return {};
  const lines = yaml.split("\n");
  const out: FmObject = {};
  let i = 0;
  let parsedAnything = false;

  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) {
      i++;
      continue;
    }
    const top = rawLine.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!top) {
      // Unparseable line — skip it but don't abandon the whole document.
      i++;
      continue;
    }
    const key = top[1]!;
    const inline = top[2] ?? "";

    // Block scalar (`|` or `>`) on the value side.
    const blockMatch = inline.match(/^([|>])([+-]?)\s*$/);
    if (blockMatch) {
      const style = blockMatch[1]!;
      const collected: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (next.trim() === "") {
          collected.push("");
          i++;
          continue;
        }
        const indent = next.match(/^(\s+)/);
        if (!indent || indent[1]!.length < 2) break;
        collected.push(next.slice(indent[1]!.length));
        i++;
      }
      const joined = style === "|" ? collected.join("\n") : collected.join(" ").replace(/\s+/g, " ").trim();
      out[key] = joined;
      parsedAnything = true;
      continue;
    }

    // Inline list `[a, b]`.
    if (inline.startsWith("[") && inline.endsWith("]")) {
      const inner = inline.slice(1, -1).trim();
      const items = inner === ""
        ? []
        : inner.split(",").map((s) => stripQuotes(s.trim())).filter((s) => s.length > 0);
      out[key] = items;
      i++;
      parsedAnything = true;
      continue;
    }

    // Block-style list or nested mapping when value is empty.
    if (inline === "") {
      // Peek the next non-blank line.
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? "").trim() === "") j++;
      const peek = lines[j] ?? "";
      if (/^\s*-\s+/.test(peek)) {
        const items: string[] = [];
        i = j;
        while (i < lines.length) {
          const next = lines[i] ?? "";
          const m = next.match(/^\s*-\s+(.*)$/);
          if (!m) {
            if (next.trim() === "") { i++; continue; }
            break;
          }
          items.push(stripQuotes(m[1]!.trim()));
          i++;
        }
        out[key] = items;
        parsedAnything = true;
        continue;
      }
      if (/^\s+\S/.test(peek)) {
        // Nested mapping (one level deep).
        const obj: Record<string, unknown> = {};
        i = j;
        while (i < lines.length) {
          const next = lines[i] ?? "";
          if (next.trim() === "") { i++; continue; }
          const indent = next.match(/^(\s+)/);
          if (!indent || indent[1]!.length < 2) break;
          const inner = next.slice(indent[1]!.length);
          const km = inner.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
          if (km) {
            const v = km[2] ?? "";
            obj[km[1]!] = parseScalar(v);
          }
          i++;
        }
        out[key] = obj;
        parsedAnything = true;
        continue;
      }
      // Empty value with no continuation — record as empty string.
      out[key] = "";
      i++;
      parsedAnything = true;
      continue;
    }

    // Plain scalar with a quoted-fallback path for awkward values.
    out[key] = parseScalarLenient(inline);
    parsedAnything = true;
    i++;
  }

  if (!parsedAnything && yaml.trim().length > 0) return null;
  return out;
}

function parseScalar(v: string): Scalar {
  const stripped = stripQuotes(v.trim());
  if (stripped === "true") return true;
  if (stripped === "false") return false;
  if (/^-?\d+$/.test(stripped)) return Number(stripped);
  if (/^-?\d+\.\d+$/.test(stripped)) return Number(stripped);
  return stripped;
}

/** Quoted-value fallback: if a bare scalar contains characters that would
 *  normally trip a strict YAML parser (colons, hashes, etc.) we still keep
 *  the raw value rather than failing. */
function parseScalarLenient(v: string): string {
  const trimmed = v.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return JSON.parse(trimmed) as string;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  // Strip a trailing inline `# comment`.
  const noComment = trimmed.replace(/\s+#.*$/, "");
  return noComment;
}

function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s) as string; } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function strField(fm: FmObject, key: string): string | undefined {
  const v = fm[key];
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function listField(fm: FmObject, key: string): string[] | undefined {
  const v = fm[key];
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string" && v.trim()) {
    return v.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}

function objField(fm: FmObject, key: string): Record<string, unknown> | undefined {
  const v = fm[key];
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

/** Helper for callers that want the canonical resolved cwd path. */
export function resolveCwd(cwd: string): string {
  return resolve(cwd);
}
