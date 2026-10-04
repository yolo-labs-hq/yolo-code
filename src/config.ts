import { readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ReasoningEffort = "low" | "medium" | "high";

export interface McpServerConfig {
  type: "local" | "remote";
  command?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface KimiConfig {
  accountId: string;
  apiToken: string;
  model: string;
  theme?: string;
  reasoningEffort?: ReasoningEffort;
  coauthor?: boolean;
  coauthorName?: string;
  coauthorEmail?: string;
  mcpServers?: Record<string, McpServerConfig>;
  cacheStablePrompts?: boolean;
  /** Enable compiled context (token-optimized state packet + artifact store). */
  compiledContext?: boolean;
  /** Number of recent user turns to retain image content; older images are dropped. */
  imageHistoryTurns?: number;
  /** Max tool/LLM iterations per user action. Default 10. */
  maxToolIterations?: number;
  /** Max input tokens per LLM request. Default 200000 (Kimi-K2.6's
   *  262k context window minus headroom for the token-estimation
   *  heuristic's underestimate on code-dense content). Env override:
   *  YOLO_CODE_MAX_INPUT_TOKENS. */
  maxInputTokens?: number;
  /** Max completion tokens per LLM response. Default 4096. */
  maxCompletionTokens?: number;
  /** When set, route requests through yolo-router-cf instead of calling Cloudflare
   *  Workers AI directly. The POST target is `${routerBaseUrl}/v1/chat/completions`
   *  and `apiToken` is used as the router's bearer credential. In router mode
   *  `accountId` is ignored. */
  routerBaseUrl?: string;
  /** When set, auto-connect to the YOLO Studio MCP server at this URL on
   *  startup (Streamable HTTP transport). In the sandbox this points at the
   *  in-container mcp-proxy (http://localhost:7780/mcp), which injects a
   *  delegated auth token on every tool call. Outside a sandbox this should
   *  be left unset. */
  studioMcpUrl?: string;
}

export const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "yolo-code", "config.json");
}

function readReasoningEffortEnv(): ReasoningEffort | undefined {
  const raw = process.env.KIMI_REASONING_EFFORT?.toLowerCase();
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  return undefined;
}

function readCoauthorEnv(): { enabled: boolean; name: string; email: string } | undefined {
  const enabled = process.env.YOLO_CODE_COAUTHOR;
  if (enabled === "0" || enabled === "false") return undefined;
  const name = process.env.YOLO_CODE_COAUTHOR_NAME || "YOLO Code";
  const email = process.env.YOLO_CODE_COAUTHOR_EMAIL || "noreply@yolo.studio";
  return { enabled: true, name, email };
}

/** Studio MCP URL priority:
 *  1. YOLO_STUDIO_MCP_URL (explicit — set to empty string to disable)
 *  2. config file
 *  3. undefined (no auto-connect)
 *
 *  There is intentionally no sandbox-side default. The in-container
 *  mcp-proxy at localhost:7780 is a per-agent proxy spawned by
 *  container-api only when MCP_AGENT_INJECTION_ENABLED=true, and even
 *  then it's bound to a single YOLO_PREFERRED_AGENT — it's not
 *  universally the studio MCP, so defaulting there produces phantom
 *  "MCP failed: terminated" errors whenever the proxy isn't running
 *  (or is running for a different agent). The sandbox infrastructure
 *  (common-api's kubelet env injection) owns picking a correct URL
 *  per session and exporting it as YOLO_STUDIO_MCP_URL. */
function resolveStudioMcpUrl(fromFile: string | undefined): string | undefined {
  const explicit = process.env.YOLO_STUDIO_MCP_URL;
  if (explicit !== undefined) {
    return explicit.trim() === "" ? undefined : explicit;
  }
  return fromFile;
}

export async function loadConfig(): Promise<KimiConfig | null> {
  const envRouterBase = process.env.YOLO_ROUTER_BASE_URL;
  const envRouterKey = process.env.YOLO_ROUTER_API_KEY ?? process.env.YOLO_API_TOKEN;
  const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID;
  const envToken = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
  const envModel = process.env.KIMI_MODEL ?? DEFAULT_MODEL;
  const envEffort = readReasoningEffortEnv();
  const envTheme = process.env.KIMI_THEME;
  const envCoauthor = readCoauthorEnv();

  const envCacheStable = process.env.YOLO_CODE_CACHE_STABLE_PROMPTS;
  const cacheStablePrompts = envCacheStable === "0" || envCacheStable === "false" ? false : true;

  const envCompiled = process.env.YOLO_CODE_COMPILED_CONTEXT;
  const compiledContext = envCompiled === "1" || envCompiled === "true" ? true : false;

  const envImageTurns = process.env.YOLO_CODE_IMAGE_HISTORY_TURNS;
  const imageHistoryTurns = envImageTurns ? parseInt(envImageTurns, 10) : undefined;

  const envMaxToolIterations = process.env.YOLO_CODE_MAX_TOOL_ITERATIONS;
  const maxToolIterations = envMaxToolIterations ? parseInt(envMaxToolIterations, 10) : undefined;

  const envMaxInputTokens = process.env.YOLO_CODE_MAX_INPUT_TOKENS;
  const maxInputTokens = envMaxInputTokens ? parseInt(envMaxInputTokens, 10) : undefined;

  const envMaxCompletionTokens = process.env.YOLO_CODE_MAX_COMPLETION_TOKENS;
  const maxCompletionTokens = envMaxCompletionTokens ? parseInt(envMaxCompletionTokens, 10) : undefined;

  // Router mode: YOLO_ROUTER_BASE_URL + bearer key (set by the YOLO Studio
  // sandbox via kubelet). Takes precedence over direct Cloudflare credentials
  // so that a session container never falls back to a user's personal CF key.
  if (envRouterBase && envRouterKey) {
    return {
      accountId: "",
      apiToken: envRouterKey,
      model: envModel,
      theme: envTheme,
      reasoningEffort: envEffort,
      coauthor: envCoauthor?.enabled ?? true,
      coauthorName: envCoauthor?.name,
      coauthorEmail: envCoauthor?.email,
      cacheStablePrompts,
      compiledContext,
      imageHistoryTurns: Number.isNaN(imageHistoryTurns) ? undefined : imageHistoryTurns,
      maxToolIterations: Number.isNaN(maxToolIterations) ? undefined : maxToolIterations,
      maxInputTokens: Number.isNaN(maxInputTokens) ? undefined : maxInputTokens,
      maxCompletionTokens: Number.isNaN(maxCompletionTokens) ? undefined : maxCompletionTokens,
      routerBaseUrl: envRouterBase,
      studioMcpUrl: resolveStudioMcpUrl(undefined),
    };
  }

  if (envAccount && envToken) {
    return {
      accountId: envAccount,
      apiToken: envToken,
      model: envModel,
      theme: envTheme,
      reasoningEffort: envEffort,
      coauthor: envCoauthor?.enabled ?? true,
      coauthorName: envCoauthor?.name,
      coauthorEmail: envCoauthor?.email,
      cacheStablePrompts,
      compiledContext,
      imageHistoryTurns: Number.isNaN(imageHistoryTurns) ? undefined : imageHistoryTurns,
      maxToolIterations: Number.isNaN(maxToolIterations) ? undefined : maxToolIterations,
      maxInputTokens: Number.isNaN(maxInputTokens) ? undefined : maxInputTokens,
      maxCompletionTokens: Number.isNaN(maxCompletionTokens) ? undefined : maxCompletionTokens,
      studioMcpUrl: resolveStudioMcpUrl(undefined),
    };
  }

  try {
    const raw = await readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<KimiConfig>;
    const base = {
      model: envModel ?? parsed.model ?? DEFAULT_MODEL,
      theme: envTheme ?? parsed.theme,
      reasoningEffort: envEffort ?? parsed.reasoningEffort,
      coauthor: envCoauthor?.enabled ?? parsed.coauthor ?? true,
      coauthorName: envCoauthor?.name ?? parsed.coauthorName,
      coauthorEmail: envCoauthor?.email ?? parsed.coauthorEmail,
      mcpServers: parsed.mcpServers,
      cacheStablePrompts: parsed.cacheStablePrompts ?? cacheStablePrompts,
      compiledContext: parsed.compiledContext ?? compiledContext,
      imageHistoryTurns: Number.isNaN(imageHistoryTurns) ? parsed.imageHistoryTurns : imageHistoryTurns,
      maxToolIterations: Number.isNaN(maxToolIterations) ? parsed.maxToolIterations : maxToolIterations,
      maxInputTokens: Number.isNaN(maxInputTokens) ? parsed.maxInputTokens : maxInputTokens,
      maxCompletionTokens: Number.isNaN(maxCompletionTokens) ? parsed.maxCompletionTokens : maxCompletionTokens,
      studioMcpUrl: resolveStudioMcpUrl(parsed.studioMcpUrl),
    };
    const routerBase = parsed.routerBaseUrl;
    if (routerBase && parsed.apiToken) {
      return {
        accountId: "",
        apiToken: parsed.apiToken,
        routerBaseUrl: routerBase,
        ...base,
      };
    }
    if (parsed.accountId && parsed.apiToken) {
      return {
        accountId: parsed.accountId,
        apiToken: parsed.apiToken,
        ...base,
      };
    }
  } catch {
    /* no config file */
  }
  return null;
}

export async function saveConfig(cfg: KimiConfig): Promise<string> {
  const p = configPath();
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify(cfg, null, 2), "utf8");
  await chmod(p, 0o600);
  return p;
}
