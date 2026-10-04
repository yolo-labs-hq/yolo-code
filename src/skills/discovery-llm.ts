import type { LlmRelevanceFn } from "./discovery.js";

const DEFAULT_DISCOVERY_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const DISCOVERY_TIMEOUT_MS = 5000;
const MAX_COMPLETION_TOKENS = 256;

export interface RouterLlmOpts {
  /** yolo-router-cf base URL — e.g. `https://router.yolo.studio`. */
  baseUrl: string;
  /** Bearer token used for the router. */
  apiToken: string;
  /** Override the discovery model. Default `@cf/meta/llama-3.1-8b-instruct`,
   *  also tunable via `YOLO_SKILL_DISCOVERY_MODEL`. */
  model?: string;
  /** Used in `X-Session-ID` so router-side analytics can correlate the
   *  discovery call with the conversation it's gating. */
  sessionId?: string;
}

/** Build a relevance-filter transport that POSTs to
 *  `${baseUrl}/v1/chat/completions` with the `skill-discovery` activity
 *  tag. Returns the names the model picked. Errors throw — callers fall
 *  back to the heuristic candidate set. */
export function makeRouterLlmRelevance(opts: RouterLlmOpts): LlmRelevanceFn {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  const model = opts.model || process.env.YOLO_SKILL_DISCOVERY_MODEL || DEFAULT_DISCOVERY_MODEL;

  return async ({ candidates, signature, recentMessages }, signal) => {
    if (candidates.length === 0) return [];

    const validNames = candidates.map((c) => c.name);
    const candidateLines = candidates
      .map((c) => `- ${c.name}: ${truncate(c.description, 200)}`)
      .join("\n");
    const messageLines = recentMessages
      .slice(-3)
      .map((m, i) => `${i + 1}. ${truncate(m, 500)}`)
      .join("\n");
    const sigLine = [
      signature.primaryLanguage ? `language: ${signature.primaryLanguage}` : null,
      signature.topLevelFiles.length > 0
        ? `top-level files: ${signature.topLevelFiles.slice(0, 20).join(", ")}`
        : null,
      signature.extensions.length > 0
        ? `extensions: ${signature.extensions.slice(0, 15).join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const userPrompt =
      `Pick which of these skills are likely useful for the user's current work. ` +
      `Return ONLY a JSON object of the form {"active": ["name1", "name2"]} — no commentary, no markdown fences. ` +
      `Use exactly the names from the list. Return an empty array if none clearly apply.\n\n` +
      `Project signature:\n${sigLine || "(none)"}\n\n` +
      `Recent user messages:\n${messageLines || "(none)"}\n\n` +
      `Candidate skills:\n${candidateLines}`;

    const body = {
      model,
      messages: [
        {
          role: "system",
          content:
            "You filter a list of agent skills down to those relevant to the user's current task. Reply with strict JSON only.",
        },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.0,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      stream: false,
    };

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

    let res: Response;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${opts.apiToken}`,
        "Content-Type": "application/json",
        "X-Yolo-Activity": "skill-discovery",
      };
      if (opts.sessionId) headers["X-Session-ID"] = opts.sessionId;
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content?.trim() ?? "";
    return parseActiveJson(content, validNames);
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Parse the model's reply, tolerating markdown fences and stray prose
 *  around the JSON. Returns intersection with `validNames` so a halluci-
 *  nated skill name never surfaces. */
export function parseActiveJson(raw: string, validNames: string[]): string[] {
  const valid = new Set(validNames);
  if (!raw) return [];
  // Strip ```json fences and surrounding whitespace.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  // Find the first {...} block — models occasionally emit a sentence in front.
  const match = cleaned.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : cleaned;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const active = (parsed as { active?: unknown }).active;
  if (!Array.isArray(active)) return [];
  return active.filter((x): x is string => typeof x === "string" && valid.has(x));
}
