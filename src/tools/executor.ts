import type { ToolSpec, ToolContext, ToolOutput } from "./registry.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { webFetchTool } from "./web-fetch.js";
import { tasksSetTool } from "./tasks.js";
import { ToolArtifactStore } from "./artifact-store.js";
import { reduceToolOutput, DEFAULT_REDUCER_CONFIG } from "./reducer.js";
import { makeExpandArtifactTool } from "./expand-artifact.js";
import { makeSkillTool } from "./skill.js";
import type { SkillCatalog } from "../skills/types.js";
import {
  isTraceEnabled,
  redactedPayload,
  tryParseJsonRedacted,
  traceEvent,
} from "../trace-log.js";

export const ALL_TOOLS: ToolSpec[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
  webFetchTool,
  tasksSetTool,
];

export type PermissionDecision = "allow" | "allow_session" | "deny";

export interface PermissionRequest {
  tool: ToolSpec;
  args: Record<string, unknown>;
  sessionKey: string;
}

export type PermissionAsker = (req: PermissionRequest) => Promise<PermissionDecision>;

export interface ToolInvocation {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  content: string;
  ok: boolean;
  /** Raw output bytes before any truncation/capping. */
  rawBytes?: number;
  /** Final output bytes after truncation/capping. */
  reducedBytes?: number;
  /** Artifact ID if the raw output was stored for later expansion. */
  artifactId?: string;
}

export class ToolExecutor {
  private sessionAllowed = new Set<string>();
  private tools: Map<string, ToolSpec>;
  private artifactStore: ToolArtifactStore;
  private skillCatalog: SkillCatalog | null = null;

  constructor(tools: ToolSpec[] = ALL_TOOLS) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.artifactStore = new ToolArtifactStore();
    this.tools.set("expand_artifact", makeExpandArtifactTool(this.artifactStore));
    this.tools.set("skill", makeSkillTool(() => this.skillCatalog));
  }

  /** Bind the skill catalog for this session. The `skill` tool reads through
   *  this getter on each call, so swapping the catalog (e.g. when discovery
   *  re-runs in Phase 5d) takes effect immediately without re-registration. */
  setSkillCatalog(catalog: SkillCatalog | null): void {
    this.skillCatalog = catalog;
  }

  getSkillCatalog(): SkillCatalog | null {
    return this.skillCatalog;
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  register(tool: ToolSpec): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  clearSessionPermissions(): void {
    this.sessionAllowed.clear();
  }

  /** Returns the current set of session-allowed permission keys
   *  (sorted for stable display). Used by the `/permissions` slash
   *  command to show the operator what they have granted. */
  listSessionPermissions(): string[] {
    return [...this.sessionAllowed].sort();
  }

  /** Revoke a single session-allowed permission key. Returns true when
   *  an entry was actually removed (lets the slash command tell the
   *  operator "revoked" vs "no such entry"). */
  revokeSessionPermission(key: string): boolean {
    return this.sessionAllowed.delete(key);
  }

  clearArtifacts(): void {
    this.artifactStore.clear();
  }

  /**
   * Expose the artifact store so the context builder / tool-output
   * summarizer can push deduplicated outputs into it. Without this
   * exposure, the summarizer's dedup path replaces content with an
   * opaque `result_id=<hash>` reference that `expand_artifact` can't
   * resolve — surfaced on 2026-05-12 when yolo-code couldn't see the
   * JSON payloads from repeated MCP tool calls.
   */
  getArtifactStore(): ToolArtifactStore {
    return this.artifactStore;
  }

  async run(
    call: ToolInvocation,
    askPermission: PermissionAsker,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    if (isTraceEnabled()) {
      traceEvent("tool.attempt", {
        toolCallId: call.id,
        name: call.name,
        argsJson: tryParseJsonRedacted(call.arguments),
      });
    }
    const tool = this.tools.get(call.name);
    if (!tool) {
      const msg = `Error: unknown tool "${call.name}". Valid tools: ${[...this.tools.keys()].join(", ")}.`;
      if (isTraceEnabled()) {
        traceEvent("tool.result.detail", {
          toolCallId: call.id,
          name: call.name,
          ok: false,
          phase: "unknown_tool",
          elapsedMs: Date.now() - startedAt,
          ...redactedPayload(msg),
        });
      }
      return {
        tool_call_id: call.id,
        name: call.name,
        content: msg,
        ok: false,
      };
    }

    let args: Record<string, unknown>;
    try {
      args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
    } catch (e) {
      const errorMessage = (e as Error).message;
      // For the model's error message we include the raw args so it can
      // self-correct; the model already has them in conversation history
      // anyway. For the TRACE we keep the args separate and route them
      // through redactedPayload — the malformed-JSON fallback path
      // includes a JSON-key-in-text regex that catches credentials
      // embedded in raw strings even when the value is too short for
      // the Bearer / sk- regexes to match.
      const msg = `Error: invalid JSON arguments for ${call.name}: ${errorMessage}. Arguments received: ${truncateForError(call.arguments)}`;
      if (isTraceEnabled()) {
        traceEvent("tool.result.detail", {
          toolCallId: call.id,
          name: call.name,
          ok: false,
          phase: "invalid_args",
          elapsedMs: Date.now() - startedAt,
          errorMessage,
          ...redactedPayload(call.arguments),
        });
      }
      return {
        tool_call_id: call.id,
        name: call.name,
        content: msg,
        ok: false,
      };
    }

    if (tool.needsPermission) {
      const sessionKey = this.permissionKey(tool, args);
      if (!this.sessionAllowed.has(sessionKey)) {
        if (isTraceEnabled()) {
          traceEvent("tool.permission_check", {
            toolCallId: call.id,
            name: call.name,
            sessionKey,
          });
        }
        const decision = await askPermission({ tool, args, sessionKey });
        if (isTraceEnabled()) {
          traceEvent("tool.permission_decided", {
            toolCallId: call.id,
            name: call.name,
            sessionKey,
            decision,
          });
        }
        if (decision === "deny") {
          const msg = `Permission denied by user. Do not retry this exact call; ask the user what they want to do differently.`;
          if (isTraceEnabled()) {
            traceEvent("tool.result.detail", {
              toolCallId: call.id,
              name: call.name,
              ok: false,
              phase: "permission_denied",
              elapsedMs: Date.now() - startedAt,
              ...redactedPayload(msg),
            });
          }
          return {
            tool_call_id: call.id,
            name: call.name,
            content: msg,
            ok: false,
          };
        }
        if (decision === "allow_session") this.sessionAllowed.add(sessionKey);
      }
    }

    try {
      const result = await tool.run(args as never, ctx);
      const normalized = normalizeToolOutput(result);
      const reduced = reduceToolOutput(
        call.name,
        normalized.content,
        args,
        this.artifactStore,
        DEFAULT_REDUCER_CONFIG,
      );
      if (isTraceEnabled()) {
        traceEvent("tool.result.detail", {
          toolCallId: call.id,
          name: call.name,
          ok: true,
          phase: "completed",
          elapsedMs: Date.now() - startedAt,
          rawBytes: reduced.rawBytes,
          reducedBytes: reduced.reducedBytes,
          artifactId: reduced.artifactId,
          ...redactedPayload(reduced.content),
        });
      }
      return {
        tool_call_id: call.id,
        name: call.name,
        content: reduced.content,
        ok: true,
        rawBytes: reduced.rawBytes,
        reducedBytes: reduced.reducedBytes,
        artifactId: reduced.artifactId,
      };
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        if (isTraceEnabled()) {
          traceEvent("tool.result.detail", {
            toolCallId: call.id,
            name: call.name,
            ok: false,
            phase: "aborted",
            elapsedMs: Date.now() - startedAt,
          });
        }
        throw e;
      }
      const msg = `Error running ${call.name}: ${(e as Error).message ?? String(e)}`;
      if (isTraceEnabled()) {
        traceEvent("tool.result.detail", {
          toolCallId: call.id,
          name: call.name,
          ok: false,
          phase: "threw",
          elapsedMs: Date.now() - startedAt,
          errorName: (e as Error).name ?? "Error",
          ...redactedPayload(msg),
        });
      }
      return {
        tool_call_id: call.id,
        name: call.name,
        content: msg,
        ok: false,
        rawBytes: msg.length,
        reducedBytes: msg.length,
      };
    }
  }

  private permissionKey(tool: ToolSpec, args: Record<string, unknown>): string {
    if (tool.name === "bash" && typeof args.command === "string") {
      const firstToken = args.command.trim().split(/\s+/)[0] ?? "";
      return `bash:${firstToken}`;
    }
    return tool.name;
  }
}

function normalizeToolOutput(result: string | ToolOutput): ToolOutput {
  if (typeof result === "string") {
    const bytes = Buffer.byteLength(result, "utf8");
    return { content: result, rawBytes: bytes, reducedBytes: bytes };
  }
  return result;
}

function truncateForError(s: string): string {
  return s.length <= 200 ? s : `${s.slice(0, 200)}... [${s.length - 200} more chars]`;
}
