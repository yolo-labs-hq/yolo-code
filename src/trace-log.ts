import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { rotateJsonl, RETENTION } from "./storage-limits.js";

const TRACE_LOG_VERSION = 3;

// Default size caps for preview/full payloads. Overridable via env so a user
// debugging a specific bad turn can crank them up without recompiling. The
// hard ceiling is `MAX_FULL_BYTES`: any structured payload past that gets
// truncated even when "full" is requested. Tracing is opt-in and goes to disk
// only, so generous defaults are fine.
const MAX_PREVIEW_BYTES = parseEnvInt("YOLO_CODE_TRACE_PREVIEW_BYTES", 2_000);
const MAX_FULL_BYTES = parseEnvInt("YOLO_CODE_TRACE_FULL_BYTES", 32_000);

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function traceEnabledFromEnv(): boolean {
  const raw = process.env.YOLO_CODE_TRACE?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

// Runtime mirror of the React state — non-React callers (MCP adapter, tool
// executor) read this so trace events from outside `<App/>` honor the
// `/trace on|off` toggle without each module needing its own ref.
let runtimeTraceEnabled = traceEnabledFromEnv();

export function setRuntimeTraceEnabled(enabled: boolean): void {
  runtimeTraceEnabled = enabled;
}

export function isTraceEnabled(): boolean {
  return runtimeTraceEnabled;
}

function traceDir(): string {
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdg, "yolo-code");
}

export function tracePath(): string {
  return join(traceDir(), "trace.jsonl");
}

export async function logTrace(entry: Record<string, unknown>): Promise<void> {
  await mkdir(traceDir(), { recursive: true });
  await rotateJsonl(tracePath(), RETENTION.costDebugMaxBytes, RETENTION.costDebugRotations);
  await appendFile(
    tracePath(),
    JSON.stringify({
      v: TRACE_LOG_VERSION,
      ts: new Date().toISOString(),
      cwd: process.cwd(),
      ...entry,
    }) + "\n",
    "utf8",
  );
}

// Fire-and-forget trace: returns immediately when tracing is off, and never
// throws. Use this everywhere outside the React tree where awaiting a disk
// write would muddy the call site.
export function traceEvent(event: string, data: Record<string, unknown> = {}): void {
  if (!runtimeTraceEnabled) return;
  void logTrace({ event, ...data }).catch(() => {
    /* tracing must never crash a turn */
  });
}

// --- Redaction --------------------------------------------------------------

// Conservative redaction targeted at the credentials yolo-code actually
// handles: bearer tokens, api keys/secrets in URLs, AWS-style keys, and JWT-
// looking strings. We replace, not remove, so the surrounding shape stays
// debuggable. Length and a short head/tail go in the replacement so a
// reviewer can spot "yes that's a token" without recovering it.
const REDACT_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b(Bearer\s+)([A-Za-z0-9_\-.=+/]{16,})/g, label: "Bearer" },
  { re: /\b(sk-(?:proj-|ant-|or-)?[A-Za-z0-9_\-]{20,})/g, label: "ApiKey" },
  { re: /\b(eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})/g, label: "JWT" },
  { re: /\b(AKIA[0-9A-Z]{16})\b/g, label: "AwsAccessKey" },
  { re: /\b(ghp_[A-Za-z0-9]{30,})/g, label: "GhToken" },
  { re: /\b(gho_[A-Za-z0-9]{30,})/g, label: "GhToken" },
  { re: /\b(ghs_[A-Za-z0-9]{30,})/g, label: "GhToken" },
  { re: /\b(github_pat_[A-Za-z0-9_]{22,})/g, label: "GhPat" },
  // URL-embedded credentials: https://user:secret@host
  { re: /(https?:\/\/[^/\s:@]+:)([^/\s@]+)(@)/g, label: "UrlPassword" },
  // ?token=, ?key=, ?api_key=, ?password= query strings
  { re: /([?&](?:token|key|api[_-]?key|password|secret|access_token|refresh_token)=)([^&\s"']+)/gi, label: "QueryParam" },
  // JSON-key-in-free-text: catches `"password": "..."` shapes embedded in
  // log lines, error messages, or malformed JSON that wouldn't parse
  // cleanly enough for the structured walker. Pairs with redactedPayload's
  // fall-through to safePreview when input isn't valid JSON.
  { re: /(["'](?:authorization|auth|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|secret|secret[_-]?key|password|passwd|token|id[_-]?token|client[_-]?secret|private[_-]?key|cookie|x[_-]api[_-]?key|x[_-]internal[_-]?auth)["']\s*:\s*["'])([^"']*)(["'])/gi, label: "JsonKeyText" },
];

const REDACT_JSON_KEYS = new Set([
  "authorization",
  "auth",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "secret",
  "secret_key",
  "password",
  "passwd",
  "token",
  "id_token",
  "client_secret",
  "private_key",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-internal-auth",
]);

export function redact(input: string): string {
  if (!input) return input;
  let out = input;
  for (const { re, label } of REDACT_PATTERNS) {
    out = out.replace(re, (match, ...rest) => {
      // String.prototype.replace passes: ...captureGroups, offset, fullString.
      // Strip the trailing offset+fullString so what remains is just the
      // captured groups. Single-group patterns get prefix="" and treat the
      // whole match as the secret.
      const groups = rest.slice(0, -2);
      const captured = groups.length > 0 ? (groups as (string | undefined)[]) : [match];
      const prefix = typeof captured[0] === "string" && captured.length > 1 ? captured[0] : "";
      const secret = captured.length > 1
        ? (typeof captured[1] === "string" ? captured[1] : match)
        : (typeof captured[0] === "string" ? captured[0] : match);
      const tail = captured.length > 2 && typeof captured[2] === "string" ? captured[2] : "";
      const headTail = secret.length > 8
        ? `${secret.slice(0, 2)}…${secret.slice(-2)}`
        : "…";
      return `${prefix}[redacted:${label} len=${secret.length} ${headTail}]${tail}`;
    });
  }
  return out;
}

function redactJsonValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value);
  if (typeof value !== "object") return value;
  if (depth > 8) return "[depth limit]";
  if (Array.isArray(value)) {
    return value.map((v) => redactJsonValue(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_JSON_KEYS.has(k.toLowerCase())) {
      out[k] = redactJsonKey(v);
    } else {
      out[k] = redactJsonValue(v, depth + 1);
    }
  }
  return out;
}

function redactJsonKey(v: unknown): unknown {
  if (typeof v === "string") {
    return `[redacted:JsonKey len=${v.length}]`;
  }
  if (v && typeof v === "object") return "[redacted:JsonKey object]";
  return "[redacted:JsonKey]";
}

// --- Preview ----------------------------------------------------------------

export interface PreviewResult {
  preview: string;
  fullLength: number;
  truncated: boolean;
}

export interface PreviewOptions {
  maxBytes?: number;
  redactSecrets?: boolean;
}

export function preview(value: string | undefined | null, opts: PreviewOptions = {}): PreviewResult {
  const s = value ?? "";
  const limit = opts.maxBytes ?? MAX_PREVIEW_BYTES;
  const redactOn = opts.redactSecrets !== false;
  const redacted = redactOn ? redact(s) : s;
  if (redacted.length <= limit) {
    return { preview: redacted, fullLength: redacted.length, truncated: false };
  }
  return {
    preview: redacted.slice(0, limit) + `… [+${redacted.length - limit} bytes]`,
    fullLength: redacted.length,
    truncated: true,
  };
}

// Returns either the full string (already redacted) when bounded, or a
// preview slice plus a `_truncated` marker. Callers pick the right size cap
// at the call site — defaults to `MAX_FULL_BYTES` so reviewers see whole
// tool outputs unless the payload is genuinely huge.
export function safePreview(
  value: string | undefined | null,
  opts: PreviewOptions = {},
): { full?: string; preview?: string; fullLength: number; truncated: boolean } {
  const s = value ?? "";
  const limit = opts.maxBytes ?? MAX_FULL_BYTES;
  const redactOn = opts.redactSecrets !== false;
  const redacted = redactOn ? redact(s) : s;
  if (redacted.length <= limit) {
    return { full: redacted, fullLength: redacted.length, truncated: false };
  }
  return {
    preview: redacted.slice(0, limit) + `… [+${redacted.length - limit} bytes]`,
    fullLength: redacted.length,
    truncated: true,
  };
}

// Best-effort JSON parse with redaction. Returns the redacted parsed object
// when input looks like JSON, otherwise `undefined`. Caller should fall back
// to `safePreview` for the textual form.
export function tryParseJsonRedacted(value: string | undefined | null): unknown | undefined {
  const s = (value ?? "").trim();
  if (!s) return undefined;
  if (s[0] !== "{" && s[0] !== "[") return undefined;
  try {
    return redactJsonValue(JSON.parse(s), 0);
  } catch {
    return undefined;
  }
}

// Walk-redact an already-parsed value (object/array/primitive). Exposed so
// callers that already have a structured payload (e.g. MCP
// `structuredContent`) can scrub it without re-serializing through
// `tryParseJsonRedacted`.
export function redactStructured(value: unknown): unknown {
  return redactJsonValue(value, 0);
}

// Size-capped variant of redactStructured. Mirrors redactedPayload's
// shape so an oversized structured payload can't bypass MAX_FULL_BYTES
// and bloat the trace file (an MCP plan-list response can carry hundreds
// of KB of structuredContent — inlining the whole thing into every
// mcp.result event would dwarf the rest of the trace).
export function redactedStructuredPayload(
  value: unknown,
  opts: PreviewOptions = {},
): {
  structured?: unknown;
  structuredJsonPreview?: string;
  structuredTopLevelKeys?: string[];
  structuredTruncated: boolean;
} {
  if (value === undefined) return { structuredTruncated: false };
  const redacted = redactStructured(value);
  const maxBytes = opts.maxBytes ?? MAX_FULL_BYTES;
  let serialized: string;
  try {
    serialized = JSON.stringify(redacted);
  } catch {
    return { structuredTruncated: false };
  }
  if (serialized.length <= maxBytes) {
    return { structured: redacted, structuredTruncated: false };
  }
  const structuredTopLevelKeys =
    redacted && typeof redacted === "object" && !Array.isArray(redacted)
      ? Object.keys(redacted as Record<string, unknown>)
      : undefined;
  return {
    structuredJsonPreview:
      serialized.slice(0, maxBytes) + `… [+${serialized.length - maxBytes} bytes]`,
    structuredTopLevelKeys,
    structuredTruncated: true,
  };
}

// Payload-aware preview: when `raw` parses as JSON, returns the redacted
// parsed shape and SKIPS the raw text preview. This closes the gap where
// `safePreview` alone would write `{"password":"hunter2"}` verbatim to
// disk because the regex patterns don't catch short arbitrary values
// under credential-named JSON keys. For non-JSON input, falls back to
// `safePreview` (size-bounded, regex-redacted text). Drop-in compatible
// with `...safePreview(x)` spread sites: same `full`/`preview`/
// `fullLength`/`truncated` keys, plus optional `parsed` /
// `parsedJsonPreview` / `parsedTopLevelKeys` for the structured path.
//
// Size cap: when the redacted JSON serializes larger than `MAX_FULL_BYTES`,
// we drop the structured `parsed` object (which would inline the entire
// huge payload into the trace event) and instead emit a truncated
// serialized preview plus a list of top-level keys for orientation. The
// preview is taken from the already-redacted serialization, so the cap
// path can't reintroduce credentials that the parsed path would have
// scrubbed.
export function redactedPayload(
  raw: string | undefined | null,
  opts: PreviewOptions = {},
): {
  parsed?: unknown;
  parsedJsonPreview?: string;
  parsedTopLevelKeys?: string[];
  full?: string;
  preview?: string;
  fullLength: number;
  truncated: boolean;
} {
  const s = raw ?? "";
  const parsed = tryParseJsonRedacted(s);
  if (parsed !== undefined) {
    const maxBytes = opts.maxBytes ?? MAX_FULL_BYTES;
    let serialized: string;
    try {
      serialized = JSON.stringify(parsed);
    } catch {
      // Circular ref or similar — fall through to text preview path,
      // which still applies regex redaction on the raw input.
      return safePreview(s, opts);
    }
    if (serialized.length <= maxBytes) {
      return { parsed, fullLength: s.length, truncated: false };
    }
    const parsedTopLevelKeys =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.keys(parsed as Record<string, unknown>)
        : undefined;
    return {
      parsedJsonPreview:
        serialized.slice(0, maxBytes) + `… [+${serialized.length - maxBytes} bytes]`,
      parsedTopLevelKeys,
      fullLength: s.length,
      truncated: true,
    };
  }
  return safePreview(s, opts);
}

// --- Repeated tool-call detection ------------------------------------------

// FNV-1a 32-bit. Fast, no allocations, plenty of distribution for arg
// fingerprinting (we're spotting "exact same call 3× in a row", not
// security-grade hashing).
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export class RepeatedCallTracker {
  private window: { name: string; hash: string; at: number }[] = [];
  private readonly capacity: number;
  private readonly minRepeats: number;

  constructor(capacity = 12, minRepeats = 3) {
    this.capacity = capacity;
    this.minRepeats = minRepeats;
  }

  reset(): void {
    this.window = [];
  }

  // Returns the repeat count when the latest call extends a same-name
  // same-args streak of `minRepeats` or more — caller logs once per pattern
  // and decides whether to interrupt. Returns 0 when not in a pattern.
  record(name: string, argsFingerprint: string): number {
    const hash = hashString(`${name}:${argsFingerprint}`);
    this.window.push({ name, hash, at: Date.now() });
    if (this.window.length > this.capacity) this.window.shift();
    let streak = 1;
    for (let i = this.window.length - 2; i >= 0; i--) {
      if (this.window[i]!.hash === hash) streak++;
      else break;
    }
    return streak >= this.minRepeats ? streak : 0;
  }
}
