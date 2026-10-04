import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { loadAllSkillsWithMeta, parseSkillFile } from "../skills/loader.js";
import { addTrusted, readTrusted, removeTrusted } from "../skills/trust.js";
import { pinDisable, pinEnable, pinClear, readPins } from "../skills/pins.js";
import { clearDiscoveryCache, discoveryCachePath } from "../skills/discovery.js";

const DEFAULT_REGISTRY_URL =
  "https://raw.githubusercontent.com/yolo-labs-hq/yolo-skills-registry/main/registry.json";
const DEFAULT_REGISTRY_TARBALL =
  "https://github.com/yolo-labs-hq/yolo-skills-registry/archive/refs/heads/main.tar.gz";

/** Resolve the registry index URL: env override > default. */
function registryUrl(): string {
  return process.env.YOLO_SKILLS_REGISTRY_URL || DEFAULT_REGISTRY_URL;
}

function registryTarballUrl(): string {
  // Allow a single env override for both index + tarball when self-hosting.
  const override = process.env.YOLO_SKILLS_REGISTRY_TARBALL_URL;
  return override || DEFAULT_REGISTRY_TARBALL;
}

/** Resolve the per-commit tarball URL for version-pinned installs. Mirrors
 *  GitHub's `archive/<commitSha>.tar.gz` shape; honors the same env override
 *  pattern (`YOLO_SKILLS_REGISTRY_TARBALL_URL_TEMPLATE` lets self-hosters
 *  swap the prefix for a private mirror). */
function registryTarballUrlForCommit(commitSha: string): string {
  const template = process.env.YOLO_SKILLS_REGISTRY_TARBALL_URL_TEMPLATE;
  if (template) {
    // Templates use `${commitSha}` as the placeholder. Falling back to
    // tail-replace if the placeholder is absent (so a private mirror
    // that uses path-style refs can just supply the full URL with the
    // sha appended elsewhere).
    return template.includes("${commitSha}")
      ? template.replace("${commitSha}", commitSha)
      : `${template.replace(/\/$/, "")}/${commitSha}.tar.gz`;
  }
  return `https://github.com/yolo-labs-hq/yolo-skills-registry/archive/${commitSha}.tar.gz`;
}

/** Parse `<name>@<version>` or `<name>` into `{ name, version }`. The empty
 *  string is rejected by the caller; here we just split the two halves. */
export function parseSkillTarget(target: string): { name: string; version: string | null } {
  const at = target.indexOf("@");
  if (at < 0) return { name: target, version: null };
  return { name: target.slice(0, at), version: target.slice(at + 1) };
}

function userSkillsDir(): string {
  return join(homedir(), ".config", "yolo-code", "skills");
}

function loadCatalog(cwd: string): ReturnType<typeof loadAllSkillsWithMeta> {
  // For CLI use, bypass the trust gate so `yolo-code skills list` from inside a
  // project shows what's there even if the user hasn't trusted it yet.
  // The trust gate still applies to the *interactive* session — this is a
  // read-only diagnostic surface.
  return loadAllSkillsWithMeta({ cwd, trusted: true });
}

/* --------------------------------- list -------------------------------- */

export async function skillsList(): Promise<number> {
  const cwd = process.cwd();
  const result = loadCatalog(cwd);
  const records = result.catalog.list();
  const pins = readPins();
  if (records.length === 0) {
    process.stdout.write(
      "(no skills found — install one with `yolo-code skills install <name>` or drop a SKILL.md in .yolo/skills/)\n",
    );
    if (result.untrustedProjectRoots.length > 0) {
      process.stdout.write(
        `note: project skills exist at ${result.untrustedProjectRoots[0]} but the cwd is not trusted; run \`yolo-code skills trust ${cwd}\`\n`,
      );
    }
    return 0;
  }
  const nameWidth = Math.max(4, ...records.map((r) => r.name.length));
  process.stdout.write(`${"NAME".padEnd(nameWidth)}  SCOPE     PIN  DESCRIPTION\n`);
  for (const r of records.sort((a, b) => a.name.localeCompare(b.name))) {
    const pin = pins.disabled.includes(r.name)
      ? "off"
      : pins.enabled.includes(r.name)
        ? "on "
        : "   ";
    const desc = r.description.length > 80 ? r.description.slice(0, 77) + "..." : r.description;
    process.stdout.write(`${r.name.padEnd(nameWidth)}  ${r.scope.padEnd(8)}  ${pin}  ${desc}\n`);
  }
  for (const w of result.warnings) process.stderr.write(`warn: ${w}\n`);
  return 0;
}

/* --------------------------------- info -------------------------------- */

export async function skillsInfo(name: string): Promise<number> {
  const cwd = process.cwd();
  const result = loadCatalog(cwd);
  const r = result.catalog.get(name);
  if (!r) {
    process.stderr.write(`yolo-code skills info: no skill named "${name}"\n`);
    const others = result.catalog.list().map((x) => x.name).sort();
    if (others.length > 0) process.stderr.write(`available: ${others.join(", ")}\n`);
    return 1;
  }
  process.stdout.write(`name:        ${r.name}\n`);
  process.stdout.write(`scope:       ${r.scope}\n`);
  process.stdout.write(`path:        ${r.path}\n`);
  if (r.license) process.stdout.write(`license:     ${r.license}\n`);
  if (r.compatibility) process.stdout.write(`compat:      ${r.compatibility}\n`);
  if (r.allowedTools && r.allowedTools.length > 0) {
    process.stdout.write(`tools:       ${r.allowedTools.join(", ")}\n`);
  }
  if (r.metadata && Object.keys(r.metadata).length > 0) {
    process.stdout.write(`metadata:    ${JSON.stringify(r.metadata)}\n`);
  }
  process.stdout.write(`description: ${r.description}\n`);
  process.stdout.write(`\n--- body (${r.body.length} chars) ---\n`);
  process.stdout.write(r.body);
  if (!r.body.endsWith("\n")) process.stdout.write("\n");
  return 0;
}

/* ------------------------------ validate ------------------------------ */

export async function skillsValidate(target?: string): Promise<number> {
  // Two modes:
  //  - `yolo-code skills validate` — re-parse every loaded SKILL.md, report warnings/errors
  //  - `yolo-code skills validate <path>` — parse one SKILL.md (or directory containing one)
  if (target) {
    const path = resolveSkillPath(target);
    if (!path) {
      process.stderr.write(`yolo-code skills validate: no SKILL.md at ${target}\n`);
      return 1;
    }
    const result = parseSkillFile(path);
    if ("error" in result) {
      process.stderr.write(`error: ${result.error}\n`);
      return 1;
    }
    for (const w of result.warnings) process.stdout.write(`warn: ${w}\n`);
    process.stdout.write(`ok: ${result.record.name}  (${result.record.description.length} char description)\n`);
    return 0;
  }
  const cwd = process.cwd();
  const result = loadCatalog(cwd);
  let errors = 0;
  for (const w of result.warnings) {
    process.stdout.write(`warn: ${w}\n`);
  }
  // Re-parse each loaded skill explicitly so structural errors surface
  // even when loadAllSkills swallowed them as "skipped".
  for (const r of result.catalog.list()) {
    const re = parseSkillFile(r.path);
    if ("error" in re) {
      process.stderr.write(`error: ${r.path}: ${re.error}\n`);
      errors++;
      continue;
    }
    process.stdout.write(`ok:   ${re.record.name}  (${r.scope}, ${re.warnings.length} warning${re.warnings.length === 1 ? "" : "s"})\n`);
  }
  return errors > 0 ? 1 : 0;
}

function resolveSkillPath(target: string): string | null {
  const abs = resolve(target);
  let s: ReturnType<typeof statSync>;
  try {
    s = statSync(abs);
  } catch {
    return null;
  }
  if (s.isFile()) return abs;
  if (s.isDirectory()) {
    const candidate = join(abs, "SKILL.md");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* fall through */ }
  }
  return null;
}

/* --------------------------- enable / disable -------------------------- */

export async function skillsEnable(name: string): Promise<number> {
  if (!name) {
    process.stderr.write("yolo-code skills enable: missing skill name\n");
    return 2;
  }
  pinEnable(name);
  process.stdout.write(`enabled (pinned on): ${name}\n`);
  return 0;
}

export async function skillsDisable(name: string): Promise<number> {
  if (!name) {
    process.stderr.write("yolo-code skills disable: missing skill name\n");
    return 2;
  }
  pinDisable(name);
  process.stdout.write(`disabled (pinned off): ${name}\n`);
  return 0;
}

export async function skillsClearPin(name: string): Promise<number> {
  if (!name) {
    process.stderr.write("yolo-code skills clear: missing skill name\n");
    return 2;
  }
  pinClear(name);
  process.stdout.write(`cleared pin: ${name}\n`);
  return 0;
}

/* ---------------------------- trust / untrust -------------------------- */

export async function skillsTrust(target?: string): Promise<number> {
  const cwd = resolve(target ?? process.cwd());
  if (!existsSync(cwd)) {
    process.stderr.write(`yolo-code skills trust: no such directory: ${cwd}\n`);
    return 1;
  }
  addTrusted(cwd);
  process.stdout.write(`trusted: ${cwd}\n`);
  process.stdout.write(`project-level skills under this directory will load automatically.\n`);
  return 0;
}

export async function skillsUntrust(target?: string): Promise<number> {
  const cwd = resolve(target ?? process.cwd());
  removeTrusted(cwd);
  process.stdout.write(`untrusted: ${cwd}\n`);
  return 0;
}

export async function skillsTrustList(): Promise<number> {
  const list = readTrusted();
  if (list.length === 0) {
    process.stdout.write("(no trusted projects)\n");
    return 0;
  }
  for (const p of list) process.stdout.write(`${p}\n`);
  return 0;
}

/* -------------------------------- install ------------------------------ */

interface RegistryVersionEntry {
  /** Semver string, e.g. "1.3.0". */
  version: string;
  /** Full commit SHA on the registry repo where this version was published.
   *  yolo-code fetches `archive/<commitSha>.tar.gz` for version-pinned installs
   *  so the install is reproducible across registry main-branch movement. */
  commitSha: string;
  /** ISO 8601 timestamp the version was published. */
  publishedAt: string;
}

interface RegistryIndex {
  version?: number;
  skills?: Record<
    string,
    {
      description?: string;
      path?: string;
      /** Legacy single-version field. New registries also include
       *  `latestVersion` + `versions[]`; old clients still read `version`. */
      version?: string;
      /** Substrate item: version pinning. Points at the most recent
       *  entry in `versions[]`. `yolo-code skills install <name>`
       *  (no @ver) resolves to this when present. */
      latestVersion?: string;
      /** Substrate item: version pinning. Per-version commit refs so
       *  the install path can fetch a specific commit's tarball. */
      versions?: RegistryVersionEntry[];
      license?: string;
      tags?: string[];
      endorsed?: boolean;
      /** Optional upstream source URL (for skills lifted from other
       *  agents' registries — surfaced in the SkillBrowser detail pane). */
      source?: string;
    }
  >;
}

/** Output sink — lets install/uninstall serve both the CLI (process stdio)
 *  and the in-session slash command (text buffer) without duplicating logic. */
interface Writer {
  out: (s: string) => void;
  err: (s: string) => void;
}

const stdioWriter: Writer = {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
};

function bufferWriter(): { writer: Writer; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    writer: { out: (s) => lines.push(s), err: (s) => lines.push(s) },
  };
}

export interface SkillsInstallResult {
  ok: boolean;
  text: string;
}

/** Install a skill by name (registry lookup) or URL (tarball/git). Returns
 *  collected output text for slash-command rendering. The CLI wrapper
 *  `skillsInstall` writes to stdio and returns an exit code. */
export async function skillsInstallReport(target: string): Promise<SkillsInstallResult> {
  const { writer, lines } = bufferWriter();
  const ok = await runInstall(target, writer);
  return { ok, text: lines.join("\n") };
}

export async function skillsInstall(target: string): Promise<number> {
  const ok = await runInstall(target, stdioWriter);
  return ok ? 0 : 1;
}

async function runInstall(target: string, w: Writer): Promise<boolean> {
  if (!target) {
    w.err("skills install: missing <name>[@<version>] | <git-url>");
    return false;
  }
  // git URL / tarball URL path. We accept anything that looks like a URL
  // and let the fetcher fail loudly if it doesn't resolve. Version pinning
  // (`@<version>`) only applies to registry-name installs.
  if (/^https?:\/\//.test(target) || target.endsWith(".git")) {
    return installFromUrl(target, w);
  }
  // Otherwise treat as a registry name lookup, optionally with an @version
  // pin: `example-skill@1.3.0` or `example-skill` (= latest).
  const { name, version } = parseSkillTarget(target);
  if (!name) {
    w.err("skills install: missing <name> before @");
    return false;
  }
  return installFromRegistry(name, version, w);
}

async function installFromRegistry(
  name: string,
  requestedVersion: string | null,
  w: Writer,
): Promise<boolean> {
  const indexUrl = registryUrl();
  let index: RegistryIndex;
  try {
    index = await fetchJson<RegistryIndex>(indexUrl);
  } catch (e) {
    w.err(`skills install: could not fetch registry index from ${indexUrl}: ${(e as Error).message}`);
    w.err("set YOLO_SKILLS_REGISTRY_URL to override, or pass a git/tarball URL directly.");
    return false;
  }
  const entry = index.skills?.[name];
  if (!entry || !entry.path) {
    w.err(`skills install: "${name}" not found in registry (${indexUrl})`);
    if (index.skills) {
      const known = Object.keys(index.skills).sort();
      if (known.length > 0) w.err(`available: ${known.join(", ")}`);
    }
    return false;
  }

  // Resolve the tarball URL.
  //
  //   - Pinned (`<name>@<version>`): look up `version` in `versions[]`,
  //     fetch that commit's tarball. Hard-fails if the version isn't
  //     listed — operators need an explicit error, not silent fallback
  //     to latest.
  //   - Unpinned (`<name>`): if the registry exposes `latestVersion` and
  //     a matching `versions[]` entry, prefer that commit-pinned URL
  //     for reproducibility (every new boot lands on the same content
  //     unless `latestVersion` itself moves). Falls back to
  //     `archive/refs/heads/main.tar.gz` for registries that haven't
  //     yet adopted the versions schema.
  let tarballUrl: string;
  let resolvedVersion: string | null = null;
  if (requestedVersion) {
    const versions = entry.versions ?? [];
    const match = versions.find((v) => v.version === requestedVersion);
    if (!match) {
      w.err(
        `skills install: version "${requestedVersion}" of "${name}" not found in registry. ` +
          (versions.length > 0
            ? `Available: ${versions.map((v) => v.version).join(", ")}`
            : "Registry does not publish version history for this skill — drop the @<version> suffix to install latest."),
      );
      return false;
    }
    tarballUrl = registryTarballUrlForCommit(match.commitSha);
    resolvedVersion = match.version;
  } else if (entry.latestVersion) {
    const match = (entry.versions ?? []).find((v) => v.version === entry.latestVersion);
    if (match) {
      tarballUrl = registryTarballUrlForCommit(match.commitSha);
      resolvedVersion = match.version;
    } else {
      // Inconsistent registry — `latestVersion` set but the matching
      // `versions[]` entry is missing. Surface the gap rather than
      // installing something different than the registry advertises.
      w.err(
        `skills install: registry advertises latestVersion="${entry.latestVersion}" for "${name}" but versions[] has no matching commitSha. Registry needs republishing — falling back to main-branch tarball.`,
      );
      tarballUrl = registryTarballUrl();
    }
  } else {
    // Legacy registry (no versions[] field at all). Use the main-branch
    // tarball — same behavior as before the version-pinning feature.
    tarballUrl = registryTarballUrl();
  }

  // Fetch the registry tarball, extract just `${entry.path}/`, and copy
  // it to ~/.config/yolo-code/skills/<name>/.
  const ok = await installSubdirFromTarball(tarballUrl, entry.path, name, w);
  if (ok && resolvedVersion) {
    w.out(`  resolved version: ${resolvedVersion}`);
  }
  return ok;
}

async function installFromUrl(url: string, w: Writer): Promise<boolean> {
  // For arbitrary URLs we treat the whole download as the skill payload —
  // the user is expected to point at a tarball whose top-level dir is
  // `<name>/SKILL.md`. We pick the install name from the URL's last path
  // segment, stripped of common archive suffixes.
  const guessedName = url
    .split("/")
    .filter(Boolean)
    .pop()!
    .replace(/\.tar\.gz$|\.tgz$|\.git$/, "");
  if (!guessedName) {
    w.err(`skills install: cannot infer skill name from ${url}`);
    return false;
  }
  // For a tarball that *is* the skill, the inner path is "" — meaning
  // installSubdirFromTarball will treat the whole archive root as the skill.
  return installSubdirFromTarball(url, "", guessedName, w);
}

/** Stale-lock reap window. Anything older than this is assumed dead
 *  (Node has crashed, container OOM'd, …). */
const INSTALL_LOCK_STALE_MS = 5 * 60 * 1000;

type LockResult =
  | { kind: "acquired"; release: () => void }
  | { kind: "contended" }
  | { kind: "error"; error: Error };

/** Advisory cross-process lock for the install of a single skill name.
 *  The bootstrap script and the in-app lazy-install both run
 *  `yolo-code skills install <name>` against the same `userSkillsDir()`;
 *  without this lock the rmSync/renameSync at the tail of
 *  installSubdirFromTarball can race and throw EEXIST/ENOTEMPTY.
 *
 *  Returns a tagged result so callers can distinguish real contention
 *  (EEXIST) from unrelated filesystem errors (EACCES, ENOSPC, EROFS,
 *  …) — masking those as contention would make installs silently
 *  unfixable in restricted environments. */
function acquireInstallLock(name: string): LockResult {
  const dir = userSkillsDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { kind: "error", error: err as Error };
  }
  const lockPath = join(dir, `.install-${name}.lock`);
  try {
    const st = statSync(lockPath);
    if (Date.now() - st.mtimeMs > INSTALL_LOCK_STALE_MS) {
      rmSync(lockPath, { force: true });
    }
  } catch {
    // no lockfile, fall through to create
  }
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return { kind: "contended" };
    return { kind: "error", error: err as Error };
  }
  try {
    writeSync(fd, `${process.pid}\n`);
  } catch {
    // best-effort metadata — failure is non-fatal
  }
  closeSync(fd);
  return {
    kind: "acquired",
    release: () => {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // ignore — stale-lock reap will catch leftovers on next install
      }
    },
  };
}

/** Download `tarballUrl`, extract `subdir` (relative to the archive root,
 *  after stripping the conventional GitHub `<repo>-<ref>/` top dir), and
 *  drop the result at `~/.config/yolo-code/skills/<name>/`. Replaces any
 *  existing install. */
async function installSubdirFromTarball(
  tarballUrl: string,
  subdir: string,
  name: string,
  w: Writer,
): Promise<boolean> {
  // Advisory lock prevents two concurrent installs of the same skill from
  // racing the rmSync/renameSync below. Bootstrap-script + in-app lazy
  // install can otherwise both fire on first-ever session start.
  // EEXIST → contention (clean message); other errors (EACCES, ENOSPC,
  // EROFS, …) surface so the user can actually diagnose.
  const lock = acquireInstallLock(name);
  if (lock.kind === "contended") {
    w.err(`skills install: another install of "${name}" is in progress`);
    return false;
  }
  if (lock.kind === "error") {
    w.err(`skills install: could not acquire install lock for "${name}": ${lock.error.message}`);
    return false;
  }
  const release = lock.release;
  try {
    const dest = join(userSkillsDir(), name);
    const work = mkdtempSyncSafe();
    const tarPath = join(work, "archive.tar.gz");

    try {
      await downloadToFile(tarballUrl, tarPath);
    } catch (e) {
      rmSync(work, { recursive: true, force: true });
      w.err(`skills install: download failed: ${(e as Error).message}`);
      return false;
    }

    const extractDir = join(work, "x");
    mkdirSync(extractDir, { recursive: true });
    try {
      await runTar(["-xzf", tarPath, "-C", extractDir]);
    } catch (e) {
      rmSync(work, { recursive: true, force: true });
      w.err(`skills install: tar extract failed: ${(e as Error).message}`);
      return false;
    }

    // GitHub tarballs wrap the contents in a `<repo>-<ref>/` directory. Find
    // and step into the single top-level dir if present.
    let root = extractDir;
    const top = readdirSync(extractDir);
    if (top.length === 1) {
      const single = join(extractDir, top[0]!);
      if (statSync(single).isDirectory()) root = single;
    }

    const sourcePath = subdir ? join(root, subdir) : root;
    if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
      rmSync(work, { recursive: true, force: true });
      w.err(`skills install: archive does not contain ${subdir || "(root)"}`);
      return false;
    }
    // Sanity check: SKILL.md must exist in the install root.
    if (!existsSync(join(sourcePath, "SKILL.md"))) {
      rmSync(work, { recursive: true, force: true });
      w.err(`skills install: ${sourcePath} does not contain SKILL.md`);
      return false;
    }

    // Validate the SKILL.md before clobbering the install dir.
    const parse = parseSkillFile(join(sourcePath, "SKILL.md"));
    if ("error" in parse) {
      rmSync(work, { recursive: true, force: true });
      w.err(`skills install: invalid SKILL.md (${parse.error})`);
      return false;
    }

    mkdirSync(userSkillsDir(), { recursive: true });
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    try {
      renameSync(sourcePath, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        cpSync(sourcePath, dest, { recursive: true });
      } else {
        throw err;
      }
    }
    rmSync(work, { recursive: true, force: true });

    w.out(`installed ${name} → ${dest}`);
    for (const warning of parse.warnings) w.out(`  warn: ${warning}`);
    return true;
  } finally {
    release();
  }
}

/* --------------------------------- uninstall --------------------------- */

export async function skillsUninstallReport(name: string): Promise<SkillsInstallResult> {
  const { writer, lines } = bufferWriter();
  const ok = runUninstall(name, writer);
  return { ok, text: lines.join("\n") };
}

export async function skillsUninstall(name: string): Promise<number> {
  const ok = runUninstall(name, stdioWriter);
  return ok ? 0 : 1;
}

function runUninstall(name: string, w: Writer): boolean {
  if (!name) {
    w.err("skills uninstall: missing skill name");
    return false;
  }
  const dest = join(userSkillsDir(), name);
  if (!existsSync(dest)) {
    w.err(`skills uninstall: not installed: ${name}`);
    return false;
  }
  rmSync(dest, { recursive: true, force: true });
  w.out(`uninstalled ${name}`);
  return true;
}

/* --------------------------------- browse ------------------------------ */

const REGISTRY_CACHE_TTL_MS = 10 * 60 * 1000;

function registryCachePath(): string {
  return join(homedir(), ".config", "yolo-code", "skills-registry-cache.json");
}

interface RegistryCacheFile {
  fetchedAt: number;
  url: string;
  index: RegistryIndex;
}

async function fetchRegistryIndex(opts: { refresh?: boolean } = {}): Promise<RegistryIndex> {
  const url = registryUrl();
  const cachePath = registryCachePath();
  if (!opts.refresh && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as RegistryCacheFile;
      if (cached.url === url && Date.now() - cached.fetchedAt < REGISTRY_CACHE_TTL_MS) {
        return cached.index;
      }
    } catch {
      // Corrupted cache — fall through and re-fetch.
    }
  }
  const index = await fetchJson<RegistryIndex>(url);
  try {
    mkdirSync(join(homedir(), ".config", "yolo-code"), { recursive: true });
    const payload: RegistryCacheFile = { fetchedAt: Date.now(), url, index };
    writeFileSync(cachePath, JSON.stringify(payload, null, 2));
  } catch {
    // Best-effort cache; keep going if disk write fails.
  }
  return index;
}

export interface SkillsBrowseOptions {
  query?: string;
  refresh?: boolean;
  /** Where the output is rendered — switches the footer install hint
   *  between the CLI command and the in-session slash command. */
  context?: "cli" | "slash";
  /** Test seam: inject a fetcher to bypass the network. */
  fetcher?: () => Promise<RegistryIndex>;
}

export interface SkillsBrowseResult {
  ok: boolean;
  text: string;
}

/** Structured per-entry shape the interactive SkillBrowser TUI consumes.
 *  Same data the text-mode `skillsBrowse` walks, surfaced as a typed
 *  list so the UI can render a detail pane (tags, license, version)
 *  next to the cursor highlight. */
export interface SkillBrowserEntry {
  name: string;
  description: string;
  tags: string[];
  endorsed: boolean;
  license?: string;
  version?: string;
  source?: string;
  /** True iff a SKILL.md is currently loadable at user or registry scope. */
  installed: boolean;
}

export interface SkillBrowserState {
  entries: SkillBrowserEntry[];
  /** Total registry entries before any filter (UI shows "X of Y match"). */
  total: number;
  /** Non-null when the registry fetch failed; UI shows the error
   *  inline instead of an empty list. */
  error: string | null;
}

/** Load the data the interactive SkillBrowser renders: registry entries
 *  + currently-installed status, in one call. Network errors are returned
 *  as a value so the UI can render an "offline" state instead of throwing. */
export async function loadSkillBrowserState(opts: {
  refresh?: boolean;
  fetcher?: () => Promise<RegistryIndex>;
} = {}): Promise<SkillBrowserState> {
  let index: RegistryIndex;
  try {
    index = await (opts.fetcher ? opts.fetcher() : fetchRegistryIndex({ refresh: opts.refresh }));
  } catch (e) {
    return {
      entries: [],
      total: 0,
      error: `${registryUrl()}: ${(e as Error).message}`,
    };
  }
  const installedNames = new Set<string>();
  try {
    const result = loadCatalog(process.cwd());
    for (const r of result.catalog.list()) {
      if (r.scope === "registry" || r.scope === "user") installedNames.add(r.name);
    }
  } catch {
    // Catalog load is best-effort — registry browsing should still work.
  }
  const skills = index.skills ?? {};
  const entries: SkillBrowserEntry[] = Object.entries(skills)
    .map(([name, e]) => ({
      name,
      description: e.description ?? "",
      tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === "string") : [],
      endorsed: e.endorsed === true,
      license: typeof e.license === "string" ? e.license : undefined,
      version: typeof e.latestVersion === "string"
        ? e.latestVersion
        : typeof e.version === "string"
          ? e.version
          : undefined,
      source: typeof e.source === "string" ? e.source : undefined,
      installed: installedNames.has(name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { entries, total: entries.length, error: null };
}

/** Print the registry catalog with installed-status, optionally filtered by query.
 *  Returns formatted text + ok flag so the same helper backs both the CLI and
 *  the in-session `/skills browse` slash command. */
export async function skillsBrowse(opts: SkillsBrowseOptions = {}): Promise<SkillsBrowseResult> {
  let index: RegistryIndex;
  try {
    index = await (opts.fetcher ? opts.fetcher() : fetchRegistryIndex({ refresh: opts.refresh }));
  } catch (e) {
    return {
      ok: false,
      text:
        `could not fetch registry index from ${registryUrl()}: ${(e as Error).message}\n` +
        `set YOLO_SKILLS_REGISTRY_URL to override.`,
    };
  }
  const skills = index.skills ?? {};
  const installedNames = new Set<string>();
  try {
    const result = loadCatalog(process.cwd());
    for (const r of result.catalog.list()) {
      if (r.scope === "registry" || r.scope === "user") installedNames.add(r.name);
    }
  } catch {
    // Catalog load is best-effort — browsing should still work.
  }
  const q = (opts.query ?? "").trim().toLowerCase();
  const entries = Object.entries(skills)
    .filter(([name, e]) => {
      if (!q) return true;
      const hay = [name, e.description ?? "", ...(e.tags ?? [])].join(" ").toLowerCase();
      return hay.includes(q);
    })
    .sort(([a], [b]) => a.localeCompare(b));
  const total = Object.keys(skills).length;
  if (entries.length === 0) {
    const browseHint = opts.context === "slash"
      ? "/skills browse"
      : "yolo-code skills search";
    const text = q
      ? `no skills match "${q}" — registry has ${total} skill${total === 1 ? "" : "s"} (run \`${browseHint}\` with no query to list all)`
      : "registry is empty";
    return { ok: true, text };
  }
  const nameWidth = Math.max(4, ...entries.map(([n]) => n.length));
  const lines: string[] = [];
  lines.push(`${"NAME".padEnd(nameWidth)}  STATUS     DESCRIPTION`);
  for (const [name, e] of entries) {
    const status = installedNames.has(name) ? "installed" : e.endorsed ? "endorsed " : "available";
    const raw = e.description ?? "";
    const desc = raw.length > 80 ? raw.slice(0, 77) + "..." : raw;
    lines.push(`${name.padEnd(nameWidth)}  ${status}  ${desc}`);
  }
  lines.push("");
  const installHint = opts.context === "slash"
    ? "/skills install <name>"
    : "yolo-code skills install <name>";
  lines.push(
    q
      ? `${entries.length} of ${total} match — install with \`${installHint}\``
      : `${total} skill${total === 1 ? "" : "s"} — install with \`${installHint}\``,
  );
  return { ok: true, text: lines.join("\n") };
}

/** CLI thin wrapper around skillsBrowse — prints text and returns an exit code. */
export async function skillsSearch(query?: string, opts: { refresh?: boolean } = {}): Promise<number> {
  const r = await skillsBrowse({ query, refresh: opts.refresh });
  (r.ok ? process.stdout : process.stderr).write(r.text + "\n");
  return r.ok ? 0 : 1;
}

/* ---------------------------- discovery-clear -------------------------- */

export async function skillsDiscoveryClear(): Promise<number> {
  clearDiscoveryCache();
  process.stdout.write(`cleared skill-discovery cache (${discoveryCachePath()})\n`);
  return 0;
}

/* --------------------------------- helpers ----------------------------- */

// Network timeouts. Without these the install hangs indefinitely if the
// registry (raw.githubusercontent.com / github.com) is slow, DNS stalls,
// or a redirect chain wedges mid-stream. Container boot calls
// `yolo-code skills install` from `bootstrap-yolo-code.sh`; before the
// timeouts landed (2026-05-13) a stuck fetch took the whole entrypoint
// down because `su - yolo -c "yolo-code skills install ..."` never
// returned. Env overrides let operators tighten or loosen per pod.
//
// Round 2 (codex review on bf76a6a5): the round-1 fix only timed
// `fetch()` itself, leaving `res.json()` unbounded and the body
// download on a fixed wall-clock budget that aborted healthy long
// transfers. Round 2 splits the budget into headers-only + body-
// inactivity so progress is measured by "bytes arriving" not "total
// elapsed time."
const REGISTRY_FETCH_TIMEOUT_MS =
  parseTimeoutEnv(process.env.YOLO_SKILLS_REGISTRY_TIMEOUT_MS, 15_000);
// Inactivity watchdog for the body stream. Resets every time a chunk
// arrives. A genuinely slow but progressing 100MB tarball completes
// fine; a stuck socket aborts after 30s of no bytes.
const REGISTRY_DOWNLOAD_INACTIVITY_MS =
  parseTimeoutEnv(process.env.YOLO_SKILLS_DOWNLOAD_INACTIVITY_MS, 30_000);

function parseTimeoutEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function fetchJson<T>(url: string): Promise<T> {
  // ONE AbortController for both the headers wait AND the body parse.
  // Codex P1 round 2: the earlier shape cleared the timer as soon as
  // `fetch()` resolved, leaving `res.json()` unbounded. A stalled
  // body read on the registry endpoint would still hang the install
  // forever even after the round-1 fix. Hold the timer through the
  // json read.
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), REGISTRY_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      throw new Error(`request timed out after ${REGISTRY_FETCH_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(handle);
  }
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  // Two-phase timeout structure:
  //  1. Headers wait — bounded by REGISTRY_FETCH_TIMEOUT_MS. Standard
  //     AbortController on the fetch() call.
  //  2. Body stream — bounded by an INACTIVITY watchdog
  //     (REGISTRY_DOWNLOAD_INACTIVITY_MS). Refreshed on every `data`
  //     event. Codex P2 round 2: a fixed wall-clock budget would
  //     abort a healthy slow-but-progressing transfer (e.g. a 100MB
  //     tarball on a low-bandwidth link); inactivity timeout measures
  //     "is the socket stalled" rather than "have we waited too long."
  const headersController = new AbortController();
  const headersTimer = setTimeout(() => headersController.abort(), REGISTRY_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: headersController.signal });
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      throw new Error(`request timed out after ${REGISTRY_FETCH_TIMEOUT_MS}ms (headers)`);
    }
    throw e;
  } finally {
    clearTimeout(headersTimer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  if (!res.body) throw new Error(`empty response body for ${url}`);

  const { Readable } = await import("node:stream");
  const src = Readable.fromWeb(res.body as never);

  // Inactivity watchdog: every chunk resets the timer.
  const bodyController = new AbortController();
  let inactivityTimer = setTimeout(
    () => bodyController.abort(),
    REGISTRY_DOWNLOAD_INACTIVITY_MS,
  );
  const refresh = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(
      () => bodyController.abort(),
      REGISTRY_DOWNLOAD_INACTIVITY_MS,
    );
  };
  src.on("data", refresh);

  try {
    await pipeline(src, createWriteStream(dest), { signal: bodyController.signal });
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      throw new Error(`download stalled (no progress for ${REGISTRY_DOWNLOAD_INACTIVITY_MS}ms)`);
    }
    throw e;
  } finally {
    clearTimeout(inactivityTimer);
    src.off("data", refresh);
  }
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => {
      err += String(d);
    });
    child.on("error", (e) => rejectP(e));
    child.on("exit", (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(err.trim() || `tar exited with code ${code}`));
    });
  });
}

function mkdtempSyncSafe(): string {
  return mkdtempSync(join(tmpdir(), "yolo-skills-"));
}

