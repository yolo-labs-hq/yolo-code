import { appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSSE } from "../util/sse.js";
import { KimiApiError } from "../util/errors.js";
import { jsonReplacer, sanitizeString, stableStringify } from "./messages.js";
import type { ChatMessage, ToolDef, Usage } from "./messages.js";

export type KimiEvent =
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_args"; index: number; argsDelta: string }
  | { type: "tool_call_complete"; index: number; id: string; name: string; arguments: string }
  | { type: "usage"; usage: Usage }
  // Emitted when an upstream call returns 429 Rate Limit and we are about
  // to sleep before retrying. The agent loop forwards this to the UI so
  // the user sees "waiting Ns…" instead of an opaque error or silent hang.
  | { type: "rate_limited"; delayMs: number; message: string; attempt: number }
  | { type: "done"; finishReason: string | null; usage: Usage | null };

export interface RunKimiOpts {
  accountId: string;
  apiToken: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  signal?: AbortSignal;
  temperature?: number;
  maxCompletionTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  sessionId?: string;
  /** When set, POST to `${baseUrl}/v1/chat/completions` with `model` in the body
   *  (OpenAI-native shape) instead of the direct Cloudflare Workers AI path.
   *  Used to route through yolo-router-cf for billing / gating in YOLO Studio. */
  baseUrl?: string;
}

const RETRYABLE_CODES = new Set([3040]); // "Capacity temporarily exceeded"
// Upper bound on retry attempts. 429 gets the full budget (rate-limit
// resolution can need 30-60s windows); 5xx and capacity errors are
// gated by their own per-error caps inside getRetryDelayMs so they
// don't ride the 429 budget.
const MAX_ATTEMPTS = 5;
const MAX_5XX_RETRIES = 2;
const MAX_429_RETRIES = 4;
// 401 happens inside sandboxes when the yolo-router JWT expires faster
// than the long-running agent can be restarted. container-api's
// yolo-token-refresh daemon writes a fresh token to this file every
// ~10min; we re-read it before every attempt, and on a 401 give the
// rotator one quick chance to land a new value before surfacing the
// error. YOLO_TOKEN_FILE overrides the path (handy for tests + non-
// default deployments).
const MAX_401_RETRIES = 1;

function rotatedTokenFilePath(): string {
  return process.env.YOLO_TOKEN_FILE ?? join(homedir(), ".config", "yolo", "token");
}

function readRotatedToken(): string | null {
  const filePath = rotatedTokenFilePath();
  try {
    if (!existsSync(filePath)) return null;
    const t = readFileSync(filePath, "utf-8").trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

function cleanErrorMessage(msg: string): string {
  // Cloudflare Workers AI sometimes prefixes messages with redundant "AiError: "
  return msg.replace(/^(AiError:\s*)+/, "").trim();
}

/** Returns the delay (ms) before retrying, or null to surface the error. */
function getRetryDelayMs(
  err: KimiApiError,
  attempt: number,
  retryAfter: string | null,
): number | null {
  // 401: token may have just rotated. Tiny pause then retry — the next
  // loop iteration re-reads ~/.config/yolo/token, so if the rotator
  // landed a new token we'll succeed without bothering the user.
  if (err.httpStatus === 401) {
    if (attempt >= MAX_401_RETRIES) return null;
    return 200;
  }
  // 429: honor Retry-After when present, fall back to ramped backoff.
  // Per-minute rate limits often resolve in 15-60s, so we ramp up to
  // 60s and cap at 120s if the server gives us a longer hint.
  if (err.httpStatus === 429) {
    if (attempt >= MAX_429_RETRIES) return null;
    const secs = retryAfter ? parseInt(retryAfter, 10) : NaN;
    if (Number.isFinite(secs) && secs > 0) {
      return Math.min(secs * 1000, 120_000);
    }
    return Math.min(15_000 * 2 ** attempt, 60_000);
  }
  // Capacity / 5xx / generic "Internal server error": short jittered backoff.
  if (attempt >= MAX_5XX_RETRIES) return null;
  if (err.code !== undefined && RETRYABLE_CODES.has(err.code)) {
    return 500 * 2 ** attempt + Math.random() * 250;
  }
  if (err.httpStatus !== undefined && err.httpStatus >= 500 && err.httpStatus < 600) {
    return 500 * 2 ** attempt + Math.random() * 250;
  }
  if (err.message.includes("Internal server error")) {
    return 500 * 2 ** attempt + Math.random() * 250;
  }
  return null;
}

export async function* runKimi(opts: RunKimiOpts): AsyncGenerator<KimiEvent, void, void> {
  const url = opts.baseUrl
    ? `${opts.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`
    : `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/run/${opts.model}`;
  const body: Record<string, unknown> = {
    // Router mode (OpenAI-native) puts model in the body; direct Cloudflare
    // encodes it in the URL path.
    ...(opts.baseUrl ? { model: opts.model } : {}),
    messages: sanitizeMessagesForApi(opts.messages),
    ...(opts.tools && opts.tools.length
      ? { tools: opts.tools, tool_choice: "auto", parallel_tool_calls: true }
      : {}),
    stream: true,
    temperature: opts.temperature ?? 0.2,
    max_completion_tokens: opts.maxCompletionTokens ?? 4096,
  };
  if (opts.reasoningEffort) {
    body.reasoning_effort = opts.reasoningEffort;
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Per-attempt token read so a freshly-rotated JWT lands without
    // restarting yolo-code. Falls back to the start-of-process value
    // (env var / config file) when the rotator file isn't present —
    // e.g. local dev outside a sandbox.
    const apiToken = readRotatedToken() ?? opts.apiToken;
    let res: Response;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      };
      if (opts.sessionId) {
        headers["X-Session-ID"] = opts.sessionId;
      }
      res = await fetch(url, {
        method: "POST",
        headers,
        body: stableStringify(body, jsonReplacer),
        signal: opts.signal,
      });
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      // Network errors get the 5xx-style budget — short, jittered, capped.
      // The 429 budget only applies to actual 429 responses, not general
      // connectivity blips.
      if (attempt < MAX_5XX_RETRIES) {
        const delay = 500 * 2 ** attempt + Math.random() * 250;
        await sleep(delay, opts.signal);
        continue;
      }
      throw new KimiApiError(`yolo: network error: ${msg}`, undefined, undefined);
    }

    const contentType = res.headers.get("content-type") ?? "";

    // Cloudflare returns HTTP 200 + application/json with {success:false,errors:[{code:3040}]}
    // for transient capacity errors. It also returns HTTP 5xx or OpenAI-style error objects
    // for transient internal failures. Retry those; surface everything else.
    if (!contentType.includes("text/event-stream")) {
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* ignore */
      }
      const err = extractCloudflareError(parsed);
      const rawMsg = err?.message ?? `HTTP ${res.status}: ${text.slice(0, 300)}`;
      const msg = cleanErrorMessage(rawMsg);
      const apiErr = new KimiApiError(`yolo: ${msg}`, err?.code, res.status);
      const retryAfter = res.headers.get("retry-after");
      const delayMs = getRetryDelayMs(apiErr, attempt, retryAfter);
      if (delayMs !== null) {
        // Surface 429s so the UI can tell the user we're waiting,
        // not failing. Other retryable errors stay silent — they
        // resolve in <1s and noise just confuses the transcript.
        if (apiErr.httpStatus === 429) {
          yield { type: "rate_limited", delayMs, message: msg, attempt };
        }
        await sleep(delayMs, opts.signal);
        continue;
      }
      throw apiErr;
    }

    if (!res.body) throw new KimiApiError("yolo: empty response body", undefined, res.status);

    yield* parseStream(res.body, opts.signal, opts.model);
    return;
  }
}

async function* parseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  model?: string,
): AsyncGenerator<KimiEvent, void, void> {
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let lastUsage: Usage | null = null;
  let finishReason: string | null = null;
  // Track total chunks + last delta time to differentiate "stream cut
  // short" (no DONE, no finish_reason) from "model emitted empty args".
  let chunkCount = 0;
  let sawDone = false;

  for await (const dataStr of readSSE(body, signal)) {
    if (dataStr === "[DONE]") {
      sawDone = true;
      break;
    }
    chunkCount++;
    let chunk: StreamChunk | null = null;
    try {
      chunk = JSON.parse(dataStr);
    } catch {
      continue;
    }
    if (!chunk) continue;

    if (chunk.usage) {
      lastUsage = chunk.usage;
      yield { type: "usage", usage: chunk.usage };
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const d = choice.delta;
    if (d) {
      if (typeof d.reasoning_content === "string" && d.reasoning_content.length) {
        yield { type: "reasoning", delta: d.reasoning_content };
      }
      if (typeof d.content === "string" && d.content.length) {
        yield { type: "text", delta: d.content };
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          let buf = toolCalls.get(idx);
          const incomingName = tc.function?.name ?? null;
          const incomingId = tc.id ?? null;
          if (!buf) {
            buf = { id: incomingId ?? `tc_${idx}`, name: incomingName ?? "", args: "" };
            toolCalls.set(idx, buf);
            if (buf.name) {
              yield { type: "tool_call_start", index: idx, id: buf.id, name: buf.name };
            }
          } else {
            if (!buf.name && incomingName) {
              buf.name = incomingName;
              yield { type: "tool_call_start", index: idx, id: buf.id, name: buf.name };
            }
            if (buf.id.startsWith("tc_") && incomingId) buf.id = incomingId;
          }
          const argDelta = tc.function?.arguments;
          if (typeof argDelta === "string" && argDelta.length) {
            buf.args += argDelta;
            yield { type: "tool_call_args", index: idx, argsDelta: argDelta };
          }
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  for (const [idx, buf] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    if (!buf.name) continue;
    // Diagnostic: log when the upstream emitted a tool call with empty
    // or invalid-JSON args. The user sees `write({})` with a red ✗
    // because the executor rejects empty args; this records enough
    // context to tell whether the model genuinely produced empty args,
    // a token-limit truncation chopped them mid-arg, or the SSE stream
    // ended prematurely. Inspect ~/.local/share/yolo-code/anomalies.jsonl.
    const argsTrimmed = buf.args.trim();
    if (!argsTrimmed || !isValidJson(buf.args)) {
      void logAnomaly({
        ts: new Date().toISOString(),
        kind: !argsTrimmed ? "empty_tool_args" : "invalid_tool_args_json",
        tool: buf.name,
        argsLen: buf.args.length,
        argsRaw: buf.args.slice(0, 500),
        finishReason,
        sawDone,
        chunkCount,
        toolCallCount: toolCalls.size,
        model,
        usagePromptTokens: lastUsage?.prompt_tokens,
        usageCompletionTokens: lastUsage?.completion_tokens,
      });
    }
    yield {
      type: "tool_call_complete",
      index: idx,
      id: buf.id,
      name: buf.name,
      arguments: buf.args,
    };
  }

  yield { type: "done", finishReason, usage: lastUsage };
}

interface StreamChunk {
  choices?: StreamChoice[];
  usage?: Usage;
}
interface StreamChoice {
  delta?: StreamDelta;
  finish_reason?: string | null;
  index?: number;
}
interface StreamDelta {
  role?: string | null;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: StreamToolCall[];
}
interface StreamToolCall {
  index?: number;
  id?: string | null;
  type?: string | null;
  function?: { name?: string | null; arguments?: string | null };
}

function sanitizeMessagesForApi(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    let next: ChatMessage = m;
    if (Array.isArray(m.content)) {
      next = {
        ...m,
        content: m.content.map((part) =>
          part.type === "text" ? { ...part, text: sanitizeString(part.text) } : part,
        ),
      };
    }
    if (!next.tool_calls || next.tool_calls.length === 0) return next;
    return {
      ...next,
      tool_calls: next.tool_calls.map((tc) => ({
        ...tc,
        function: {
          name: tc.function.name,
          arguments: validateJsonArguments(tc.function.arguments),
        },
      })),
    };
  });
}

function validateJsonArguments(raw: string): string {
  if (!raw || !raw.trim()) return "{}";
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return "{}";
  }
}

function extractCloudflareError(parsed: unknown): { code?: number; message?: string } | null {
  if (!parsed || typeof parsed !== "object") return null;

  // Cloudflare native format: { success: false, errors: [...] }
  const cf = parsed as { success?: boolean; errors?: Array<{ code?: number; message?: string }> };
  if (cf.success === false && Array.isArray(cf.errors) && cf.errors.length > 0) {
    return { code: cf.errors[0]?.code, message: cf.errors[0]?.message };
  }

  // OpenAI-compatible format: { object: "error", message, code }
  const oai = parsed as { object?: string; message?: string; code?: string | number };
  if (oai.object === "error" && typeof oai.message === "string") {
    const codeNum = typeof oai.code === "number" ? oai.code : undefined;
    return { code: codeNum, message: oai.message };
  }

  return null;
}

/** Write a one-line JSONL entry to ~/.local/share/yolo-code/anomalies.jsonl
 *  for post-hoc diagnosis. Best-effort — never throws, never blocks the
 *  stream. Used to capture upstream weirdness like empty / truncated
 *  tool-call arguments so we can tell whether the model emitted empty
 *  args, the response was token-truncated, or the stream was cut short. */
async function logAnomaly(entry: Record<string, unknown>): Promise<void> {
  try {
    const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    const dir = join(xdg, "yolo-code");
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, "anomalies.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

function isValidJson(raw: string): boolean {
  if (!raw || !raw.trim()) return false;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
