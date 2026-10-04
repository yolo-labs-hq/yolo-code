import React, { useState, useRef, useEffect, useCallback } from "react";
import { Box, Text, useApp, useInput, render } from "ink";

import { runAgentTurn } from "./agent/loop.js";
import { buildSystemPrompt, buildSystemMessages, buildSessionPrefix, type ActiveSkill } from "./agent/system-prompt.js";
import { loadAllSkillsWithMeta } from "./skills/loader.js";
import { isTrusted } from "./skills/trust.js";
import { applyPinFilter, pinDisable, pinEnable, pinClear, readPins } from "./skills/pins.js";
import { discoveryDisabled, runDiscovery, clearDiscoveryCache } from "./skills/discovery.js";
import { makeRouterLlmRelevance } from "./skills/discovery-llm.js";
import { InMemorySkillCatalog, type SkillCatalog, type SkillRecord } from "./skills/types.js";
import { compactMessages } from "./agent/compact.js";
import {
  compactMessages as compactCompiled,
  shouldCompact,
  recallArtifacts,
} from "./agent/compaction.js";
import {
  emptySessionState,
  ArtifactStore,
  formatRecalledArtifacts,
  type SessionState,
} from "./agent/session-state.js";
import { ToolExecutor, ALL_TOOLS, type PermissionDecision } from "./tools/executor.js";
import type { ToolSpec } from "./tools/registry.js";
import { McpManager } from "./mcp/manager.js";
import { sanitizeString } from "./agent/messages.js";
import type { ChatMessage, ContentPart, Usage } from "./agent/messages.js";
import { KimiApiError } from "./util/errors.js";
import { ChatView, type ChatEvent } from "./ui/chat.js";
import { StatusBar } from "./ui/status.js";
import { PermissionModal } from "./ui/permission.js";
import { ResumePicker } from "./ui/resume-picker.js";
import { ThemePicker } from "./ui/theme-picker.js";
import { SkillBrowser, type SkillBrowserAction } from "./ui/skill-browser.js";
import type { SkillBrowserState } from "./cli/skills-cmd.js";
import { TaskList } from "./ui/task-list.js";
import type { Task } from "./tasks-state.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolRender } from "./tools/registry.js";
import { CustomTextInput } from "./ui/text-input.js";
import { checkForUpdate } from "./util/update-check.js";
import type { UpdateCheckResult } from "./util/update-check.js";
import { Onboarding } from "./ui/onboarding.js";
import { Welcome } from "./ui/welcome.js";
import {
  configPath,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  saveConfig,
  type ReasoningEffort,
} from "./config.js";
import { resolveTheme, themeNames, themeList, type Theme } from "./ui/theme.js";
import { nextMode, type Mode, isBlockedInPlanMode, isReadOnlyBash } from "./mode.js";
import {
  listSessions,
  loadSession,
  makeSessionId,
  saveSession,
  type SessionFile,
  type SessionSummary,
} from "./sessions.js";
import { unlink } from "node:fs/promises";
import { encodeImageFile, isImagePath, type EncodedImage } from "./util/image.js";
import { recordUsage, getCostReport, formatCostReport } from "./usage-tracker.js";
import { clearOutputHashCache } from "./agent/tool-output-summarizer.js";
import {
  logTrace,
  traceEnabledFromEnv,
  tracePath,
  setRuntimeTraceEnabled,
  hashString,
  RepeatedCallTracker,
  redactedPayload,
} from "./trace-log.js";

interface Cfg {
  accountId: string;
  apiToken: string;
  model: string;
  theme?: string;
  reasoningEffort?: ReasoningEffort;
  coauthor?: boolean;
  coauthorName?: string;
  coauthorEmail?: string;
  mcpServers?: Record<string, { type: "local" | "remote"; command?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string>; enabled?: boolean }>;
  cacheStablePrompts?: boolean;
  compiledContext?: boolean;
  imageHistoryTurns?: number;
  routerBaseUrl?: string;
  studioMcpUrl?: string;
}

interface PendingPermission {
  tool: ToolSpec;
  args: Record<string, unknown>;
  /** Permission key the executor will use for `allow_session`. Threaded
   *  through to the modal so it can render an honest scope label. */
  sessionKey: string;
  resolve: (d: PermissionDecision) => void;
}

const CONTEXT_LIMIT = 262_000;
const AUTO_COMPACT_SUGGEST_PCT = 0.8;

let nextAssistantId = 1;
let nextKey = 1;
const mkKey = () => `evt_${nextKey++}`;

const MAX_IMAGES_PER_MESSAGE = 10;

function makePrefixMessages(
  cacheStable: boolean,
  model: string,
  mode: Mode,
  tools: ToolSpec[],
  activeSkills: ActiveSkill[] = [],
): ChatMessage[] {
  if (cacheStable) {
    return buildSystemMessages({ cwd: process.cwd(), tools, model, mode, activeSkills });
  }
  return [
    {
      role: "system",
      content: buildSystemPrompt({ cwd: process.cwd(), tools, model, mode, activeSkills }),
    },
  ];
}

function catalogToActiveSkills(catalog: SkillCatalog | null): ActiveSkill[] {
  if (!catalog) return [];
  return catalog.list().map((r) => ({ name: r.name, description: r.description }));
}

function findImagePaths(text: string): string[] {
  const paths: string[] = [];
  for (const token of text.split(/\s+/)) {
    const clean = token.replace(/^["']|["',;:!?]$/g, "").replace(/[.,;:!?]$/, "");
    if (isImagePath(clean) && existsSync(clean)) {
      paths.push(clean);
    }
  }
  return [...new Set(paths)];
}

const EFFORT_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  low: "low — fastest; lightest reasoning. Best for simple Q&A, small edits, quick coordination.",
  medium: "medium — balanced (default). Solid quality on most edits, fast on trivial prompts.",
  high: "high — deepest reasoning; slowest. Best for complex debugging, architecture, multi-file refactors.",
};

interface AppProps {
  initialCfg: Cfg | null;
  initialUpdateResult?: UpdateCheckResult;
  /** Pre-loaded session to resume on mount. Set when launched via
   *  `yolo --continue` / `yolo --resume <id>`. Hydrates messages,
   *  systemMessages, sessionId, and history exactly like the in-app
   *  /resume picker would. */
  initialSession?: SessionFile;
}

function App({ initialCfg, initialUpdateResult, initialSession }: AppProps) {
  const { exit } = useApp();
  const [cfg, setCfg] = useState<Cfg | null>(initialCfg);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [showReasoning, setShowReasoning] = useState(false);
  const [perm, setPerm] = useState<PendingPermission | null>(null);
  const [queue, setQueue] = useState<Array<{ full: string; display: string }>>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draftInput, setDraftInput] = useState("");

  // YOLO Studio's convention is no-approval execution ("YOLO Mode"). When
  // we detect we're in a sandbox (routerBaseUrl set), boot into auto mode
  // so the user isn't prompted on every tool call. Standalone users fall
  // through to kimiflare's original edit-mode default.
  const [mode, setMode] = useState<Mode>(initialCfg?.routerBaseUrl ? "auto" : "edit");
  const [effort, setEffort] = useState<ReasoningEffort>(
    initialCfg?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
  );
  const [theme, setTheme] = useState<Theme>(resolveTheme(initialCfg?.theme));
  const [resumeSessions, setResumeSessions] = useState<SessionSummary[] | null>(null);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [originalTheme, setOriginalTheme] = useState<Theme | null>(null);
  const [skillBrowserState, setSkillBrowserState] = useState<SkillBrowserState | null>(null);
  const [skillBrowserBusy, setSkillBrowserBusy] = useState(false);
  const [skillBrowserStatus, setSkillBrowserStatus] = useState<string | null>(null);
  const [skillBrowserInitialFilter, setSkillBrowserInitialFilter] = useState<string>("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksStartedAt, setTasksStartedAt] = useState<number | null>(null);
  const [tasksStartTokens, setTasksStartTokens] = useState<number>(0);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [verbose, setVerbose] = useState(false);
  const [traceEnabled, setTraceEnabled] = useState(traceEnabledFromEnv());
  const [hasUpdate, setHasUpdate] = useState(initialUpdateResult?.hasUpdate ?? false);
  const [latestVersion, setLatestVersion] = useState<string | null>(initialUpdateResult?.latestVersion ?? null);

  const cacheStableRef = useRef(initialCfg?.cacheStablePrompts !== false);
  const systemMessagesRef = useRef<ChatMessage[]>(
    makePrefixMessages(cacheStableRef.current, cfg?.model ?? DEFAULT_MODEL, "edit", ALL_TOOLS),
  );
  const messagesRef = useRef<ChatMessage[]>(systemMessagesRef.current.slice());
  const executorRef = useRef<ToolExecutor>(new ToolExecutor(ALL_TOOLS));
  const activeAsstIdRef = useRef<number | null>(null);
  const activeControllerRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const modeRef = useRef<Mode>(mode);
  const effortRef = useRef<ReasoningEffort>(effort);
  const tasksRef = useRef<Task[]>([]);
  const usageRef = useRef<Usage | null>(null);
  const traceEnabledRef = useRef(traceEnabled);
  const repeatedCallTrackerRef = useRef<RepeatedCallTracker>(new RepeatedCallTracker());
  // Some upstream models (notably Kimi-K2.6) reuse function-call ids
  // across separate iterations within one turn — every tasks_set call
  // arrives as `functions.tasks_set:0` regardless of how many earlier
  // calls used the same id. Two ChatEvents sharing an id would (a)
  // collide on React keys and (b) make `updateTool(id, …).map(e => e.id === id ? …)`
  // overwrite the earlier iteration's event when the later iteration
  // finished. The protocol-level tool_call_id stays untouched (the LLM
  // contract pairs by adjacency); these refs only namespace the *UI*
  // tracking by mapping each in-flight call to a fresh monotonic key
  // and routing its result back via that key.
  //
  // The map value is a FIFO queue of uiKeys, not a single key, so two
  // concurrent calls with the same upstream id inside one assistant
  // message (rare but possible) each get a distinct row in the UI:
  // onToolCallFinalized pushes, onToolResult shifts. Results arrive in
  // protocol order, matching the push order, so FIFO is the right shape.
  const nextToolUiKeyRef = useRef(1);
  const pendingToolUiKeysRef = useRef<Map<string, string[]>>(new Map());
  const updateCheckedRef = useRef(false);
  const sessionStateRef = useRef<SessionState>(emptySessionState());
  const artifactStoreRef = useRef<ArtifactStore>(new ArtifactStore());
  const compiledContextRef = useRef(initialCfg?.compiledContext === true);
  const updateNudgedRef = useRef(false);
  const compactSuggestedRef = useRef(false);
  const mcpManagerRef = useRef(new McpManager());
  const mcpToolsRef = useRef<ToolSpec[]>([]);
  const mcpInitRef = useRef(false);
  const initialSessionLoadedRef = useRef(false);
  const skillCatalogRef = useRef<SkillCatalog | null>(null);
  const activeSkillsRef = useRef<ActiveSkill[]>([]);
  const skillsInitRef = useRef(false);
  const previousActiveRef = useRef<string[]>([]);
  // Set by `/skills discovery off` to skip the LLM step session-locally
  // without touching the env var. Reset on `/skills discovery on`.
  const discoverySuppressedRef = useRef(false);

  useEffect(() => {
    traceEnabledRef.current = traceEnabled;
    // Mirror into the module-level flag so non-React callers (MCP adapter,
    // tool executor, agent loop) emit trace events too.
    setRuntimeTraceEnabled(traceEnabled);
  }, [traceEnabled]);

  const emitTrace = useCallback((event: string, data: Record<string, unknown> = {}) => {
    if (!traceEnabledRef.current) return;
    void logTrace({
      event,
      sessionId: sessionIdRef.current ?? undefined,
      ...data,
    });
  }, []);

  // Hydrate from a CLI-provided session before MCP / first turn runs.
  // Mirrors handleResumePick — the "/resume picker" path the user
  // would have taken in-app. Runs once.
  useEffect(() => {
    if (!initialSession || initialSessionLoadedRef.current) return;
    initialSessionLoadedRef.current = true;
    const file = initialSession;
    const prefixEnd = file.messages.findIndex((m) => m.role !== "system");
    systemMessagesRef.current = prefixEnd === -1 ? file.messages.slice() : file.messages.slice(0, prefixEnd);
    messagesRef.current = file.messages;
    sessionIdRef.current = file.id;
    if (file.sessionState && compiledContextRef.current) {
      sessionStateRef.current = file.sessionState;
      artifactStoreRef.current = new ArtifactStore();
    }
    setEvents([
      { kind: "info", key: mkKey(), text: `resumed session ${file.id} (${file.messages.filter((m) => m.role !== "system").length} msgs)` },
    ]);
    const userMsgs = file.messages
      .filter((m) => m.role === "user" && m.content)
      .map((m) => {
        if (!m.content) return "";
        if (typeof m.content === "string") return m.content;
        const textPart = m.content.find((p) => p.type === "text");
        return textPart?.text ?? "";
      })
      .filter((text) => text.length > 0);
    if (userMsgs.length > 0) setHistory(userMsgs);
  }, [initialSession]);

  useEffect(() => {
    if (!cfg) return;
    // Prune old sessions on startup
    void import("./sessions.js").then(({ pruneSessions }) =>
      pruneSessions().then((removed) => {
        if (removed > 0) {
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: `pruned ${removed} old session files` },
          ]);
        }
      }),
    );
  }, [cfg]);

  useEffect(() => {
    if (!cfg || updateCheckedRef.current) return;
    updateCheckedRef.current = true;

    if (initialUpdateResult) {
      if (initialUpdateResult.hasUpdate && !updateNudgedRef.current) {
        updateNudgedRef.current = true;
        setHasUpdate(true);
        setLatestVersion(initialUpdateResult.latestVersion);
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: `update available: ${initialUpdateResult.localVersion} → ${initialUpdateResult.latestVersion}`,
          },
        ]);
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: "run:  npm update -g yolo-code  then restart",
          },
        ]);
      }
      return;
    }

    void checkForUpdate().then((result) => {
      if (result.hasUpdate && !updateNudgedRef.current) {
        updateNudgedRef.current = true;
        setHasUpdate(true);
        setLatestVersion(result.latestVersion);
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: `update available: ${result.localVersion} → ${result.latestVersion}`,
          },
        ]);
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: "run:  npm update -g yolo-code  then restart",
          },
        ]);
      }
    });
  }, [cfg, initialUpdateResult]);

  useEffect(() => {
    modeRef.current = mode;
    if (cacheStableRef.current) {
      const sessionMsg: ChatMessage = {
        role: "system",
        content: buildSessionPrefix({
          cwd: process.cwd(),
          tools: executorRef.current.list(),
          model: cfg?.model ?? DEFAULT_MODEL,
          mode,
          activeSkills: activeSkillsRef.current,
        }),
      };
      messagesRef.current[1] = sessionMsg;
      systemMessagesRef.current[1] = sessionMsg;
    } else {
      const sysMsg: ChatMessage = {
        role: "system",
        content: buildSystemPrompt({
          cwd: process.cwd(),
          tools: executorRef.current.list(),
          model: cfg?.model ?? DEFAULT_MODEL,
          mode,
          activeSkills: activeSkillsRef.current,
        }),
      };
      messagesRef.current[0] = sysMsg;
      systemMessagesRef.current[0] = sysMsg;
    }
    if (mode === "plan") {
      executorRef.current.clearSessionPermissions();
    }
  }, [mode, cfg?.model]);

  useEffect(() => {
    effortRef.current = effort;
  }, [effort]);

  useEffect(() => {
    if (!cfg) return;
    const id = setInterval(() => {
      void checkForUpdate().then((result) => {
        if (result.hasUpdate) {
          setHasUpdate(true);
          setLatestVersion(result.latestVersion);
          if (!updateNudgedRef.current) {
            updateNudgedRef.current = true;
            setEvents((e) => [
              ...e,
              {
                kind: "info",
                key: mkKey(),
                text: `update available: ${result.localVersion} → ${result.latestVersion}`,
              },
            ]);
            setEvents((e) => [
              ...e,
              {
                kind: "info",
                key: mkKey(),
                text: "run:  npm update -g yolo-code  then restart",
              },
            ]);
          }
        }
      });
    }, 30 * 60 * 1000); // 30 minutes
    return () => clearInterval(id);
  }, [cfg]);

  const initMcp = useCallback(async () => {
    if (!cfg || mcpInitRef.current) return;
    const hasUserServers = !!cfg.mcpServers && Object.keys(cfg.mcpServers).length > 0;
    if (!hasUserServers && !cfg.studioMcpUrl) return;
    mcpInitRef.current = true;
    const manager = mcpManagerRef.current;
    let totalTools = 0;

    // Auto-connect to the YOLO Studio MCP server (in-container mcp-proxy at
    // localhost:7780 when in a sandbox). Connected first so studio tools are
    // registered even if a user-configured server later fails.
    if (cfg.studioMcpUrl) {
      try {
        await manager.addHttpServer("yolo-studio", cfg.studioMcpUrl);
        const tools = manager.getAllTools();
        for (const tool of tools) executorRef.current.register(tool);
        mcpToolsRef.current = tools;
        totalTools = tools.length;
      } catch (e) {
        const err = e as Error & { cause?: unknown; code?: string; name?: string };
        const causeStr =
          err.cause instanceof Error
            ? `${err.cause.name}: ${err.cause.message}`
            : err.cause !== undefined
              ? String(err.cause)
              : "";
        const detail = [err.name, err.code, causeStr].filter(Boolean).join(" / ");
        setEvents((es) => [
          ...es,
          {
            kind: "error",
            key: mkKey(),
            text: `studio MCP (${cfg.studioMcpUrl}) failed: ${err.message}${detail ? ` [${detail}]` : ""}`,
          },
        ]);
      }
    }

    for (const [name, server] of Object.entries(cfg.mcpServers ?? {})) {
      if (server.enabled === false) continue;
      try {
        if (server.type === "local" && server.command && server.command.length > 0) {
          await manager.addLocalServer(name, server.command, server.env);
        } else if (server.type === "remote" && server.url) {
          await manager.addRemoteServer(name, server.url, server.headers);
        } else {
          setEvents((e) => [
            ...e,
            { kind: "error", key: mkKey(), text: `MCP server "${name}" has invalid config` },
          ]);
          continue;
        }
        const tools = manager.getAllTools();
        const newTools = tools.filter((t) => !mcpToolsRef.current.some((mt) => mt.name === t.name));
        for (const tool of newTools) {
          executorRef.current.register(tool);
        }
        mcpToolsRef.current = tools;
        totalTools = tools.length;
      } catch (e) {
        setEvents((es) => [
          ...es,
          { kind: "error", key: mkKey(), text: `MCP server "${name}" failed: ${(e as Error).message}` },
        ]);
      }
    }
    if (totalTools > 0) {
      if (cacheStableRef.current) {
        const sessionMsg: ChatMessage = {
          role: "system",
          content: buildSessionPrefix({
            cwd: process.cwd(),
            tools: executorRef.current.list(),
            model: cfg.model ?? DEFAULT_MODEL,
            mode: modeRef.current,
            activeSkills: activeSkillsRef.current,
          }),
        };
        messagesRef.current[1] = sessionMsg;
        systemMessagesRef.current[1] = sessionMsg;
      } else {
        const sysMsg: ChatMessage = {
          role: "system",
          content: buildSystemPrompt({
            cwd: process.cwd(),
            tools: executorRef.current.list(),
            model: cfg.model ?? DEFAULT_MODEL,
            mode: modeRef.current,
            activeSkills: activeSkillsRef.current,
          }),
        };
        messagesRef.current[0] = sysMsg;
        systemMessagesRef.current[0] = sysMsg;
      }
    }
  }, [cfg]);

  useEffect(() => {
    if (cfg && !mcpInitRef.current) {
      void initMcp();
    }
  }, [cfg, initMcp]);

  // Refresh the system/session prefix so any change in the active skill
  // catalog reaches the model on its next turn. Pulled out as a closure
  // because both the initial load and the discovery follow-up call it.
  const refreshPrefixWithActiveSkills = useCallback((): void => {
    if (!cfg) return;
    const cwd = process.cwd();
    if (cacheStableRef.current) {
      const sessionMsg: ChatMessage = {
        role: "system",
        content: buildSessionPrefix({
          cwd,
          tools: executorRef.current.list(),
          model: cfg.model,
          mode: modeRef.current,
          activeSkills: activeSkillsRef.current,
        }),
      };
      if (messagesRef.current.length > 1) messagesRef.current[1] = sessionMsg;
      if (systemMessagesRef.current.length > 1) systemMessagesRef.current[1] = sessionMsg;
    } else {
      const sysMsg: ChatMessage = {
        role: "system",
        content: buildSystemPrompt({
          cwd,
          tools: executorRef.current.list(),
          model: cfg.model,
          mode: modeRef.current,
          activeSkills: activeSkillsRef.current,
        }),
      };
      if (messagesRef.current.length > 0) messagesRef.current[0] = sysMsg;
      if (systemMessagesRef.current.length > 0) systemMessagesRef.current[0] = sysMsg;
    }
  }, [cfg]);

  // Re-read skills from disk, re-apply pins, swap the catalog the `skill`
  // tool sees, and refresh the session prefix. Synchronous up to the
  // discovery step — the LLM relevance pass (when applicable) runs as a
  // fire-and-forget follow-up and refreshes the prefix again on completion.
  const reloadSkills = useCallback(
    (verbose: boolean): void => {
      if (!cfg) return;
      const cwd = process.cwd();
      const trusted = isTrusted(cwd);
      const result = loadAllSkillsWithMeta({ cwd, trusted });
      const pinFiltered = applyPinFilter(result.catalog.list());

      // Synchronous initial state: show the full pin-filtered set so the
      // first prefix render is correct. Discovery refines this below.
      const initialCatalog = new InMemorySkillCatalog(pinFiltered);
      skillCatalogRef.current = initialCatalog;
      executorRef.current.setSkillCatalog(initialCatalog);
      activeSkillsRef.current = catalogToActiveSkills(initialCatalog);

      if (verbose && result.untrustedProjectRoots.length > 0) {
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: `project-level skills found in ${result.untrustedProjectRoots[0]} but not loaded — run \`/skills trust\` (or \`yolo-code skills trust ${cwd}\`) to load them`,
          },
        ]);
      }
      if (verbose) {
        const loaded = pinFiltered;
        const hidden = result.catalog.list().filter((r) => !loaded.find((x) => x.name === r.name));
        if (loaded.length === 0 && hidden.length > 0) {
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: `all ${hidden.length} skill${hidden.length === 1 ? "" : "s"} pinned off (${hidden.map((r) => r.name).join(", ")}) — \`/skills enable <name>\` to re-enable` },
          ]);
        } else if (loaded.length > 0) {
          const suffix = hidden.length > 0
            ? ` (${hidden.length} pinned off: ${hidden.map((r) => r.name).join(", ")})`
            : "";
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: `loaded ${loaded.length} skill${loaded.length === 1 ? "" : "s"}: ${loaded.map((r) => r.name).join(", ")}${suffix}` },
          ]);
        }
      }
      refreshPrefixWithActiveSkills();

      // Discovery follow-up: filter the active set down to skills that
      // are likely relevant. The first call may hit the LLM (~1s); cached
      // calls are immediate. Errors fall through silently — we keep the
      // pin-filtered set as the active set in that case.
      if (pinFiltered.length === 0 || discoverySuppressedRef.current || discoveryDisabled()) {
        previousActiveRef.current = pinFiltered.map((r) => r.name);
        return;
      }
      void runDiscoveryFollowUp(pinFiltered, verbose);
    },
    // runDiscoveryFollowUp is defined below and stable for the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfg, refreshPrefixWithActiveSkills],
  );

  /** Async tail of `reloadSkills`. Runs discovery against the pin-filtered
   *  records and updates the session prefix when it completes. Safe to
   *  fire-and-forget: any exception is swallowed and the user keeps the
   *  pin-filtered set as their active catalog. */
  const runDiscoveryFollowUp = useCallback(
    async (pinFiltered: SkillRecord[], verbose: boolean): Promise<void> => {
      if (!cfg) return;
      const cwd = process.cwd();
      const llm = cfg.routerBaseUrl && cfg.apiToken
        ? makeRouterLlmRelevance({
            baseUrl: cfg.routerBaseUrl,
            apiToken: cfg.apiToken,
            sessionId: sessionIdRef.current ?? undefined,
          })
        : null;
      // Use the most recent user messages as discovery context.
      const recentMessages: string[] = [];
      for (let i = messagesRef.current.length - 1; i >= 0 && recentMessages.length < 3; i--) {
        const m = messagesRef.current[i];
        if (m?.role !== "user") continue;
        if (typeof m.content === "string") recentMessages.unshift(m.content);
        else if (Array.isArray(m.content)) {
          const text = m.content.find((p) => p.type === "text")?.text;
          if (text) recentMessages.unshift(text);
        }
      }

      try {
        const result = await runDiscovery({
          cwd,
          records: pinFiltered,
          recentMessages,
          previousActive: previousActiveRef.current,
          llm,
        });
        const activeCatalog = new InMemorySkillCatalog(result.active);
        skillCatalogRef.current = activeCatalog;
        executorRef.current.setSkillCatalog(activeCatalog);
        activeSkillsRef.current = catalogToActiveSkills(activeCatalog);
        previousActiveRef.current = result.active.map((r) => r.name);

        // Only chat-spam diff events when something actually changed AND
        // either verbose or the diff is non-trivial.
        if (verbose && (result.activated.length > 0 || result.deactivated.length > 0)) {
          const parts: string[] = [];
          if (result.activated.length > 0) parts.push(`+ ${result.activated.join(", ")}`);
          if (result.deactivated.length > 0) parts.push(`- ${result.deactivated.join(", ")}`);
          setEvents((e) => [
            ...e,
            {
              kind: "info",
              key: mkKey(),
              text: `skill-discovery (${result.reason}): ${parts.join("  ")}`,
            },
          ]);
        }
        refreshPrefixWithActiveSkills();
      } catch (e) {
        if (verbose) {
          setEvents((ev) => [
            ...ev,
            {
              kind: "info",
              key: mkKey(),
              text: `skill-discovery failed (${(e as Error).message}) — using all loaded skills`,
            },
          ]);
        }
        previousActiveRef.current = pinFiltered.map((r) => r.name);
      }
    },
    [cfg, refreshPrefixWithActiveSkills],
  );

  // One-shot skills load. Runs after MCP init so we can re-render the
  // session prefix once with the full tool list + skill catalog. Discovery
  // filtering (Phase 5d) lands later — for now every loaded skill is
  // active, minus anything the user has pinned `disable`.
  useEffect(() => {
    if (!cfg || skillsInitRef.current) return;
    skillsInitRef.current = true;
    reloadSkills(true);
  }, [cfg, reloadSkills]);

  const ensureSessionId = useCallback(() => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const firstUser = messagesRef.current.find((m) => m.role === "user");
    let firstText = "session";
    if (typeof firstUser?.content === "string") {
      firstText = firstUser.content;
    } else if (Array.isArray(firstUser?.content)) {
      const textPart = firstUser.content.find((p) => p.type === "text");
      if (textPart?.text) firstText = textPart.text;
    }
    sessionIdRef.current = makeSessionId(firstText);
    return sessionIdRef.current;
  }, []);

  const saveSessionSafe = useCallback(async () => {
    if (!cfg) return;
    ensureSessionId();
    try {
      await saveSession({
        id: sessionIdRef.current!,
        cwd: process.cwd(),
        model: cfg.model,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: messagesRef.current,
        sessionState: compiledContextRef.current ? sessionStateRef.current : undefined,
      });
    } catch {
      /* non-fatal */
    }
  }, [cfg, ensureSessionId]);

  const clearTasksUi = useCallback(() => {
    tasksRef.current = [];
    setTasks([]);
    setTasksStartedAt(null);
    setTasksStartTokens(0);
  }, []);

  useInput((inputChar, key) => {
    if (key.escape) {
      if (busy && activeControllerRef.current) {
        activeControllerRef.current.abort();
        setQueue([]);
        clearTasksUi();
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "(interrupted)" }]);
        emitTrace("turn.interrupt", { source: "escape" });
      }
      return;
    }
    if (key.ctrl && inputChar === "c") {
      if (busy && activeControllerRef.current) {
        activeControllerRef.current.abort();
        setQueue([]);
        clearTasksUi();
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "(interrupted)" }]);
        emitTrace("turn.interrupt", { source: "ctrl-c" });
        return;
      }
      // Idle ctrl-c: clear the draft input + queued messages and stop.
      // Never exits — yolo runs inside YOLO Studio agent tiles, and a
      // reflexive ctrl-c killing the tile would be a surprising loss
      // of work. Users who genuinely want to quit can type /exit.
      // Pairs with `exitOnCtrlC: false` on render() — without that,
      // Ink's built-in handler fires alongside this one and exits anyway.
      setInput("");
      setQueue([]);
      return;
    }
    if (key.ctrl && inputChar === "r") {
      setShowReasoning((s) => !s);
      return;
    }
    if (key.shift && key.tab) {
      setMode((m) => nextMode(m));
      return;
    }
    if (key.ctrl && inputChar === "o") {
      setVerbose((v) => !v);
      return;
    }
    if (key.ctrl && inputChar === "t") {
      setOriginalTheme(theme);
      setShowThemePicker(true);
      return;
    }
  });

  const updateAssistant = useCallback(
    (id: number, patch: (e: Extract<ChatEvent, { kind: "assistant" }>) => Partial<ChatEvent>) => {
      setEvents((evts) =>
        evts.map((e) =>
          e.kind === "assistant" && e.id === id ? ({ ...e, ...patch(e) } as ChatEvent) : e,
        ),
      );
    },
    [],
  );

  const updateTool = useCallback(
    (id: string, patch: Partial<Extract<ChatEvent, { kind: "tool" }>>) => {
      setEvents((evts) =>
        evts.map((e) =>
          e.kind === "tool" && e.id === id ? ({ ...e, ...patch } as ChatEvent) : e,
        ),
      );
    },
    [],
  );

  const runCompact = useCallback(async () => {
    if (!cfg) return;
    if (busy) {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "can't compact while model is running" }]);
      return;
    }
    setBusy(true);
    setTurnStartedAt(Date.now());
    const controller = new AbortController();
    activeControllerRef.current = controller;
    try {
      if (compiledContextRef.current) {
        const result = compactCompiled({
          messages: messagesRef.current,
          state: sessionStateRef.current,
          store: artifactStoreRef.current,
        });
        if (result.metrics.rawTurnsRemoved === 0) {
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: "nothing to compact yet" },
          ]);
        } else {
          messagesRef.current = result.newMessages;
          sessionStateRef.current = result.newState;
          setEvents((e) => [
            ...e,
            {
              kind: "info",
              key: mkKey(),
              text: `compacted ${result.metrics.rawTurnsRemoved} turns → ${result.metrics.estimatedTokensBefore} → ${result.metrics.estimatedTokensAfter} tokens, ${result.metrics.archivedArtifacts} artifacts`,
            },
          ]);
          await saveSessionSafe();
        }
      } else {
        const result = await compactMessages({
          accountId: cfg.accountId,
          apiToken: cfg.apiToken,
          model: cfg.model,
          messages: messagesRef.current,
          signal: controller.signal,
          baseUrl: cfg.routerBaseUrl,
        });
        if (result.replacedCount === 0) {
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: "nothing to compact yet" },
          ]);
        } else {
          messagesRef.current = result.newMessages;
          setEvents((e) => [
            ...e,
            {
              kind: "info",
              key: mkKey(),
              text: `compacted ${result.replacedCount} messages into a summary`,
            },
          ]);
          await saveSessionSafe();
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setEvents((es) => [
          ...es,
          { kind: "error", key: mkKey(), text: `compact failed: ${(e as Error).message}` },
        ]);
      }
    } finally {
      setBusy(false);
      setTurnStartedAt(null);
      activeControllerRef.current = null;
    }
  }, [cfg, busy, saveSessionSafe]);

  const openResumePicker = useCallback(async () => {
    const sessions = await listSessions(200);
    setResumeSessions(sessions);
  }, []);

  const runInit = useCallback(async () => {
    if (!cfg) return;
    if (busy) {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "can't /init while model is running" }]);
      return;
    }
    const cwd = process.cwd();
    for (const name of ["YOLO.md", "YOLO_CODE.md", "AGENT.md"]) {
      if (existsSync(join(cwd, name))) {
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: `${name} already exists at ${join(cwd, name)} — delete it first if you want to regenerate`,
          },
        ]);
        return;
      }
    }
    const prompt = [
      "Generate a YOLO.md at the repository root so future agents have project context.",
      "",
      "First, use the `glob`, `read`, and `grep` tools to understand the project: read `package.json`, the top-level `README.md` if present, the tsconfig / build config, and skim the top-level source directory structure.",
      "",
      "Then call the `write` tool to create `YOLO.md` at the repo root with these sections, terse (aim ≤ 100 lines total):",
      "",
      "- **Project** — one-line description + primary language/runtime.",
      "- **Build / test / run** — exact shell commands an agent should use.",
      "- **Layout** — key directories and what lives in each.",
      "- **Conventions** — naming, import style, file structure, commit style, anything surprising.",
      "- **Do / Don't** — quirks or rules future agents should know.",
      "",
      "Do not call `tasks_set` for this. Just read what you need, then write the file.",
    ].join("\n");

    messagesRef.current.push({ role: "user", content: sanitizeString(prompt) });
    pendingToolUiKeysRef.current.clear();
    setBusy(true);
    setTurnStartedAt(Date.now());
    const controller = new AbortController();
    activeControllerRef.current = controller;

    try {
      await runAgentTurn({
        accountId: cfg.accountId,
        apiToken: cfg.apiToken,
        model: cfg.model,
        messages: messagesRef.current,
        tools: executorRef.current.list(),
        executor: executorRef.current,
        cwd,
        signal: controller.signal,
        reasoningEffort: effortRef.current,
        baseUrl: cfg.routerBaseUrl,
        coauthor:
          cfg.coauthor !== false
            ? { name: cfg.coauthorName || "YOLO Code", email: cfg.coauthorEmail || "noreply@yolo.studio" }
            : undefined,
        sessionId: ensureSessionId(),
        systemMessages: systemMessagesRef.current,
        callbacks: {
          onAssistantStart: () => {
            const id = nextAssistantId++;
            activeAsstIdRef.current = id;
            setEvents((e) => [
              ...e,
              { kind: "assistant", key: `asst_${id}`, id, text: "", reasoning: "", streaming: true },
            ]);
          },
          onReasoningDelta: (d) => {
            const id = activeAsstIdRef.current;
            if (id !== null) updateAssistant(id, (e) => ({ reasoning: e.reasoning + d }));
          },
          onTextDelta: (d) => {
            const id = activeAsstIdRef.current;
            if (id !== null) updateAssistant(id, (e) => ({ text: e.text + d }));
          },
          onAssistantFinal: (msg) => {
            const id = activeAsstIdRef.current;
            if (id !== null) {
              const hadToolCalls = (msg.tool_calls?.length ?? 0) > 0;
              updateAssistant(id, () => ({ streaming: false, hadToolCalls }));
            }
          },
          onToolCallFinalized: (call) => {
            const spec = executorRef.current.list().find((t) => t.name === call.function.name);
            let renderMeta: ToolRender | undefined;
            try {
              const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
              renderMeta = spec?.render?.(args);
            } catch {
              /* ignore */
            }
            // See main turn handler for why we namespace UI ids:
            // upstream may reuse `call.id` across iterations and
            // updateTool() mass-updates every matching event. A FIFO
            // queue per upstream id handles the rare in-message-collision
            // case (two concurrent same-id calls in one assistant
            // message) without dropping rows.
            const uiKey = `tool_${nextToolUiKeyRef.current++}_${call.id}`;
            const existingQueue = pendingToolUiKeysRef.current.get(call.id);
            if (existingQueue) {
              existingQueue.push(uiKey);
            } else {
              pendingToolUiKeysRef.current.set(call.id, [uiKey]);
            }
            setEvents((e) => [
              ...e,
              {
                kind: "tool",
                key: uiKey,
                id: uiKey,
                name: call.function.name,
                args: call.function.arguments,
                status: "running",
                render: renderMeta,
                expanded: false,
              },
            ]);
          },
          onToolResult: (r) => {
            const queue = pendingToolUiKeysRef.current.get(r.tool_call_id);
            const uiKey = queue?.shift();
            if (queue && queue.length === 0) {
              pendingToolUiKeysRef.current.delete(r.tool_call_id);
            }
            if (uiKey) {
              updateTool(uiKey, { status: r.ok ? "done" : "error", result: r.content });
            }
          },
          onUsage: (u) => {
            usageRef.current = u;
            setUsage(u);
            const sid = ensureSessionId();
            void recordUsage(sid, u);
          },
          onRateLimit: (delayMs, message, attempt) => {
            const secs = Math.max(1, Math.round(delayMs / 1000));
            setEvents((e) => [
              ...e,
              {
                kind: "info",
                key: mkKey(),
                text: `rate limited — pausing ${secs}s before retry${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}: ${message}`,
              },
            ]);
          },
          onAutoCompact: (info) => {
            setEvents((e) => [
              ...e,
              {
                kind: "info",
                key: mkKey(),
                text: `tool iteration limit reached after ${info.iterations} rounds — compacting context to continue…`,
              },
            ]);
          },
          onLoopGuardTripped: (info) => {
            setEvents((e) => [
              ...e,
              {
                kind: "info",
                key: mkKey(),
                text: `stopped: ${info.toolName} was called ${info.consecutiveCalls}× in a row — refusing to loop. Tell me what you observed and I'll try a different approach.`,
              },
            ]);
          },
          askPermission: (req) =>
            new Promise<PermissionDecision>((resolve) => {
              if (modeRef.current === "auto") {
                resolve("allow");
                return;
              }
              if (modeRef.current === "plan" && isBlockedInPlanMode(req.tool.name)) {
                if (req.tool.name === "bash" && typeof req.args.command === "string" && isReadOnlyBash(req.args.command)) {
                  resolve("allow");
                  return;
                }
                setEvents((e) => [
                  ...e,
                  {
                    kind: "info",
                    key: mkKey(),
                    text: `plan mode blocked ${req.tool.name}; exit plan mode to execute`,
                  },
                ]);
                resolve("deny");
                return;
              }
              setPerm({ tool: req.tool, args: req.args, sessionKey: req.sessionKey, resolve });
            }),
        },
      });

      if (existsSync(join(cwd, "YOLO.md"))) {
        if (cacheStableRef.current) {
          const sessionMsg: ChatMessage = {
            role: "system",
            content: buildSessionPrefix({
              cwd,
              tools: executorRef.current.list(),
              model: cfg.model,
              mode: modeRef.current,
              activeSkills: activeSkillsRef.current,
            }),
          };
          messagesRef.current[1] = sessionMsg;
          systemMessagesRef.current[1] = sessionMsg;
        } else {
          const sysMsg: ChatMessage = {
            role: "system",
            content: buildSystemPrompt({
              cwd,
              tools: executorRef.current.list(),
              model: cfg.model,
              mode: modeRef.current,
              activeSkills: activeSkillsRef.current,
            }),
          };
          messagesRef.current[0] = sysMsg;
          systemMessagesRef.current[0] = sysMsg;
        }
        setEvents((e) => [
          ...e,
          { kind: "info", key: mkKey(), text: "YOLO.md generated; context loaded for future turns" },
        ]);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setEvents((es) => [
          ...es,
          { kind: "error", key: mkKey(), text: `init failed: ${(e as Error).message}` },
        ]);
      }
    } finally {
      // Finalize any in-flight assistant so it lands in <Static> instead
      // of staying in the live region with streaming:true. Without this,
      // an error mid-stream pins staticCutoff at the dead assistant and
      // every subsequent event (errors, info lines, future turns) keeps
      // re-rendering on every Ink frame — looks like the error at the
      // top of the conversation is "flickering back".
      const id = activeAsstIdRef.current;
      if (id !== null) updateAssistant(id, () => ({ streaming: false }));
      setBusy(false);
      setTurnStartedAt(null);
      activeAsstIdRef.current = null;
      activeControllerRef.current = null;
    }
  }, [cfg, busy, updateAssistant, updateTool]);

  const handleResumePick = useCallback(
    async (picked: SessionSummary | null) => {
      setResumeSessions(null);
      if (!picked) return;
      try {
        const file = await loadSession(picked.filePath);
        const prefixEnd = file.messages.findIndex((m) => m.role !== "system");
        systemMessagesRef.current = prefixEnd === -1 ? file.messages.slice() : file.messages.slice(0, prefixEnd);
        messagesRef.current = file.messages;
        clearOutputHashCache();
        sessionIdRef.current = file.id;
        if (file.sessionState && compiledContextRef.current) {
          sessionStateRef.current = file.sessionState;
          artifactStoreRef.current = new ArtifactStore();
        }
        setEvents([
          {
            kind: "info",
            key: mkKey(),
            text: `resumed session ${picked.id} (${picked.messageCount} msgs)`,
          },
        ]);
        const userMsgs = file.messages
          .filter((m) => m.role === "user" && m.content)
          .map((m) => {
            if (!m.content) return "";
            if (typeof m.content === "string") return m.content;
            const textPart = m.content.find((p) => p.type === "text");
            return textPart?.text ?? "";
          })
          .filter((text) => text.length > 0);
        if (userMsgs.length > 0) setHistory(userMsgs);
        setUsage(null);
      } catch (e) {
        setEvents((es) => [
          ...es,
          { kind: "error", key: mkKey(), text: `failed to load session: ${(e as Error).message}` },
        ]);
      }
    },
    [],
  );

  const openSkillBrowser = useCallback(async (opts: { refresh?: boolean; initialFilter?: string } = {}) => {
    setSkillBrowserBusy(true);
    setSkillBrowserStatus(opts.refresh ? "refreshing registry…" : "loading registry…");
    // Seed the filter BEFORE the state lands so the SkillBrowser's
    // first render (when `state !== null`) already has the filter
    // applied. Codex round 1 P2: this is the path `/skills search
    // <term>` takes — without it the operator's query was thrown
    // away and they had to retype.
    setSkillBrowserInitialFilter(opts.initialFilter ?? "");
    try {
      const { loadSkillBrowserState } = await import("./cli/skills-cmd.js");
      const state = await loadSkillBrowserState({ refresh: opts.refresh });
      setSkillBrowserState(state);
      setSkillBrowserStatus(null);
    } catch (e) {
      setSkillBrowserState({ entries: [], total: 0, error: (e as Error).message });
      setSkillBrowserStatus(null);
    } finally {
      setSkillBrowserBusy(false);
    }
  }, []);

  const handleSkillBrowserAction = useCallback(
    async (action: SkillBrowserAction) => {
      if (action.kind === "close") {
        setSkillBrowserState(null);
        setSkillBrowserStatus(null);
        return;
      }
      if (action.kind === "refresh") {
        await openSkillBrowser({ refresh: true });
        return;
      }
      if (action.kind === "install") {
        setSkillBrowserBusy(true);
        setSkillBrowserStatus(`installing ${action.name}…`);
        try {
          const { skillsInstallReport, loadSkillBrowserState } = await import("./cli/skills-cmd.js");
          const result = await skillsInstallReport(action.name);
          setSkillBrowserStatus(result.text.split("\n")[0] ?? (result.ok ? "installed" : "install failed"));
          if (result.ok) reloadSkills(false);
          // Re-fetch state so the new "installed" badge shows up.
          const state = await loadSkillBrowserState();
          setSkillBrowserState(state);
        } catch (e) {
          setSkillBrowserStatus(`error: ${(e as Error).message}`);
        } finally {
          setSkillBrowserBusy(false);
        }
        return;
      }
      if (action.kind === "uninstall") {
        setSkillBrowserBusy(true);
        setSkillBrowserStatus(`uninstalling ${action.name}…`);
        try {
          const { skillsUninstallReport, loadSkillBrowserState } = await import("./cli/skills-cmd.js");
          const result = await skillsUninstallReport(action.name);
          setSkillBrowserStatus(result.text.split("\n")[0] ?? (result.ok ? "uninstalled" : "uninstall failed"));
          if (result.ok) reloadSkills(false);
          const state = await loadSkillBrowserState();
          setSkillBrowserState(state);
        } catch (e) {
          setSkillBrowserStatus(`error: ${(e as Error).message}`);
        } finally {
          setSkillBrowserBusy(false);
        }
        return;
      }
    },
    [openSkillBrowser, reloadSkills],
  );

  const handleThemePick = useCallback(
    (picked: Theme | null) => {
      if (!picked) {
        // cancel — revert to original
        if (originalTheme) setTheme(originalTheme);
        setShowThemePicker(false);
        setOriginalTheme(null);
        return;
      }
      setTheme(picked);
      setCfg((c) => (c ? { ...c, theme: picked.name } : c));
      if (cfg) void saveConfig({ ...cfg, theme: picked.name }).catch(() => {});
      setShowThemePicker(false);
      setOriginalTheme(null);
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: `theme: ${picked.label}` },
      ]);
    },
    [cfg, originalTheme],
  );

  const handleSlash = useCallback(
    (cmd: string): boolean => {
      const raw = cmd.trim();
      const [head, ...rest] = raw.split(/\s+/);
      const c = (head ?? "").toLowerCase();
      const arg = rest.join(" ").trim().toLowerCase();
      // Case-preserving copy of the argument. Most slash handlers
      // dispatch on lowercase sub-tokens, but some need to read user
      // input as-typed — e.g. `/permissions revoke bash:MyTool`
      // where the session key's casing must round-trip to the
      // executor's Set lookup (codex round 1 on commit 9a65ea94).
      const argRaw = rest.join(" ").trim();

      if (c === "/exit" || c === "/quit") {
        // Defer so the echo + any final state can paint before Ink unmounts.
        setImmediate(() => exit());
        return true;
      }
      if (c === "/clear") {
        if (cacheStableRef.current && messagesRef.current.length >= 2) {
          systemMessagesRef.current = [messagesRef.current[0]!, messagesRef.current[1]!];
        } else {
          systemMessagesRef.current = [messagesRef.current[0]!];
        }
        messagesRef.current = systemMessagesRef.current.slice();
        clearOutputHashCache();
        sessionIdRef.current = null;
        sessionStateRef.current = emptySessionState();
        artifactStoreRef.current = new ArtifactStore();
        executorRef.current.clearArtifacts();
        setEvents([]);
        setUsage(null);
        setTasks([]);
        setTasksStartedAt(null);
        setTasksStartTokens(0);
        compactSuggestedRef.current = false;
        updateNudgedRef.current = false;
        return true;
      }
      if (c === "/reasoning") {
        setShowReasoning((s) => {
          const next = !s;
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: `reasoning: ${next ? "shown" : "hidden"}` },
          ]);
          return next;
        });
        return true;
      }
      if (c === "/cost") {
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: usage
              ? `prompt ${usage.prompt_tokens} / completion ${usage.completion_tokens}`
              : "no usage yet",
          },
        ]);
        return true;
      }
      // 2026-05-13: `/expand [art_N]` retrieves a previously-reduced tool
      // output by artifact id (the `art_NN` references that appear in
      // dedup'd or truncated tool result summaries). Same data the model
      // gets via the `expand_artifact` tool, surfaced as a one-keystroke
      // operator command. Default (no arg) expands the latest artifact;
      // `/expand list` shows the stored ids; `/expand <id>` targets a
      // specific one. Ink's <Static> can't toggle an existing event's
      // expansion in place (commits each event once), so expansion is
      // append-only — a new info event with the raw content is added
      // below the truncated row.
      if (c === "/expand" || c === "/x") {
        const store = executorRef.current.getArtifactStore();
        if (arg === "list") {
          const ids = store.listIds();
          setEvents((e) => [
            ...e,
            {
              kind: "info",
              key: mkKey(),
              text:
                ids.length === 0
                  ? "no stored artifacts"
                  : `${ids.length} stored artifact${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}`,
            },
          ]);
          return true;
        }
        // Normalize argument: accept `art_42`, `42`, or empty (latest).
        let targetId: string | undefined;
        if (!arg) {
          targetId = store.latestId();
          if (!targetId) {
            setEvents((e) => [
              ...e,
              {
                kind: "info",
                key: mkKey(),
                text: "no artifacts yet — run a tool whose output gets truncated/dedup'd first",
              },
            ]);
            return true;
          }
        } else {
          targetId = /^art_\d+$/.test(arg) ? arg : /^\d+$/.test(arg) ? `art_${arg}` : arg;
        }
        const raw = store.retrieve(targetId);
        if (raw === undefined) {
          setEvents((e) => [
            ...e,
            {
              kind: "info",
              key: mkKey(),
              text: `artifact "${targetId}" not found (may have been evicted). \`/expand list\` shows what's available.`,
            },
          ]);
          return true;
        }
        // Hard cap so a runaway 5MB artifact doesn't lock the TUI for
        // tens of seconds. The model's `expand_artifact` tool has no
        // such cap — that path is fine because LLM context bears the
        // bound — but for the human-rendered path we want predictable
        // latency. Tail of the artifact (last N chars) is usually what
        // the operator wants; an opening "head" hint covers the rest.
        const MAX_DISPLAY = 32_000;
        const header = `─── ${targetId} (${raw.length.toLocaleString()} chars) ───`;
        const body =
          raw.length <= MAX_DISPLAY
            ? raw
            : `${raw.slice(0, 4_000)}\n\n… (${(raw.length - MAX_DISPLAY).toLocaleString()} chars elided — head + tail shown) …\n\n${raw.slice(-(MAX_DISPLAY - 4_000))}`;
        setEvents((e) => [
          ...e,
          { kind: "info", key: mkKey(), text: `${header}\n${body}` },
        ]);
        return true;
      }
      // 2026-05-13: /permissions  — list/revoke the session-allowed
      // tool permissions an operator has granted via the "Allow for
      // this session" path in the permission modal. Plumbing for that
      // set existed before this commit but there was no way to see or
      // revoke individual entries short of /clear (which nukes the
      // whole conversation).
      if (c === "/permissions") {
        const sub = arg.split(/\s+/)[0] ?? "";
        if (sub === "" || sub === "list") {
          const perms = executorRef.current.listSessionPermissions();
          setEvents((e) => [
            ...e,
            {
              kind: "info",
              key: mkKey(),
              text:
                perms.length === 0
                  ? "no session-allowed permissions yet"
                  : `${perms.length} session-allowed ${perms.length === 1 ? "entry" : "entries"}:\n  ` +
                    perms.join("\n  ") +
                    "\n\nuse `/permissions revoke <key>` to revoke one, `/permissions clear` to revoke all",
            },
          ]);
          return true;
        }
        if (sub === "clear" || sub === "revoke-all") {
          executorRef.current.clearSessionPermissions();
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: "all session-allowed permissions revoked" },
          ]);
          return true;
        }
        if (sub === "revoke") {
          // Use argRaw (case-preserving) so a key like `bash:MyTool`
          // round-trips correctly to the Set lookup. The previous
          // implementation lowercased every key and missed any with
          // uppercase chars (codex round 1 P2 on 9a65ea94).
          const key = argRaw.slice("revoke".length).trim();
          if (!key) {
            setEvents((e) => [
              ...e,
              { kind: "info", key: mkKey(), text: "usage: /permissions revoke <key>" },
            ]);
            return true;
          }
          const removed = executorRef.current.revokeSessionPermission(key);
          setEvents((e) => [
            ...e,
            {
              kind: "info",
              key: mkKey(),
              text: removed
                ? `revoked: ${key}`
                : `no session-allowed entry matching "${key}" (use \`/permissions list\` to see ids)`,
            },
          ]);
          return true;
        }
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: "usage: /permissions [list | revoke <key> | clear]",
          },
        ]);
        return true;
      }
      if (c === "/model") {
        setEvents((e) => [
          ...e,
          { kind: "info", key: mkKey(), text: `current model: ${cfg?.model ?? "unknown"}` },
        ]);
        return true;
      }
      if (c === "/thinking" || c === "/effort") {
        if (!arg) {
          setEvents((e) => [
            ...e,
            {
              kind: "info",
              key: mkKey(),
              text: `current: ${effort}  ·  ${EFFORT_DESCRIPTIONS[effort]}\nuse: /thinking low | medium | high`,
            },
          ]);
          return true;
        }
        if (arg === "low" || arg === "medium" || arg === "high") {
          setEffort(arg);
          if (cfg) void saveConfig({ ...cfg, reasoningEffort: arg }).catch(() => {});
          setEvents((e) => [
            ...e,
            {
              kind: "info",
              key: mkKey(),
              text: `thinking: ${arg}  ·  ${EFFORT_DESCRIPTIONS[arg]}`,
            },
          ]);
          return true;
        }
        setEvents((e) => [
          ...e,
          { kind: "info", key: mkKey(), text: "usage: /thinking low | medium | high" },
        ]);
        return true;
      }
      if (c === "/theme") {
        if (!arg) {
          setOriginalTheme(theme);
          setShowThemePicker(true);
          return true;
        }
        const next = resolveTheme(arg);
        if (next.name !== arg) {
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: `unknown theme "${arg}" — available: ${themeNames().join(", ")}` },
          ]);
          return true;
        }
        setTheme(next);
        setCfg((c) => (c ? { ...c, theme: next.name } : c));
        if (cfg) void saveConfig({ ...cfg, theme: next.name }).catch(() => {});
        setEvents((e) => [
          ...e,
          { kind: "info", key: mkKey(), text: `theme: ${next.label}` },
        ]);
        return true;
      }
      if (c === "/mode") {
        if (!arg) {
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: `current mode: ${mode}  ·  use /mode edit|plan|auto or shift+tab` },
          ]);
          return true;
        }
        if (arg === "edit" || arg === "plan" || arg === "auto") {
          setMode(arg);
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: `mode: ${arg}` },
          ]);
          return true;
        }
        setEvents((e) => [
          ...e,
          { kind: "info", key: mkKey(), text: "usage: /mode edit|plan|auto" },
        ]);
        return true;
      }
      if (c === "/plan") {
        setMode("plan");
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "mode: plan" }]);
        return true;
      }
      if (c === "/auto") {
        setMode("auto");
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "mode: auto" }]);
        return true;
      }
      if (c === "/edit") {
        setMode("edit");
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "mode: edit" }]);
        return true;
      }
      if (c === "/cost") {
        if (!sessionIdRef.current) {
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "no usage recorded yet" }]);
          return true;
        }
        void getCostReport(sessionIdRef.current).then((report) => {
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: formatCostReport(report) },
          ]);
        });
        return true;
      }
      if (c === "/resume") {
        void openResumePicker();
        return true;
      }
      if (c === "/compact") {
        void runCompact();
        return true;
      }
      if (c === "/init") {
        void runInit();
        return true;
      }
      if (c === "/update") {
        void checkForUpdate(true).then((result) => {
          if (result.hasUpdate) {
            setHasUpdate(true);
            setLatestVersion(result.latestVersion);
            setEvents((e) => [
              ...e,
              {
                kind: "info",
                key: mkKey(),
                text: `update available: ${result.localVersion} → ${result.latestVersion}`,
              },
            ]);
            setEvents((e) => [
              ...e,
              {
                kind: "info",
                key: mkKey(),
                text: "run:  npm update -g yolo-code  then restart",
              },
            ]);
          } else {
            setHasUpdate(false);
            setLatestVersion(null);
            setEvents((e) => [
              ...e,
              { kind: "info", key: mkKey(), text: "no update available" },
            ]);
          }
        });
        return true;
      }
      if (c === "/mcp") {
        if (arg === "list") {
          const servers = mcpManagerRef.current.listServers();
          if (servers.length === 0) {
            setEvents((e) => [
              ...e,
              { kind: "info", key: mkKey(), text: "no MCP servers connected — add them to ~/.config/yolo-code/config.json" },
            ]);
          } else {
            const lines = servers.map((s) => `  ${s.name} (${s.type}) — ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`);
            setEvents((e) => [
              ...e,
              { kind: "info", key: mkKey(), text: "MCP servers:\n" + lines.join("\n") },
            ]);
          }
          return true;
        }
        if (arg === "reload") {
          if (busy) {
            setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "can't /mcp reload while model is running" }]);
            return true;
          }
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "reloading MCP servers..." }]);
          for (const tool of mcpToolsRef.current) {
            executorRef.current.unregister(tool.name);
          }
          mcpToolsRef.current = [];
          mcpInitRef.current = false;
          void initMcp();
          return true;
        }
        setEvents((e) => [
          ...e,
          { kind: "info", key: mkKey(), text: "usage: /mcp list | reload" },
        ]);
        return true;
      }
      if (c === "/logout") {
        unlink(configPath()).catch(() => {});
        setEvents((e) => [
          ...e,
          { kind: "info", key: mkKey(), text: `credentials cleared from ${configPath()}` },
        ]);
        setCfg(null);
        return true;
      }
      if (c === "/skills") {
        const sub = (rest[0] ?? "").toLowerCase();
        const skillName = (rest[1] ?? "").trim();
        if (!sub || sub === "list") {
          const cat = skillCatalogRef.current;
          const records = cat ? cat.list() : [];
          const pins = readPins();
          if (records.length === 0 && pins.disabled.length === 0) {
            setEvents((e) => [
              ...e,
              { kind: "info", key: mkKey(), text: "no skills loaded — try `/skills browse` to see the registry, then `/skills install <name>` (or drop a SKILL.md in .yolo/skills/)" },
            ]);
            return true;
          }
          const lines = records
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((r) => {
              const pin = pins.disabled.includes(r.name)
                ? " (off)"
                : pins.enabled.includes(r.name)
                  ? " (on)"
                  : "";
              return `  ${r.name}${pin} — ${r.description.slice(0, 80)}`;
            });
          // Show pinned-off skills that aren't in the loaded catalog (they
          // exist on disk but are filtered out).
          const offNotShown = pins.disabled.filter((n) => !records.find((r) => r.name === n));
          if (offNotShown.length > 0) {
            for (const n of offNotShown) lines.push(`  ${n} (off, hidden)`);
          }
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: `skills:\n${lines.join("\n")}` },
          ]);
          return true;
        }
        if (sub === "info") {
          if (!skillName) {
            setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /skills info <name>" }]);
            return true;
          }
          const cat = skillCatalogRef.current;
          const r = cat?.get(skillName);
          if (!r) {
            setEvents((e) => [
              ...e,
              { kind: "info", key: mkKey(), text: `no skill named "${skillName}" — try \`/skills list\`` },
            ]);
            return true;
          }
          const head =
            `${r.name}  (${r.scope}, ${r.path})\n` +
            `${r.description}\n\n` +
            (r.body.length > 1200 ? r.body.slice(0, 1200) + "\n…(truncated; use `yolo-code skills info` for full body)" : r.body);
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: head }]);
          return true;
        }
        if (sub === "enable") {
          if (!skillName) {
            setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /skills enable <name>" }]);
            return true;
          }
          pinEnable(skillName);
          reloadSkills(false);
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `pinned on: ${skillName}` }]);
          return true;
        }
        if (sub === "disable") {
          if (!skillName) {
            setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /skills disable <name>" }]);
            return true;
          }
          pinDisable(skillName);
          reloadSkills(false);
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `pinned off: ${skillName}` }]);
          return true;
        }
        if (sub === "clear" || sub === "clear-pin") {
          if (!skillName) {
            setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /skills clear <name>" }]);
            return true;
          }
          pinClear(skillName);
          reloadSkills(false);
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `cleared pin: ${skillName}` }]);
          return true;
        }
        if (sub === "trust") {
          const cwd = process.cwd();
          // skills/trust.ts is already imported above. Re-use its helper.
          void import("./skills/trust.js").then(({ addTrusted }) => {
            addTrusted(cwd);
            reloadSkills(true);
            setEvents((e) => [
              ...e,
              { kind: "info", key: mkKey(), text: `trusted: ${cwd}` },
            ]);
          });
          return true;
        }
        if (sub === "reload") {
          reloadSkills(true);
          return true;
        }
        if (sub === "browse" || sub === "search") {
          // 2026-05-13: open the interactive SkillBrowser TUI instead of
          // dumping a padded-column text table into the chat. The TUI
          // provides filter-as-you-type, cursor navigation, a detail
          // pane, and inline install/uninstall — operators reported
          // the text-mode renderer as cluttered and unusable.
          //
          // `/skills search <q>` threads the query into `initialFilter`
          // so the browser opens with results already filtered, matching
          // the pre-TUI text-mode behavior (codex round 1 P2 fix). The
          // text-mode `skillsBrowse` is still available for
          // non-interactive (yolo-code CLI / scripts) callers via
          // `yolo-code skills search`.
          const query = rest.slice(1).join(" ").trim();
          void openSkillBrowser({ initialFilter: query || undefined });
          return true;
        }
        if (sub === "install") {
          const target = rest.slice(1).join(" ").trim();
          if (!target) {
            setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /skills install <name> | <git-url>" }]);
            return true;
          }
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `installing ${target}…` }]);
          void import("./cli/skills-cmd.js").then(async ({ skillsInstallReport }) => {
            const result = await skillsInstallReport(target);
            setEvents((e) => [...e, { kind: "info", key: mkKey(), text: result.text }]);
            // Reload so the new skill shows up in the catalog and in /skills list.
            if (result.ok) reloadSkills(true);
          });
          return true;
        }
        if (sub === "uninstall") {
          if (!skillName) {
            setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /skills uninstall <name>" }]);
            return true;
          }
          void import("./cli/skills-cmd.js").then(async ({ skillsUninstallReport }) => {
            const result = await skillsUninstallReport(skillName);
            setEvents((e) => [...e, { kind: "info", key: mkKey(), text: result.text }]);
            if (result.ok) reloadSkills(true);
          });
          return true;
        }
        if (sub === "discovery") {
          const action = (rest[1] ?? "").toLowerCase();
          if (action === "off") {
            discoverySuppressedRef.current = true;
            setEvents((e) => [
              ...e,
              { kind: "info", key: mkKey(), text: "skill-discovery: off (this session). All loaded skills are active." },
            ]);
            reloadSkills(false);
            return true;
          }
          if (action === "on") {
            discoverySuppressedRef.current = false;
            setEvents((e) => [
              ...e,
              { kind: "info", key: mkKey(), text: "skill-discovery: on" },
            ]);
            reloadSkills(true);
            return true;
          }
          if (action === "refresh") {
            clearDiscoveryCache();
            reloadSkills(true);
            return true;
          }
          if (!action || action === "status") {
            const status = discoveryDisabled()
              ? "off (env: YOLO_CODE_SKILL_DISCOVERY=0)"
              : discoverySuppressedRef.current
                ? "off (this session — `/skills discovery on` to re-enable)"
                : "on";
            setEvents((e) => [
              ...e,
              { kind: "info", key: mkKey(), text: `skill-discovery: ${status}` },
            ]);
            return true;
          }
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: "usage: /skills discovery [on|off|refresh|status]" },
          ]);
          return true;
        }
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: "usage: /skills [list|info|browse|search|enable|disable|clear|trust|reload|discovery] [name|query]",
          },
        ]);
        return true;
      }
      if (c === "/help") {
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text:
              "commands:\n" +
              "  /mode edit|plan|auto    switch mode (or shift+tab to cycle)\n" +
              "  /plan /auto /edit       shortcuts for /mode\n" +
              "  /thinking low|med|high  set reasoning effort (quality vs speed)\n" +
              "  /theme                  interactive theme picker (or ctrl+t)\n" +
              "  /theme NAME             set theme by name\n" +
              "  /resume                 pick a past conversation\n" +
              "  /compact                summarize old turns to free context\n" +
              "  /init                   scan this repo and write a YOLO.md for future agents\n" +
              "  /mcp list               list connected MCP servers and tools\n" +
              "  /mcp reload             reconnect all configured MCP servers\n" +
              "  /trace on|off|status    write detailed JSONL trace to disk for debugging\n" +
              "  /skills                 list skills (or info|enable|disable|clear|trust|reload <name>)\n" +
              "  /skills discovery       on|off|refresh|status — control LLM-driven skill filtering\n" +
              "  /reasoning              toggle show/hide model reasoning\n" +
              "  /clear                  clear current conversation\n" +
              "  /expand [art_N]         expand a truncated tool result (default: latest); /expand list to enumerate\n" +
              "  /permissions [...]      list | revoke <key> | clear — manage session-allowed tool permissions\n" +
              "  /cost /model /update /logout /help /exit\n" +
              "keys: ctrl-c interrupt turn / clear input · ctrl-r toggle reasoning · ctrl-o verbose · ctrl+t theme · shift+tab cycle mode · ↑/↓ history",
          },
        ]);
        return true;
      }
      if (c === "/trace" || c === "/debug") {
        if (!arg || arg === "status") {
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: `trace: ${traceEnabled ? "on" : "off"}  ·  ${tracePath()}` },
          ]);
          return true;
        }
        if (arg === "on") {
          setTraceEnabled(true);
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: `trace: on  ·  ${tracePath()}` },
          ]);
          void logTrace({
            event: "trace.enabled",
            sessionId: sessionIdRef.current ?? undefined,
          });
          return true;
        }
        if (arg === "off") {
          emitTrace("trace.disabled");
          setTraceEnabled(false);
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: `trace: off  ·  ${tracePath()}` },
          ]);
          return true;
        }
        setEvents((e) => [
          ...e,
          { kind: "info", key: mkKey(), text: "usage: /trace on|off|status" },
        ]);
        return true;
      }
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: `unknown command "${head}" — try /help` },
      ]);
      return true;
    },
    [cfg, exit, usage, effort, theme, mode, openResumePicker, openSkillBrowser, runCompact, runInit, initMcp, reloadSkills, traceEnabled, emitTrace],
  );

  const processMessage = useCallback(
    async (text: string, displayText?: string) => {
      if (!cfg) return;
      const trimmed = text.trim();
      if (!trimmed) return;

      if (trimmed.startsWith("/")) {
        if (handleSlash(trimmed)) {
          // Splice a user echo in *before* any info/error events the slash
          // handler just appended, so the transcript reads `› /skills`
          // then `· reply…` rather than reply-then-command.
          setEvents((e) => {
            const echo: ChatEvent = { kind: "user", key: mkKey(), text: trimmed };
            for (let i = e.length - 1; i >= 0; i--) {
              if (e[i]!.kind === "user" || e[i]!.kind === "assistant" || e[i]!.kind === "tool") {
                return [...e.slice(0, i + 1), echo, ...e.slice(i + 1)];
              }
            }
            return [echo, ...e];
          });
          return;
        }
      }

      const display = displayText?.trim() || trimmed;
      const imagePaths = findImagePaths(trimmed).slice(0, MAX_IMAGES_PER_MESSAGE);
      let images: string[] = [];
      let content: string | ContentPart[] = sanitizeString(trimmed);

      if (imagePaths.length > 0) {
        const encoded = await Promise.all(
          imagePaths.map(async (path) => {
            try {
              const img = await encodeImageFile(path);
              return { path, img };
            } catch (e) {
              setEvents((es) => [
                ...es,
                { kind: "error", key: mkKey(), text: `failed to encode image ${path}: ${(e as Error).message}` },
              ]);
              return null;
            }
          }),
        );
        const valid = encoded.filter((x): x is { path: string; img: EncodedImage } => x !== null);
        if (valid.length > 0) {
          images = valid.map((v) => v.img.filename);
          const parts: ContentPart[] = [
            { type: "text", text: sanitizeString(trimmed) },
            ...valid.map((v) => ({ type: "image_url" as const, image_url: { url: v.img.dataUrl } })),
          ];
          content = parts;
        }
      }

      setEvents((e) => [...e, { kind: "user", key: mkKey(), text: display, images: images.length > 0 ? images : undefined }]);
      emitTrace("turn.submit", {
        displayPreview: display.slice(0, 200),
        fullPreview: trimmed.slice(0, 200),
        fullLength: trimmed.length,
        containsPastePlaceholder: /\[pasted \d+ line/.test(display),
      });
      messagesRef.current.push({ role: "user", content });
      // Drop any pending UI-key mappings from a prior aborted turn so a
      // colliding tool_call_id in the new turn can't get routed to the
      // previous turn's UI event.
      pendingToolUiKeysRef.current.clear();
      // Reset the repeated-call streak detector so identical calls at
      // the end of the previous turn + a matching call at the start of
      // this one don't trip `tool.repeated_pattern` as a false positive.
      // The "model is in a loop" signal only makes sense within a turn.
      repeatedCallTrackerRef.current.reset();

      // Recall artifacts before sending if compiled context is enabled
      if (compiledContextRef.current) {
        const { ids, recalled } = recallArtifacts(messagesRef.current, artifactStoreRef.current, sessionStateRef.current);
        if (recalled.length > 0) {
          const recalledText = formatRecalledArtifacts(recalled);
          messagesRef.current.push({ role: "system", content: recalledText });
          sessionStateRef.current = {
            ...sessionStateRef.current,
            artifact_index: { ...sessionStateRef.current.artifact_index },
          };
        }
      }

      setBusy(true);
      setTurnStartedAt(Date.now());

      const controller = new AbortController();
      activeControllerRef.current = controller;

      try {
        await runAgentTurn({
          accountId: cfg.accountId,
          apiToken: cfg.apiToken,
          model: cfg.model,
          messages: messagesRef.current,
          tools: executorRef.current.list(),
          executor: executorRef.current,
          cwd: process.cwd(),
          signal: controller.signal,
          reasoningEffort: effortRef.current,
          baseUrl: cfg.routerBaseUrl,
          coauthor:
            cfg.coauthor !== false
              ? { name: cfg.coauthorName || "YOLO Code", email: cfg.coauthorEmail || "noreply@yolo.studio" }
              : undefined,
          sessionId: ensureSessionId(),
          keepLastImageTurns: cfg.imageHistoryTurns ?? 2,
          systemMessages: systemMessagesRef.current,
          callbacks: {
            onAssistantStart: () => {
              const id = nextAssistantId++;
              activeAsstIdRef.current = id;
              setEvents((e) => [
                ...e,
                { kind: "assistant", key: `asst_${id}`, id, text: "", reasoning: "", streaming: true },
              ]);
            },
            onReasoningDelta: (d) => {
              const id = activeAsstIdRef.current;
              if (id !== null) updateAssistant(id, (e) => ({ reasoning: e.reasoning + d }));
            },
            onTextDelta: (d) => {
              const id = activeAsstIdRef.current;
              if (id !== null) updateAssistant(id, (e) => ({ text: e.text + d }));
            },
            onAssistantFinal: (msg) => {
              const id = activeAsstIdRef.current;
              if (id !== null) {
                const hadToolCalls = (msg.tool_calls?.length ?? 0) > 0;
                updateAssistant(id, () => ({ streaming: false, hadToolCalls }));
              }
            },
            onToolCallFinalized: (call) => {
              const spec = executorRef.current.list().find((t) => t.name === call.function.name);
              let renderMeta: ToolRender | undefined;
              try {
                const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
                renderMeta = spec?.render?.(args);
              } catch {
                /* ignore render failure */
              }
              // Mint a unique UI key per call regardless of whether the
              // upstream reuses `call.id`. The protocol id stays in the
              // trace event and the LLM message stream (where adjacency
              // pairing is what matters); the events array uses uiKey
              // so React keys are unique and updateTool routes back to
              // the exact event when the result lands.
              const uiKey = `tool_${nextToolUiKeyRef.current++}_${call.id}`;
              const existingQueue = pendingToolUiKeysRef.current.get(call.id);
              if (existingQueue) {
                existingQueue.push(uiKey);
              } else {
                pendingToolUiKeysRef.current.set(call.id, [uiKey]);
              }
              setEvents((e) => [
                ...e,
                {
                  kind: "tool",
                  key: uiKey,
                  id: uiKey,
                  name: call.function.name,
                  args: call.function.arguments,
                  status: "running",
                  render: renderMeta,
                  expanded: false,
                },
              ]);
              const argsFingerprint = hashString(call.function.arguments ?? "");
              const repeatStreak = repeatedCallTrackerRef.current.record(
                call.function.name,
                argsFingerprint,
              );
              emitTrace("tool.call", {
                toolCallId: call.id,
                name: call.function.name,
                argsFingerprint,
                // redactedPayload routes JSON args through the JSON-key
                // redactor and withholds the raw text preview, closing
                // the leak where short secrets under credential-named
                // keys (e.g. {"password":"hunter2"}) used to survive in
                // the safePreview text. Falls back to safePreview for
                // non-JSON arguments.
                ...redactedPayload(call.function.arguments ?? ""),
              });
              if (repeatStreak > 0) {
                emitTrace("tool.repeated_pattern", {
                  toolCallId: call.id,
                  name: call.function.name,
                  argsFingerprint,
                  streak: repeatStreak,
                });
              }
            },
            onToolResult: (r) => {
              const queue = pendingToolUiKeysRef.current.get(r.tool_call_id);
              const uiKey = queue?.shift();
              if (queue && queue.length === 0) {
                pendingToolUiKeysRef.current.delete(r.tool_call_id);
              }
              if (uiKey) {
                updateTool(uiKey, {
                  status: r.ok ? "done" : "error",
                  result: r.content,
                });
              }
              emitTrace("tool.result", {
                toolCallId: r.tool_call_id,
                name: r.name,
                ok: r.ok,
                rawBytes: r.rawBytes,
                reducedBytes: r.reducedBytes,
                artifactId: r.artifactId,
                ...redactedPayload(r.content),
              });
            },
            onUsage: (u) => {
              usageRef.current = u;
              setUsage(u);
            },
            onRateLimit: (delayMs, message, attempt) => {
              emitTrace("turn.rate_limited", { delayMs, message, attempt });
              const secs = Math.max(1, Math.round(delayMs / 1000));
              setEvents((e) => [
                ...e,
                {
                  kind: "info",
                  key: mkKey(),
                  text: `rate limited — pausing ${secs}s before retry${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}: ${message}`,
                },
              ]);
            },
            onAutoCompact: (info) => {
              emitTrace("turn.auto_compact", info);
              setEvents((e) => [
                ...e,
                {
                  kind: "info",
                  key: mkKey(),
                  text: `tool iteration limit reached after ${info.iterations} rounds — compacting context to continue…`,
                },
              ]);
            },
            onLoopGuardTripped: (info) => {
              emitTrace("turn.loop_guard_tripped", info);
              setEvents((e) => [
                ...e,
                {
                  kind: "info",
                  key: mkKey(),
                  text: `stopped: ${info.toolName} was called ${info.consecutiveCalls}× in a row — refusing to loop. Tell me what you observed and I'll try a different approach.`,
                },
              ]);
            },
            onTasks: (nextTasks) => {
              const prevEmpty = tasksRef.current.length === 0;
              tasksRef.current = nextTasks;
              setTasks(nextTasks);
              if (prevEmpty && nextTasks.length > 0) {
                setTasksStartedAt(Date.now());
                setTasksStartTokens(usageRef.current?.prompt_tokens ?? 0);
              }
              if (nextTasks.length === 0) {
                setTasksStartedAt(null);
                setTasksStartTokens(0);
              }
            },
            askPermission: (req) =>
              new Promise<PermissionDecision>((resolve) => {
                if (modeRef.current === "auto") {
                  emitTrace("permission.decision", { tool: req.tool.name, decision: "allow-auto" });
                  resolve("allow");
                  return;
                }
                if (modeRef.current === "plan" && isBlockedInPlanMode(req.tool.name)) {
                  if (req.tool.name === "bash" && typeof req.args.command === "string" && isReadOnlyBash(req.args.command)) {
                    emitTrace("permission.decision", { tool: req.tool.name, decision: "allow-plan-readonly" });
                    resolve("allow");
                    return;
                  }
                  setEvents((e) => [
                    ...e,
                    {
                      kind: "info",
                      key: mkKey(),
                      text: `plan mode blocked ${req.tool.name}; exit plan mode to execute`,
                    },
                  ]);
                  emitTrace("permission.decision", { tool: req.tool.name, decision: "deny-plan-mode" });
                  resolve("deny");
                  return;
                }
                emitTrace("permission.request", {
                  tool: req.tool.name,
                  argsPreview: JSON.stringify(req.args).slice(0, 300),
                });
                setPerm({ tool: req.tool, args: req.args, sessionKey: req.sessionKey, resolve });
              }),
          },
        });
        await saveSessionSafe();

        // Auto-compact after turn if compiled context is enabled and thresholds are met
        if (compiledContextRef.current && shouldCompact({ messages: messagesRef.current })) {
          const result = compactCompiled({
            messages: messagesRef.current,
            state: sessionStateRef.current,
            store: artifactStoreRef.current,
          });
          if (result.metrics.rawTurnsRemoved > 0) {
            messagesRef.current = result.newMessages;
            sessionStateRef.current = result.newState;
            setEvents((e) => [
              ...e,
              {
                kind: "info",
                key: mkKey(),
                text: `auto-compacted: ${result.metrics.estimatedTokensBefore} → ${result.metrics.estimatedTokensAfter} tokens (${result.metrics.archivedArtifacts} artifacts)`,
              },
            ]);
            await saveSessionSafe();
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          clearTasksUi();
          emitTrace("turn.aborted", {
            queueDepth: queue.length,
            assistantInFlight: activeAsstIdRef.current !== null,
          });
          setEvents((es) => [...es, { kind: "info", key: mkKey(), text: "(aborted)" }]);
        } else {
          emitTrace("turn.error", {
            name: (e as Error).name ?? "Error",
            message: (e as Error).message ?? String(e),
            httpStatus: e instanceof KimiApiError ? e.httpStatus : undefined,
          });
          const isInvalidJson400 =
            e instanceof KimiApiError &&
            e.httpStatus === 400 &&
            e.message.includes("invalid escaped character");
          if (isInvalidJson400) {
            messagesRef.current.pop();
            setEvents((es) => [
              ...es,
              {
                kind: "error",
                key: mkKey(),
                text: "API rejected request (invalid JSON in conversation history). Retrying may work; run /clear to reset if it persists.",
              },
            ]);
          } else {
            setEvents((es) => [
              ...es,
              { kind: "error", key: mkKey(), text: (e as Error).message ?? String(e) },
            ]);
          }
        }
      } finally {
        // See companion finally in initSession — finalize any in-flight
        // assistant so a mid-stream error doesn't pin staticCutoff and
        // make subsequent events redraw on every frame.
        const id = activeAsstIdRef.current;
        if (id !== null) updateAssistant(id, () => ({ streaming: false }));
        setBusy(false);
        setTurnStartedAt(null);
        activeAsstIdRef.current = null;
        activeControllerRef.current = null;
      }
    },
    [cfg, handleSlash, updateAssistant, updateTool, saveSessionSafe, clearTasksUi, emitTrace],
  );

  useEffect(() => {
    if (!busy && queue.length > 0) {
      const next = queue[0]!;
      setQueue((q) => q.slice(1));
      processMessage(next.full, next.display);
    }
  }, [busy, queue, processMessage]);

  const submit = useCallback(
    (full: string, display?: string) => {
      const trimmedFull = full.trim();
      if (!trimmedFull) return;
      const trimmedDisplay = (display ?? full).trim() || trimmedFull;

      const historyEntry = trimmedDisplay;

      if (busy) {
        emitTrace("turn.queued", {
          displayPreview: trimmedDisplay.slice(0, 200),
          fullLength: trimmedFull.length,
        });
        setQueue((q) => [...q, { full: trimmedFull, display: trimmedDisplay }]);
        setHistory((h) => (h.length > 0 && h[h.length - 1] === historyEntry ? h : [...h, historyEntry]));
        setInput("");
        setHistoryIndex(-1);
        return;
      }

      setHistory((h) => (h.length > 0 && h[h.length - 1] === historyEntry ? h : [...h, historyEntry]));
      setInput("");
      setHistoryIndex(-1);
      emitTrace("turn.dispatch", {
        displayPreview: trimmedDisplay.slice(0, 200),
        fullLength: trimmedFull.length,
      });
      processMessage(trimmedFull, trimmedDisplay !== trimmedFull ? trimmedDisplay : undefined);
    },
    [busy, processMessage, emitTrace],
  );

  useEffect(() => {
    if (compactSuggestedRef.current) return;
    if (usage && usage.prompt_tokens / CONTEXT_LIMIT >= AUTO_COMPACT_SUGGEST_PCT) {
      compactSuggestedRef.current = true;
      setEvents((e) => [
        ...e,
        {
          kind: "info",
          key: mkKey(),
          text: `context ${Math.round((usage.prompt_tokens / CONTEXT_LIMIT) * 100)}% full — run /compact to summarize older turns`,
        },
      ]);
    }
  }, [usage]);

  if (!cfg) {
    return (
      <Onboarding
        onDone={(newCfg) => {
          setCfg(newCfg);
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: "configuration saved — welcome to YOLO Code!" },
          ]);
        }}
      />
    );
  }

  if (resumeSessions !== null) {
    return (
      <Box flexDirection="column">
        <ResumePicker sessions={resumeSessions} onPick={handleResumePick} theme={theme} />
      </Box>
    );
  }

  if (showThemePicker) {
    return (
      <Box flexDirection="column">
        <ThemePicker themes={themeList()} current={theme} onPick={handleThemePick} onPreview={(t) => setTheme(t)} />
      </Box>
    );
  }

  if (skillBrowserState !== null) {
    return (
      <Box flexDirection="column">
        <SkillBrowser
          state={skillBrowserState}
          busy={skillBrowserBusy}
          status={skillBrowserStatus}
          initialFilter={skillBrowserInitialFilter}
          onAction={handleSkillBrowserAction}
          theme={theme}
        />
      </Box>
    );
  }

  const hasConversation = events.some((e) => e.kind === "user" || e.kind === "assistant");

  return (
    <Box flexDirection="column">
      {!hasConversation && <Welcome theme={theme} />}
      {events.length > 0 && (
        <ChatView events={events} showReasoning={showReasoning} theme={theme} verbose={verbose} />
      )}
      {perm ? (
        <PermissionModal
          tool={perm.tool}
          args={perm.args}
          sessionKey={perm.sessionKey}
          theme={theme}
          onDecide={(d) => {
            perm.resolve(d);
            setPerm(null);
          }}
        />
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {tasks.length > 0 && (
            <TaskList
              tasks={tasks}
              theme={theme}
              startedAt={tasksStartedAt}
              tokensDelta={Math.max(0, (usage?.prompt_tokens ?? 0) - tasksStartTokens)}
            />
          )}
          {queue.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              {queue.map((q, i) => (
                <Text key={`queue_${i}`} color={theme.queue.color} dimColor={theme.queue.dim}>
                  ⏳ {q.display}
                </Text>
              ))}
            </Box>
          )}
          <StatusBar
            model={cfg.model}
            usage={usage}
            thinking={busy}
            turnStartedAt={turnStartedAt}
            theme={theme}
            mode={mode}
            effort={effort}
            contextLimit={CONTEXT_LIMIT}
            hasUpdate={hasUpdate}
            latestVersion={latestVersion}
          />
          <Box marginTop={1}>
            <Text color={theme.accent}>› </Text>
            <CustomTextInput
              value={input}
              onChange={setInput}
              onSubmit={submit}
              enablePaste
              traceEnabled={traceEnabled}
              traceSessionId={sessionIdRef.current ?? undefined}
              onHistoryUp={() => {
                if (history.length === 0) return;
                if (historyIndex === -1) {
                  setDraftInput(input);
                  const nextIndex = history.length - 1;
                  setHistoryIndex(nextIndex);
                  setInput(history[nextIndex]!);
                } else {
                  const nextIndex = Math.max(0, historyIndex - 1);
                  setHistoryIndex(nextIndex);
                  setInput(history[nextIndex]!);
                }
              }}
              onHistoryDown={() => {
                if (historyIndex === -1) return;
                const nextIndex = historyIndex + 1;
                if (nextIndex >= history.length) {
                  setHistoryIndex(-1);
                  setInput(draftInput);
                } else {
                  setHistoryIndex(nextIndex);
                  setInput(history[nextIndex]!);
                }
              }}
              onClearQueueItem={(text) => {
                setQueue((q) => {
                  const idx = q.findIndex((item) => item.display === text);
                  if (idx >= 0) {
                    const next = [...q];
                    next.splice(idx, 1);
                    return next;
                  }
                  return q;
                });
              }}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}

export async function renderApp(
  cfg: Cfg | null,
  updateResult?: UpdateCheckResult,
  initialSession?: SessionFile,
) {
  // Render inline (no alternate screen buffer). The earlier alt-screen
  // toggle reduced flicker but disabled scrollback in every terminal —
  // by design, alt-screen has no scrollback. Users in xterm.js (the
  // YOLO Studio agent tile) couldn't scroll the conversation at all,
  // and even native terminals lost the ability to mouse-wheel up.
  // We've since slowed the eye/thinking animations and split finalized
  // events into <Static> commits, so flicker is no longer the dominant
  // problem — keeping output in the normal buffer is the right
  // trade-off for usable scrollback. The user's shell will retain the
  // session transcript on exit, which is also handy.
  const instance = render(
    <App initialCfg={cfg} initialUpdateResult={updateResult} initialSession={initialSession} />,
    // Ink defaults to exitOnCtrlC: true, which terminates the app whenever
    // ctrl-c is pressed — bypassing the handler in App's useInput. Disable
    // it so ctrl-c only interrupts the current turn (or clears the draft);
    // /exit is the explicit way out.
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
}
