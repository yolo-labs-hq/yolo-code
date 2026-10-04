import { Command } from "commander";
import { loadConfig, DEFAULT_MODEL } from "./config.js";
import { runAgentTurn } from "./agent/loop.js";
import { buildSystemPrompt, type ActiveSkill } from "./agent/system-prompt.js";
import { ToolExecutor, ALL_TOOLS } from "./tools/executor.js";
import type { ToolSpec } from "./tools/registry.js";
import { McpManager } from "./mcp/manager.js";
import type { ChatMessage, Usage } from "./agent/messages.js";
import { checkForUpdate } from "./util/update-check.js";
import type { UpdateCheckResult } from "./util/update-check.js";
import { getBuildVersion } from "./util/version.js";
import { listSessions, loadSession, makeSessionId, saveSession, type SessionFile } from "./sessions.js";
import { loadAllSkillsWithMeta } from "./skills/loader.js";
import { isTrusted } from "./skills/trust.js";
import { InMemorySkillCatalog } from "./skills/types.js";
import { applyPinFilter } from "./skills/pins.js";
import { discoveryDisabled, runDiscovery } from "./skills/discovery.js";
import { makeRouterLlmRelevance } from "./skills/discovery-llm.js";
import { StreamJsonEmitter } from "./agent/stream-json-emitter.js";

// Exit codes — keep these stable; CI / scripts depend on them.
const EXIT_OK = 0;
const EXIT_GENERIC_ERROR = 1;
const EXIT_CONFIG = 2;
const EXIT_ITERATION_LIMIT = 3;
const EXIT_ABORTED = 4;
const EXIT_PERMISSION_DENIED = 5;
const EXIT_LOOP_GUARD = 6;

const program = new Command();
program
  .name("yolo")
  .description("Terminal coding agent powered by Kimi-K2.6 on Cloudflare Workers AI.")
  .version(getBuildVersion())
  .option("-p, --print [prompt]", "non-interactive mode: send prompt, stream reply to stdout, exit. Prompt may also come from stdin (`echo ... | yolo -p`).")
  .option("-m, --model <id>", "model id (defaults to @cf/moonshotai/kimi-k2.6)")
  .option("--cd <dir>", "set working directory before starting")
  .option("--max-turns <n>", "cap tool iteration count for this invocation", parseIntStrict)
  .option("--output-format <format>", "non-interactive output format: text (default, streaming) | json (single envelope at end) | stream-json (NDJSON event stream — one envelope per tool call, result, and turn)", "text")
  .option("--append-system-prompt <text>", "append additional guidance to the system prompt for this invocation")
  .option("-c, --continue", "resume the most recent session in the current working directory")
  .option("--resume [id]", "resume a session: with an id (or unique substring) loads it directly; with no id, auto-resumes if exactly one session exists in the current cwd, otherwise lists matching ids")
  .option("--dangerously-allow-all", "auto-approve every permission prompt (non-interactive mode only)")
  .option("--reasoning", "include reasoning in output (non-interactive mode only)");

program
  .command("usage")
  .description("show per-turn token usage log from ~/.yolo-code/usage.jsonl")
  .action(async () => {
    const { showUsageLog } = await import("./usage-cli.js");
    await showUsageLog();
    process.exit(0);
  });

const configCmd = program
  .command("config")
  .description("read or write the yolo-code config file");
configCmd
  .command("get <key>")
  .description("print the value of a single config key")
  .action(async (key: string) => {
    const { configGet } = await import("./cli/config-cmd.js");
    process.exit(await configGet(key));
  });
configCmd
  .command("set <key> <value>")
  .description("set a single config key (booleans/numbers parsed automatically)")
  .action(async (key: string, value: string) => {
    const { configSet } = await import("./cli/config-cmd.js");
    process.exit(await configSet(key, value));
  });
configCmd
  .command("remove <key>")
  .alias("unset")
  .description("delete a config key")
  .action(async (key: string) => {
    const { configRemove } = await import("./cli/config-cmd.js");
    process.exit(await configRemove(key));
  });
configCmd
  .command("list")
  .description("print the full config (api token redacted)")
  .action(async () => {
    const { configList } = await import("./cli/config-cmd.js");
    process.exit(await configList());
  });
configCmd
  .command("path")
  .description("print the config file path")
  .action(async () => {
    const { configPathCmd } = await import("./cli/config-cmd.js");
    process.exit(await configPathCmd());
  });

const tmuxCmd = program
  .command("tmux")
  .description("YOLO tmux config helper (for users running yolo-code / codex / claude under tmux locally)");
tmuxCmd
  .command("print")
  .description("write the curated YOLO tmux config snippet to stdout (pipe to ~/.tmux.conf or copy-paste)")
  .action(async () => {
    const { tmuxPrint } = await import("./cli/tmux-cmd.js");
    process.exit(await tmuxPrint());
  });
tmuxCmd
  .command("install")
  .description("install the snippet into ~/.tmux.conf (idempotent via marker comments)")
  .option("--path <file>", "override the target tmux config path (default: ~/.tmux.conf)")
  .action(async (options: { path?: string }) => {
    const { tmuxInstall } = await import("./cli/tmux-cmd.js");
    process.exit(await tmuxInstall({ path: options.path }));
  });

program
  .command("probe-scroll")
  .description("print the current scroll regime (terminal, tmux, webapp tile) for debugging wheel sensitivity")
  .action(async () => {
    const { runProbeScroll } = await import("./cli/probe-scroll-cmd.js");
    process.exit(await runProbeScroll());
  });

const mcpCmd = program
  .command("mcp")
  .description("manage MCP servers in the config file");
mcpCmd
  .command("add <name> [command...]")
  .description("add a local stdio MCP server (command + optional args)")
  .option("--env <KEY=VALUE...>", "env var to pass to the server (repeatable)", appendStringOpt, [])
  .action(async (name: string, command: string[], options: { env: string[] }) => {
    const { mcpAdd } = await import("./cli/mcp-cmd.js");
    process.exit(await mcpAdd(name, command, options));
  });
mcpCmd
  .command("add-http <name> <url>")
  .description("add a remote HTTP MCP server")
  .option("--header <KEY=VALUE...>", "header to send on every request (repeatable)", appendStringOpt, [])
  .action(async (name: string, url: string, options: { header: string[] }) => {
    const { mcpAddHttp } = await import("./cli/mcp-cmd.js");
    process.exit(await mcpAddHttp(name, url, options));
  });
mcpCmd
  .command("remove <name>")
  .description("remove an MCP server")
  .action(async (name: string) => {
    const { mcpRemove } = await import("./cli/mcp-cmd.js");
    process.exit(await mcpRemove(name));
  });
mcpCmd
  .command("list")
  .description("list configured MCP servers")
  .action(async () => {
    const { mcpList } = await import("./cli/mcp-cmd.js");
    process.exit(await mcpList());
  });
mcpCmd
  .command("get <name>")
  .description("print one MCP server config as JSON")
  .action(async (name: string) => {
    const { mcpGet } = await import("./cli/mcp-cmd.js");
    process.exit(await mcpGet(name));
  });

const skillsCmd = program
  .command("skills")
  .description("manage agent-skills (SKILL.md playbooks): list, install, trust, …");
skillsCmd
  .command("list")
  .alias("ls")
  .description("list all skills visible from the current cwd")
  .action(async () => {
    const { skillsList } = await import("./cli/skills-cmd.js");
    process.exit(await skillsList());
  });
skillsCmd
  .command("info <name>")
  .description("print the full SKILL.md body for one skill")
  .action(async (name: string) => {
    const { skillsInfo } = await import("./cli/skills-cmd.js");
    process.exit(await skillsInfo(name));
  });
skillsCmd
  .command("validate [path]")
  .description("validate every loaded SKILL.md, or one explicit file/directory")
  .action(async (path?: string) => {
    const { skillsValidate } = await import("./cli/skills-cmd.js");
    process.exit(await skillsValidate(path));
  });
skillsCmd
  .command("enable <name>")
  .description("pin a skill on (stays active across discovery runs)")
  .action(async (name: string) => {
    const { skillsEnable } = await import("./cli/skills-cmd.js");
    process.exit(await skillsEnable(name));
  });
skillsCmd
  .command("disable <name>")
  .description("pin a skill off (excluded from the active set)")
  .action(async (name: string) => {
    const { skillsDisable } = await import("./cli/skills-cmd.js");
    process.exit(await skillsDisable(name));
  });
skillsCmd
  .command("clear-pin <name>")
  .description("remove any pin (enable or disable) for a skill")
  .action(async (name: string) => {
    const { skillsClearPin } = await import("./cli/skills-cmd.js");
    process.exit(await skillsClearPin(name));
  });
skillsCmd
  .command("trust [path]")
  .description("trust a directory so its project-level skills load (defaults to cwd)")
  .action(async (path?: string) => {
    const { skillsTrust } = await import("./cli/skills-cmd.js");
    process.exit(await skillsTrust(path));
  });
skillsCmd
  .command("untrust [path]")
  .description("revoke trust for a directory (defaults to cwd)")
  .action(async (path?: string) => {
    const { skillsUntrust } = await import("./cli/skills-cmd.js");
    process.exit(await skillsUntrust(path));
  });
skillsCmd
  .command("trust-list")
  .description("list every directory that's currently trusted")
  .action(async () => {
    const { skillsTrustList } = await import("./cli/skills-cmd.js");
    process.exit(await skillsTrustList());
  });
skillsCmd
  .command("install <name-or-url>")
  .description("install a skill from the YOLO Skills Registry, or any tarball URL")
  .action(async (target: string) => {
    const { skillsInstall } = await import("./cli/skills-cmd.js");
    process.exit(await skillsInstall(target));
  });
skillsCmd
  .command("search [query]")
  .alias("browse")
  .alias("available")
  .description("browse the YOLO Skills Registry catalog (cached 10 min)")
  .option("--refresh", "bypass the cache and re-fetch the registry")
  .action(async (query: string | undefined, options: { refresh?: boolean }) => {
    const { skillsSearch } = await import("./cli/skills-cmd.js");
    process.exit(await skillsSearch(query, { refresh: options.refresh }));
  });
skillsCmd
  .command("uninstall <name>")
  .alias("remove")
  .description("remove an installed user-scope skill from ~/.config/yolo-code/skills/")
  .action(async (name: string) => {
    const { skillsUninstall } = await import("./cli/skills-cmd.js");
    process.exit(await skillsUninstall(name));
  });
skillsCmd
  .command("discovery-clear")
  .description("clear the skill-discovery cache so the next run does a fresh heuristic + LLM pass")
  .action(async () => {
    const { skillsDiscoveryClear } = await import("./cli/skills-cmd.js");
    process.exit(await skillsDiscoveryClear());
  });

// commander's default-action runs when no subcommand was matched.
program.action(() => {});
program.parse();

/** Commander callback for repeatable `--flag VALUE` options (config /
 *  mcp `--env`, `--header`). Each occurrence appends to an array. */
function appendStringOpt(value: string, prev: string[]): string[] {
  return [...prev, value];
}

const SUBCOMMAND_NAMES = new Set(["usage", "config", "mcp", "skills"]);

const opts = program.opts<{
  print?: string | true;
  model?: string;
  cd?: string;
  maxTurns?: number;
  outputFormat?: string;
  appendSystemPrompt?: string;
  continue?: boolean;
  resume?: string | true;
  dangerouslyAllowAll?: boolean;
  reasoning?: boolean;
}>();

function parseIntStrict(raw: string): number {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid integer: ${raw}`);
  }
  return n;
}

/** Read all of stdin to a string. Resolves on EOF. */
function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

/** Find a session to resume given the CLI flags. Throws on ambiguous /
 *  missing matches so the caller can surface a structured error. */
async function resolveSessionTarget(flags: {
  continue?: boolean;
  resume?: string | true;
}): Promise<SessionFile | null> {
  if (!flags.continue && flags.resume === undefined) return null;
  if (flags.continue && flags.resume !== undefined) {
    throw new Error("--continue and --resume are mutually exclusive");
  }
  const sessions = await listSessions(200);
  if (sessions.length === 0) {
    throw new Error("no saved sessions to resume");
  }
  if (flags.continue) {
    // Prefer the most recent session in the current cwd (Claude Code
    // semantics — different repos shouldn't bleed conversations).
    // Fall back to the global most-recent if nothing matches cwd.
    const cwd = process.cwd();
    const inCwd = sessions.find((s) => s.cwd === cwd);
    const picked = inCwd ?? sessions[0]!;
    return loadSession(picked.filePath);
  }
  // --resume with no value: scope to sessions whose cwd matches the
  // current cwd. One match → resume it; multiple → print the ids and
  // bail so the user can re-run with a specific id. Sessions written
  // before SessionFile.cwd existed are excluded here (filter is exact-
  // match; missing cwd ≠ current cwd) — they're still resumable by
  // explicit id via `--resume <id>`.
  if (flags.resume === true) {
    const cwd = process.cwd();
    const inCwd = sessions.filter((s) => s.cwd === cwd);
    if (inCwd.length === 0) {
      throw new Error(`no saved sessions in ${cwd}`);
    }
    if (inCwd.length === 1) {
      return loadSession(inCwd[0]!.filePath);
    }
    const LIST_CAP = 20;
    const shown = inCwd.slice(0, LIST_CAP);
    const list = shown
      .map((s) => `  ${s.id}  ·  ${s.messageCount} msgs  ·  ${s.firstPrompt}`)
      .join("\n");
    const header =
      inCwd.length > LIST_CAP
        ? `${inCwd.length} sessions in ${cwd} (showing ${LIST_CAP} most recent) — re-run with --resume <id>:`
        : `${inCwd.length} sessions in ${cwd} — re-run with --resume <id>:`;
    throw new Error(`${header}\n${list}`);
  }
  // --resume <id>: exact id match wins; otherwise unique substring.
  const exact = sessions.find((s) => s.id === flags.resume);
  if (exact) return loadSession(exact.filePath);
  const matches = sessions.filter((s) => s.id.includes(flags.resume as string));
  if (matches.length === 0) {
    throw new Error(`no session matching "${flags.resume}"`);
  }
  if (matches.length > 1) {
    const list = matches.slice(0, 5).map((s) => `  ${s.id}`).join("\n");
    throw new Error(`multiple sessions match "${flags.resume}":\n${list}`);
  }
  return loadSession(matches[0]!.filePath);
}

/** Resolve the effective prompt for non-interactive runs.
 *  - `-p "text"` only → text
 *  - stdin pipe only → stdin contents
 *  - both → "${printArg}\n\n${stdin}"
 *  - neither → undefined (fall through to interactive mode if TTY) */
async function resolvePrompt(printArg: string | true | undefined): Promise<string | undefined> {
  // -p with no value is allowed (commander parses bare `-p` as `true`); we
  // only treat it as "print mode" if either a string was given or stdin
  // is piped. -p alone with a TTY stdin means "the user typo'd, fall to
  // interactive".
  const argText = typeof printArg === "string" ? printArg : undefined;
  const stdinText = process.stdin.isTTY ? "" : await readAllStdin();
  const trimmedStdin = stdinText.trim();
  if (argText && trimmedStdin) return `${argText}\n\n${stdinText}`;
  if (argText) return argText;
  if (trimmedStdin) return stdinText;
  return undefined;
}

async function main() {
  if (opts.cd) {
    try {
      process.chdir(opts.cd);
    } catch (e) {
      console.error(`yolo: --cd ${opts.cd}: ${(e as Error).message}`);
      process.exit(EXIT_CONFIG);
    }
  }

  // Subcommands self-exit via process.exit() in their action handlers.
  // main() still gets called once because program.parse() runs the action
  // concurrently — bail here so we don't try to load creds / read stdin
  // for `yolo-code config`, `yolo-code mcp`, etc.
  if (SUBCOMMAND_NAMES.has(program.args[0] ?? "")) return;

  const cfg = await loadConfig();
  const updateResult = await checkForUpdate();

  // Resolve session target (--continue / --resume) before reading stdin
  // so a missing session fails fast with a clean error instead of after
  // the prompt has been collected.
  let resumedSession: SessionFile | null = null;
  try {
    resumedSession = await resolveSessionTarget({
      continue: opts.continue,
      resume: opts.resume,
    });
  } catch (e) {
    console.error(`yolo: ${(e as Error).message}`);
    process.exit(EXIT_CONFIG);
  }

  // Resolve the prompt (may read stdin). If non-empty, run print mode.
  const prompt = await resolvePrompt(opts.print);

  if (prompt !== undefined) {
    if (!cfg) {
      console.error(missingCredsMessage());
      process.exit(EXIT_CONFIG);
    }
    const model = opts.model ?? cfg.model ?? DEFAULT_MODEL;
    const exitCode = await runPrintMode({
      ...cfg,
      model,
      prompt,
      allowAll: !!opts.dangerouslyAllowAll,
      showReasoning: !!opts.reasoning,
      outputFormat:
        opts.outputFormat === "json"
          ? "json"
          : opts.outputFormat === "stream-json"
            ? "stream-json"
            : "text",
      appendSystemPrompt: opts.appendSystemPrompt,
      maxToolIterations: opts.maxTurns,
      resumedSession,
      updateResult,
    });
    process.exit(exitCode);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "yolo: interactive mode requires a TTY. Use `yolo -p \"...\"` or pipe stdin for non-interactive use.",
    );
    process.exit(EXIT_CONFIG);
  }

  const { renderApp } = await import("./app.js");
  if (cfg) {
    const model = opts.model ?? cfg.model ?? DEFAULT_MODEL;
    await renderApp({ ...cfg, model }, updateResult, resumedSession ?? undefined);
  } else {
    await renderApp(null, updateResult, resumedSession ?? undefined);
  }
}

interface PrintOpts {
  accountId: string;
  apiToken: string;
  model: string;
  prompt: string;
  allowAll: boolean;
  showReasoning: boolean;
  outputFormat: "text" | "json" | "stream-json";
  appendSystemPrompt?: string;
  maxToolIterations?: number;
  coauthor?: boolean;
  coauthorName?: string;
  coauthorEmail?: string;
  updateResult: UpdateCheckResult;
  routerBaseUrl?: string;
  studioMcpUrl?: string;
  /** When set, append the new prompt to this session's history and
   *  reuse its id, so chained `--continue` / `--resume` calls work
   *  end-to-end from the CLI. */
  resumedSession?: SessionFile | null;
}

interface CapturedToolCall {
  name: string;
  arguments: string;
  ok: boolean | null;
  result_snippet?: string;
}

interface JsonResult {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_aborted" | "error_permission_denied" | "error_loop_guard" | "error";
  result: string;
  is_error: boolean;
  session_id: string;
  duration_ms: number;
  num_turns: number;
  model: string;
  usage: Usage | null;
  tool_calls: CapturedToolCall[];
  error_message?: string;
}

async function runPrintMode(opts: PrintOpts): Promise<number> {
  const startedAt = Date.now();
  // Reuse the resumed session's id so the same file gets appended to —
  // that's how `yolo --continue -p "..."` chains correctly across invocations.
  const sessionId =
    opts.resumedSession?.id ?? makeSessionId(opts.prompt);
  const isJson = opts.outputFormat === "json";
  const isStreamJson = opts.outputFormat === "stream-json";
  // Both modes suppress stderr chatter (banners, skill-discovery
  // messages, rate-limit warnings, …) so stdout stays a clean
  // machine-readable stream. text mode is the only "talky" mode.
  const isStructured = isJson || isStreamJson;

  if (opts.updateResult.hasUpdate && !isStructured) {
    process.stderr.write(
      `\x1b[33mYOLO Code update available: ${opts.updateResult.localVersion} → ${opts.updateResult.latestVersion}\x1b[0m\n` +
        `\x1b[33m  npm update -g yolo-code  then restart\x1b[0m\n\n`,
    );
  }

  const cwd = process.cwd();
  const executor = new ToolExecutor(ALL_TOOLS);

  // Connect to YOLO Studio MCP server if configured. Failures are non-
  // fatal — fall through to built-in tools only.
  const mcpManager = new McpManager();
  let mcpTools: ToolSpec[] = [];
  if (opts.studioMcpUrl) {
    try {
      await mcpManager.addHttpServer("yolo-studio", opts.studioMcpUrl);
      mcpTools = mcpManager.getAllTools();
      for (const tool of mcpTools) executor.register(tool);
    } catch (e) {
      if (!isStructured) {
        process.stderr.write(
          `\x1b[33myolo: studio MCP connect failed (${(e as Error).message}) — continuing without studio tools\x1b[0m\n`,
        );
      }
    }
  }
  // Load skills before building the system prompt so the catalog appears
  // in the first message the model sees. Project-level skills require
  // explicit trust; user-level + registry-installed are unconditional.
  const skillsResult = loadAllSkillsWithMeta({ cwd, trusted: isTrusted(cwd) });
  // Honor user-pinned `disable` entries so a skill the user has explicitly
  // turned off doesn't show up in the catalog or get callable via the
  // `skill` tool.
  const filteredRecords = applyPinFilter(skillsResult.catalog.list());

  // Discovery: pick which of the loaded skills surface in this turn's
  // session prefix. Skipped entirely when YOLO_CODE_SKILL_DISCOVERY=0,
  // when there's no router credential to call the LLM step, or when the
  // catalog is small enough that filtering isn't useful (handled inside
  // runDiscovery).
  let activeRecords = filteredRecords;
  if (!discoveryDisabled() && filteredRecords.length > 0) {
    const llm = opts.routerBaseUrl && opts.apiToken
      ? makeRouterLlmRelevance({
          baseUrl: opts.routerBaseUrl,
          apiToken: opts.apiToken,
          sessionId,
        })
      : null;
    try {
      const result = await runDiscovery({
        cwd,
        records: filteredRecords,
        recentMessages: [opts.prompt],
        previousActive: [],
        llm,
      });
      activeRecords = result.active;
      if (!isStructured && result.deactivated.length > 0) {
        process.stderr.write(
          `\x1b[2myolo: skill-discovery deactivated ${result.deactivated.length} skill${result.deactivated.length === 1 ? "" : "s"}: ${result.deactivated.join(", ")} (reason: ${result.reason})\x1b[0m\n`,
        );
      }
    } catch (e) {
      if (!isStructured) {
        process.stderr.write(
          `\x1b[33myolo: skill-discovery failed (${(e as Error).message}) — including all loaded skills\x1b[0m\n`,
        );
      }
    }
  }
  const filteredCatalog = new InMemorySkillCatalog(activeRecords);
  executor.setSkillCatalog(filteredCatalog);
  const activeSkills: ActiveSkill[] = activeRecords.map((r) => ({
    name: r.name,
    description: r.description,
  }));
  if (!isStructured && skillsResult.untrustedProjectRoots.length > 0) {
    process.stderr.write(
      `\x1b[33myolo: project-level skills found in ${skillsResult.untrustedProjectRoots[0]} but not loaded — run \`yolo-code skills trust ${cwd}\` (or set YOLO_TRUST_PROJECT_SKILLS=1) to load them\x1b[0m\n`,
    );
  }

  // Use the executor's full registered list so the prompt and OpenAI
  // tool defs include `skill`, `expand_artifact`, and any MCP tools.
  const tools = executor.list();

  // When resuming, reuse the session's prior messages and its system
  // prefix (so the conversation context is intact). When starting fresh,
  // build a system prompt from the current cwd / tools / model.
  let systemMessages: ChatMessage[];
  let messages: ChatMessage[];
  if (opts.resumedSession) {
    const file = opts.resumedSession;
    const prefixEnd = file.messages.findIndex((m) => m.role !== "system");
    systemMessages = prefixEnd === -1 ? file.messages.slice() : file.messages.slice(0, prefixEnd);
    messages = [...file.messages, { role: "user", content: opts.prompt }];
  } else {
    let systemContent = buildSystemPrompt({ cwd, tools, model: opts.model, activeSkills });
    if (opts.appendSystemPrompt) {
      systemContent += `\n\n${opts.appendSystemPrompt}`;
    }
    systemMessages = [{ role: "system", content: systemContent }];
    messages = [...systemMessages, { role: "user", content: opts.prompt }];
  }

  const controller = new AbortController();
  let aborted = false;
  process.on("SIGINT", () => {
    aborted = true;
    controller.abort();
  });

  // State captured for the JSON envelope and exit-code decisions.
  const accumulatedText: string[] = [];
  const toolCallById = new Map<string, CapturedToolCall>();
  const toolCallOrder: CapturedToolCall[] = [];
  let lastUsage: Usage | null = null;
  let numTurns = 0;
  let hitIterationLimit = false;
  let permissionDenied = false;
  // Mutable wrapper so tsc's control-flow narrowing doesn't pin the
  // type to `null` based on the initializer — closure assignments
  // don't widen back across the access site otherwise.
  const loopGuardState: { ref: { toolName: string; consecutiveCalls: number } | null } = { ref: null };

  let printedReasoningHeader = false;
  let printedAnswerHeader = false;

  // Stream-JSON mode: emit Claude-Code-shaped NDJSON envelopes on stdout
  // so the workstream-tile renderer (`webapp/components/grid/laneLineFormatter.ts`)
  // can ingest yolo-code output through the same parser it uses for claude.
  // The emitter owns per-turn buffering; callbacks below feed it the
  // events the runAgentTurn loop emits.
  const streamJsonEmitter = isStreamJson
    ? new StreamJsonEmitter(
        (line) => process.stdout.write(line + "\n"),
        {
          model: opts.model,
          tools: tools.map((t) => ({ name: t.name })),
          cwd,
          sessionId,
          permissionMode: opts.allowAll ? "bypassPermissions" : "default",
        },
      )
    : null;
  streamJsonEmitter?.start();

  const writeText = (delta: string) => {
    accumulatedText.push(delta);
    if (streamJsonEmitter) {
      streamJsonEmitter.recordTextDelta(delta);
    } else if (!isJson) {
      process.stdout.write(delta);
    }
  };

  try {
    await runAgentTurn({
      accountId: opts.accountId,
      apiToken: opts.apiToken,
      model: opts.model,
      messages,
      tools,
      executor,
      cwd,
      signal: controller.signal,
      systemMessages,
      baseUrl: opts.routerBaseUrl,
      maxToolIterations: opts.maxToolIterations,
      sessionId,
      coauthor:
        opts.coauthor !== false
          ? { name: opts.coauthorName || "YOLO Code", email: opts.coauthorEmail || "noreply@yolo.studio" }
          : undefined,
      callbacks: {
        onAssistantStart: () => {
          numTurns++;
        },
        onReasoningDelta: opts.showReasoning && !isStructured
          ? (delta) => {
              if (!printedReasoningHeader) {
                process.stderr.write("\x1b[2m--- reasoning ---\n");
                printedReasoningHeader = true;
              }
              process.stderr.write(delta);
            }
          : undefined,
        onTextDelta: (delta) => {
          if (opts.showReasoning && printedReasoningHeader && !printedAnswerHeader && !isStructured) {
            process.stderr.write("\n--- answer ---\x1b[0m\n");
            printedAnswerHeader = true;
          }
          writeText(delta);
        },
        onToolCallFinalized: (call) => {
          const cap: CapturedToolCall = {
            name: call.function.name,
            arguments: call.function.arguments,
            ok: null,
          };
          toolCallById.set(call.id, cap);
          toolCallOrder.push(cap);
          if (streamJsonEmitter) {
            streamJsonEmitter.recordToolUse({
              id: call.id,
              name: call.function.name,
              argumentsJson: call.function.arguments,
            });
          } else if (!isJson) {
            process.stderr.write(`\x1b[2m[tool ${call.function.name}(${call.function.arguments})]\x1b[0m\n`);
          }
        },
        onToolResult: (result) => {
          const cap = toolCallById.get(result.tool_call_id);
          if (cap) {
            cap.ok = result.ok;
            cap.result_snippet =
              result.content.length > 400 ? result.content.slice(0, 400) + "..." : result.content;
          }
          if (streamJsonEmitter) {
            // Full body in stream-json mode — the workstream tile is
            // designed to handle large `tool_result.content` strings
            // and operators benefit from the unsummarized payload.
            streamJsonEmitter.recordToolResult({
              toolUseId: result.tool_call_id,
              content: result.content,
              isError: !result.ok,
            });
          } else if (!isJson) {
            const snippet =
              result.content.length > 400 ? result.content.slice(0, 400) + "..." : result.content;
            process.stderr.write(`\x1b[2m[result: ${snippet.replace(/\n/g, " ⏎ ")}]\x1b[0m\n`);
          }
        },
        onUsage: (u) => {
          lastUsage = u;
        },
        onIterationLimit: () => {
          hitIterationLimit = true;
        },
        onRateLimit: (delayMs, message) => {
          if (!isStructured) {
            const secs = Math.max(1, Math.round(delayMs / 1000));
            process.stderr.write(
              `\x1b[33m[rate limited — pausing ${secs}s before retry: ${message}]\x1b[0m\n`,
            );
          }
        },
        onAutoCompact: () => {
          if (!isStructured) {
            process.stderr.write(`\x1b[33m[iteration limit reached — auto-compacting and continuing]\x1b[0m\n`);
          }
        },
        onLoopGuardTripped: (info) => {
          loopGuardState.ref = {
            toolName: info.toolName,
            consecutiveCalls: info.consecutiveCalls,
          };
          if (!isStructured) {
            process.stderr.write(
              `\x1b[31m[loop guard tripped: ${info.toolName} called ${info.consecutiveCalls}× in a row — turn halted]\x1b[0m\n`,
            );
          }
        },
        askPermission: async ({ tool, args }) => {
          if (opts.allowAll) return "allow";
          permissionDenied = true;
          if (!isStructured) {
            process.stderr.write(
              `\x1b[31m[permission denied: ${tool.name}(${JSON.stringify(args)}) — pass --dangerously-allow-all to approve in non-interactive mode]\x1b[0m\n`,
            );
          }
          return "deny";
        },
      },
    });

    const exitCode = aborted
      ? EXIT_ABORTED
      : loopGuardState.ref
        ? EXIT_LOOP_GUARD
        : hitIterationLimit
          ? EXIT_ITERATION_LIMIT
          : permissionDenied
            ? EXIT_PERMISSION_DENIED
            : EXIT_OK;

    // Persist the session so future `--continue` / `--resume <id>`
    // calls can pick up where this one left off. Awaited — fire-and-
    // forget races with process.exit() and the file may not be on disk
    // when the next CLI invocation reads it. Errors are swallowed so a
    // disk hiccup doesn't fail an otherwise-successful run.
    try {
      await saveSession({
        id: sessionId,
        cwd,
        model: opts.model,
        createdAt: opts.resumedSession?.createdAt ?? new Date(startedAt).toISOString(),
        updatedAt: new Date().toISOString(),
        messages,
      });
    } catch {
      /* best-effort */
    }

    const subtype: JsonResult["subtype"] =
      exitCode === EXIT_OK
        ? "success"
        : exitCode === EXIT_ITERATION_LIMIT
          ? "error_max_turns"
          : exitCode === EXIT_ABORTED
            ? "error_aborted"
            : exitCode === EXIT_PERMISSION_DENIED
              ? "error_permission_denied"
              : exitCode === EXIT_LOOP_GUARD
                ? "error_loop_guard"
                : "error";
    const guardSnapshot = loopGuardState.ref;
    if (isJson) {
      const guardSummaryJson = guardSnapshot
        ? `loop guard halted: ${guardSnapshot.toolName} called ${guardSnapshot.consecutiveCalls}× consecutively. Use the matching update/mutate tool to revise rather than retrying.`
        : null;
      const envelope: JsonResult = {
        type: "result",
        subtype,
        result: guardSummaryJson ?? accumulatedText.join(""),
        is_error: exitCode !== EXIT_OK,
        session_id: sessionId,
        duration_ms: Date.now() - startedAt,
        num_turns: numTurns,
        model: opts.model,
        usage: lastUsage,
        tool_calls: toolCallOrder,
      };
      process.stdout.write(JSON.stringify(envelope) + "\n");
    } else if (streamJsonEmitter) {
      // Flushes any trailing text-only assistant turn (final answer with
      // no tool calls), then emits the run-final `result` envelope.
      // For terminal-by-guard runs, prefer a human-readable summary
      // over empty assistant text so the work-stream tile renders a
      // recognizable line.
      const guardSummary = guardSnapshot
        ? `loop guard halted: ${guardSnapshot.toolName} called ${guardSnapshot.consecutiveCalls}× consecutively. Use the matching update/mutate tool to revise rather than retrying.`
        : null;
      streamJsonEmitter.finish({
        subtype,
        isError: exitCode !== EXIT_OK,
        durationMs: Date.now() - startedAt,
        numTurns,
        result: guardSummary ?? accumulatedText.join(""),
        usage: lastUsage,
      });
    } else {
      // Trailing newline keeps shell pipelines clean (cat-style output).
      process.stdout.write("\n");
    }

    await mcpManager.disconnectAll().catch(() => undefined);
    return exitCode;
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const isAbort = (e as Error).name === "AbortError" || aborted;
    if (isJson) {
      const envelope: JsonResult = {
        type: "result",
        subtype: isAbort ? "error_aborted" : "error",
        result: accumulatedText.join(""),
        is_error: true,
        session_id: sessionId,
        duration_ms: Date.now() - startedAt,
        num_turns: numTurns,
        model: opts.model,
        usage: lastUsage,
        tool_calls: toolCallOrder,
        error_message: errMsg,
      };
      process.stdout.write(JSON.stringify(envelope) + "\n");
    } else if (streamJsonEmitter) {
      streamJsonEmitter.finish({
        subtype: isAbort ? "error_aborted" : "error",
        isError: true,
        durationMs: Date.now() - startedAt,
        numTurns,
        result: errMsg,
        usage: lastUsage,
      });
    } else {
      process.stderr.write(`\nyolo: ${errMsg}\n`);
    }
    await mcpManager.disconnectAll().catch(() => undefined);
    return isAbort ? EXIT_ABORTED : EXIT_GENERIC_ERROR;
  }
}

function missingCredsMessage(): string {
  return (
    "yolo: missing credentials.\n" +
    "Either:\n" +
    "  - Set YOLO_ROUTER_BASE_URL + YOLO_ROUTER_API_KEY (YOLO Studio sandbox mode), or\n" +
    "  - Set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (standalone), or\n" +
    "  - Write them to ~/.config/yolo-code/config.json (chmod 600)\n" +
    '    { "accountId": "...", "apiToken": "...", "model": "@cf/moonshotai/kimi-k2.6" }'
  );
}

main().catch((e) => {
  console.error(`yolo: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(EXIT_GENERIC_ERROR);
});
