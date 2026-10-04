import { readdirSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { SkillRecord } from "./types.js";

/** Per-language config-file fingerprints. The presence of any of these at
 *  the top level of the cwd nudges discovery toward the matching skills. */
const LANG_MARKERS: Record<string, { language: string; tokens: string[] }> = {
  "package.json": { language: "javascript", tokens: ["node", "npm", "javascript", "typescript"] },
  "tsconfig.json": { language: "typescript", tokens: ["typescript", "ts"] },
  "Cargo.toml": { language: "rust", tokens: ["rust", "cargo"] },
  "Cargo.lock": { language: "rust", tokens: ["rust", "cargo"] },
  "go.mod": { language: "go", tokens: ["go", "golang"] },
  "go.sum": { language: "go", tokens: ["go", "golang"] },
  "pyproject.toml": { language: "python", tokens: ["python", "pip", "poetry"] },
  "requirements.txt": { language: "python", tokens: ["python", "pip"] },
  "Pipfile": { language: "python", tokens: ["python", "pipenv"] },
  "Gemfile": { language: "ruby", tokens: ["ruby", "rails", "bundler"] },
  "composer.json": { language: "php", tokens: ["php", "composer"] },
  "build.gradle": { language: "kotlin", tokens: ["kotlin", "gradle", "java"] },
  "build.gradle.kts": { language: "kotlin", tokens: ["kotlin", "gradle"] },
  "pom.xml": { language: "java", tokens: ["java", "maven"] },
};

/** Config files that aren't language-defining but do strongly hint at the
 *  *kind* of work happening here. Maps file → tokens to add to the
 *  signature. Order doesn't matter; presence does. */
const TOOL_MARKERS: Record<string, string[]> = {
  "wrangler.toml": ["cloudflare", "worker", "wrangler"],
  "wrangler.jsonc": ["cloudflare", "worker", "wrangler"],
  "wrangler.json": ["cloudflare", "worker", "wrangler"],
  "next.config.js": ["next", "nextjs", "react"],
  "next.config.mjs": ["next", "nextjs", "react"],
  "next.config.ts": ["next", "nextjs", "react"],
  "vite.config.ts": ["vite", "frontend"],
  "vite.config.js": ["vite", "frontend"],
  "vitest.config.ts": ["vitest", "test"],
  "vitest.config.js": ["vitest", "test"],
  "jest.config.js": ["jest", "test"],
  "jest.config.ts": ["jest", "test"],
  "playwright.config.ts": ["playwright", "e2e", "test"],
  "playwright.config.js": ["playwright", "e2e", "test"],
  "pytest.ini": ["pytest", "test"],
  "Dockerfile": ["docker", "container"],
  "docker-compose.yml": ["docker", "compose"],
  "docker-compose.yaml": ["docker", "compose"],
  "kustomization.yaml": ["kubernetes", "k8s", "kustomize"],
  "skaffold.yaml": ["kubernetes", "k8s", "skaffold"],
  ".github": ["github", "ci"],
  ".gitlab-ci.yml": ["gitlab", "ci"],
  "terraform.tf": ["terraform", "iac"],
  "main.tf": ["terraform", "iac"],
  "Cargo.toml": ["rust", "cargo"],
};

/** Single-character / common-suffix extension → token mapping. */
const EXT_TOKENS: Record<string, string[]> = {
  ".ts": ["typescript", "ts"],
  ".tsx": ["typescript", "react", "tsx"],
  ".js": ["javascript", "js"],
  ".jsx": ["javascript", "react"],
  ".rs": ["rust"],
  ".go": ["go", "golang"],
  ".py": ["python"],
  ".rb": ["ruby"],
  ".java": ["java"],
  ".kt": ["kotlin"],
  ".swift": ["swift"],
  ".cs": ["csharp", "dotnet"],
  ".php": ["php"],
  ".sh": ["shell", "bash"],
  ".sql": ["sql", "database"],
  ".md": ["markdown", "docs"],
};

const SCAN_SKIP = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "target", "vendor"]);

export interface ProjectSignature {
  /** Sorted top-level filenames in cwd. */
  topLevelFiles: string[];
  /** Distinct file extensions found at the top two levels (lowercased, with leading dot). */
  extensions: string[];
  /** Primary language inferred from markers / extension counts; `null` when unclear. */
  primaryLanguage: string | null;
  /** All tokens contributed by markers + extensions (lowercased, deduped). */
  tokens: string[];
}

/** Inspect `cwd` for filesystem signals that hint at the project's stack
 *  and tooling. Cheap, synchronous, never recurses past depth 2 — this is
 *  meant to be called once per session, not per turn. Errors silently
 *  return an empty signature so a permission glitch never crashes
 *  discovery. */
export function extractProjectSignature(cwd: string): ProjectSignature {
  const topLevel = safeReaddir(cwd).sort();
  const tokens = new Set<string>();
  const extensions = new Set<string>();
  let primaryLanguage: string | null = null;

  for (const name of topLevel) {
    const lang = LANG_MARKERS[name];
    if (lang) {
      if (!primaryLanguage) primaryLanguage = lang.language;
      for (const t of lang.tokens) tokens.add(t);
    }
    const tool = TOOL_MARKERS[name];
    if (tool) for (const t of tool) tokens.add(t);
  }

  // Walk one level deeper to harvest file extensions; this matters for
  // mixed-stack repos where the top level is just configs.
  const extCounts = new Map<string, number>();
  const tally = (filename: string) => {
    const ext = extname(filename).toLowerCase();
    if (!ext) return;
    extensions.add(ext);
    extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    const tokenList = EXT_TOKENS[ext];
    if (tokenList) for (const t of tokenList) tokens.add(t);
  };
  for (const name of topLevel) {
    if (SCAN_SKIP.has(name) || name.startsWith(".")) continue;
    const path = `${cwd}/${name}`;
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(path);
    } catch {
      continue;
    }
    if (s.isFile()) {
      tally(name);
      continue;
    }
    if (s.isDirectory()) {
      for (const inner of safeReaddir(path)) tally(inner);
    }
  }

  // Tie-break primary language using extension counts when no marker won.
  if (!primaryLanguage) {
    let best: { ext: string; count: number } | null = null;
    for (const [ext, count] of extCounts) {
      if (!EXT_TOKENS[ext]) continue;
      if (!best || count > best.count) best = { ext, count };
    }
    if (best) primaryLanguage = EXT_TOKENS[best.ext]?.[0] ?? null;
  }

  return {
    topLevelFiles: topLevel,
    extensions: [...extensions].sort(),
    primaryLanguage,
    tokens: [...tokens].sort(),
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Lower-cased word tokens harvested from text. Strips common stopwords
 *  and short noise; keeps anything that could match a skill tag or
 *  description keyword. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_/.-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "with", "this", "that", "from", "you", "your",
  "have", "has", "had", "into", "what", "how", "why", "when", "where", "who",
  "can", "could", "should", "would", "may", "might", "will", "shall",
  "not", "all", "any", "any", "some", "one", "two", "more",
  "use", "using", "used", "make", "made", "want", "need", "needs",
  "yolo", "code", "claude",
]);

export interface HeuristicMatch {
  /** Skills that matched at least one signal. */
  candidates: SkillRecord[];
  /** name → tokens that matched (for diagnostics). */
  matched: Map<string, string[]>;
}

/** Score each record against the signature + recent-message tokens, keep
 *  records with at least one match. Token sources for a skill:
 *   - `metadata.tags` (each tag is a token verbatim)
 *   - lower-cased words in `description`
 *   - the skill `name` itself, split on `-` */
export function heuristicMatch(
  records: SkillRecord[],
  signature: ProjectSignature,
  recentMessages: string[],
): HeuristicMatch {
  const haystack = new Set<string>();
  for (const t of signature.tokens) haystack.add(t);
  for (const ext of signature.extensions) haystack.add(ext.replace(/^\./, ""));
  for (const file of signature.topLevelFiles) haystack.add(file.toLowerCase());
  for (const msg of recentMessages) for (const w of tokenize(msg)) haystack.add(w);
  if (signature.primaryLanguage) haystack.add(signature.primaryLanguage.toLowerCase());

  const matched = new Map<string, string[]>();
  const candidates: SkillRecord[] = [];
  for (const r of records) {
    const skillTokens = skillTokensOf(r);
    const hits = skillTokens.filter((t) => haystack.has(t));
    if (hits.length > 0) {
      candidates.push(r);
      matched.set(r.name, hits);
    }
  }
  return { candidates, matched };
}

function skillTokensOf(r: SkillRecord): string[] {
  const out = new Set<string>();
  for (const part of r.name.split("-")) if (part) out.add(part.toLowerCase());
  for (const w of tokenize(r.description)) out.add(w);
  const tags = (r.metadata?.tags as unknown) as string[] | undefined;
  if (Array.isArray(tags)) {
    for (const tag of tags) if (typeof tag === "string") out.add(tag.toLowerCase());
  }
  return [...out];
}
