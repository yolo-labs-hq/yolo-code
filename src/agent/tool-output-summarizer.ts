import { createHash } from "node:crypto";
import type { ChatMessage } from "./messages.js";
import type { ToolArtifactStore } from "../tools/artifact-store.js";

export interface ToolOutputSummary {
  tool_call_id: string;
  name?: string;
  content: string;
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 800;

/** Normalize text for hashing: lowercase, trim whitespace, collapse spaces. */
function normalizeForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000); // cap hash input
}

function stableHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Global deduplication cache across the session.
 *
 * `artifactId` is the `art_N` ID of the FIRST sighting's content in the
 * shared ToolArtifactStore. On dedup hits, we reference that art_N
 * instead of the opaque hash so `expand_artifact` can retrieve the
 * full payload — important for MCP tool calls where the JSON response
 * is structured data the agent needs to read (planId, stepId, etc.),
 * not just human-readable summary.
 */
const outputHashCache = new Map<string, {
  name?: string;
  firstSeenId: string;
  preview: string;
  artifactId: string | null;
}>();

export function clearOutputHashCache(): void {
  outputHashCache.clear();
}

/**
 * Summarize a single tool output for inclusion in model context.
 * Caps length, preserves metadata, and deduplicates identical outputs.
 *
 * When `artifactStore` is provided, every first-sighting output is
 * pushed into the store and indexed by `art_N`. Dedup hits then return
 * a reference that `expand_artifact(art_N)` can resolve. Without the
 * store, the dedup path falls back to the legacy opaque-hash ref
 * (kept for backward compatibility — tests don't always provide a
 * store).
 */
export function summarizeToolOutput(
  toolCallId: string,
  name: string | undefined,
  rawContent: string,
  artifactStore: ToolArtifactStore | null = null,
  maxChars = DEFAULT_MAX_CHARS,
): ToolOutputSummary {
  const normalized = normalizeForHash(rawContent);
  const hash = stableHash(normalized);
  const cached = outputHashCache.get(hash);

  if (cached && cached.firstSeenId !== toolCallId) {
    // Deduplicate: reference previous identical output. Prefer the
    // first-sighting's art_N (resolvable via expand_artifact) over the
    // opaque hash; fall back to the hash only when no artifactStore
    // was wired through.
    const ref = cached.artifactId
      ? `same as previous ${cached.name ?? "tool"} call — call expand_artifact("${cached.artifactId}") to retrieve the full output.`
      : `same as previous ${cached.name ?? "tool"} call (result_id=${hash})`;
    return {
      tool_call_id: toolCallId,
      name,
      content: ref,
      truncated: false,
    };
  }

  // Store in cache for future deduplication. If we have an artifact
  // store, push the full content so dedup hits can reference it.
  if (!cached) {
    const preview = rawContent.slice(0, 120).replace(/\s+/g, " ");
    const artifactId = artifactStore ? artifactStore.store(rawContent) : null;
    outputHashCache.set(hash, { name, firstSeenId: toolCallId, preview, artifactId });
  }

  // Determine if output is a failure/noise
  const isFailure =
    rawContent.startsWith("Error:") ||
    rawContent.startsWith("error:") ||
    rawContent.includes("exit code") ||
    rawContent.includes("not found") ||
    rawContent.includes("No such file");

  const isNoisy =
    rawContent.length > 0 &&
    (rawContent.split("\n").length > 100 || rawContent.length > maxChars * 2);

  if (isFailure && rawContent.length > 200) {
    // Collapse failures aggressively
    const firstLine = rawContent.split("\n")[0] ?? "";
    return {
      tool_call_id: toolCallId,
      name,
      content: `[${name ?? "tool"} failed] ${firstLine.slice(0, 160)}`,
      truncated: true,
    };
  }

  if (rawContent.length <= maxChars) {
    return {
      tool_call_id: toolCallId,
      name,
      content: rawContent,
      truncated: false,
    };
  }

  // Truncate with indicator
  const truncated = rawContent.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  const clean = lastNewline > maxChars * 0.5 ? truncated.slice(0, lastNewline) : truncated;
  return {
    tool_call_id: toolCallId,
    name,
    content: `${clean}\n... (${rawContent.length - clean.length} more chars truncated)`,
    truncated: true,
  };
}

/**
 * Convert a tool message to its summarized form for model context.
 * Preserves the original in the full message array; this returns a
 * replacement for the API call only.
 */
export function summarizeToolMessage(
  msg: ChatMessage,
  artifactStore: ToolArtifactStore | null = null,
  maxChars = DEFAULT_MAX_CHARS,
): ChatMessage {
  if (msg.role !== "tool" || typeof msg.content !== "string") {
    return msg;
  }
  const summary = summarizeToolOutput(msg.tool_call_id ?? "", msg.name, msg.content, artifactStore, maxChars);
  return {
    ...msg,
    content: summary.content,
  };
}

/**
 * Summarize all tool messages in a message array.
 * Non-tool messages are returned unchanged.
 */
export function summarizeToolMessages(
  messages: ChatMessage[],
  artifactStore: ToolArtifactStore | null = null,
  maxChars = DEFAULT_MAX_CHARS,
): ChatMessage[] {
  return messages.map((m) => (m.role === "tool" ? summarizeToolMessage(m, artifactStore, maxChars) : m));
}
