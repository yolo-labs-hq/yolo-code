import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolContext, ToolSpec } from "../tools/registry.js";
import {
  isTraceEnabled,
  redactedPayload,
  redactedStructuredPayload,
  tryParseJsonRedacted,
  traceEvent,
} from "../trace-log.js";

export interface McpToolEntry {
  spec: ToolSpec;
  originalName: string;
  serverName: string;
}

export function mcpToolToSpec(
  serverName: string,
  mcpTool: {
    name: string;
    description?: string;
    inputSchema: {
      type: "object";
      properties?: Record<string, object>;
      required?: string[];
    };
  },
  client: Client,
): McpToolEntry {
  const prefix = `mcp_${sanitizeName(serverName)}_`;
  const prefixedName = `${prefix}${sanitizeName(mcpTool.name)}`;

  const spec: ToolSpec = {
    name: prefixedName,
    description: mcpTool.description ?? `MCP tool ${mcpTool.name} from ${serverName}`,
    parameters: mcpTool.inputSchema as Record<string, unknown>,
    needsPermission: true,
    // Surface the original (un-prefixed) MCP tool name so the loop
    // guard classifies by semantic name, not by the server-prefixed
    // wrapper whose leading segments could shadow real verbs.
    //
    // SANITIZED via the same `[^a-zA-Z0-9_] → _` transform that the
    // prefixedName uses — `isReadOnlyToolName` tokenizes on `_` only,
    // so raw names like `db.get_run` or `read-file` would otherwise
    // lose their verbs (codex round 4 P1). Post-sanitization those
    // become `db_get_run` / `read_file` and the segment-scan picks
    // up `get` / `read` correctly.
    originalName: sanitizeName(mcpTool.name),
    render: () => ({ title: `${prefixedName}` }),
    async run(args, ctx: ToolContext) {
      const startedAt = Date.now();
      if (isTraceEnabled()) {
        traceEvent("mcp.call", {
          server: serverName,
          tool: mcpTool.name,
          prefixedName,
          argsJson: tryParseJsonRedacted(JSON.stringify(args ?? {})),
        });
      }

      let result: unknown;
      try {
        result = await client.callTool({
          name: mcpTool.name,
          arguments: args as Record<string, unknown>,
        }, undefined, { signal: ctx.signal });
      } catch (e) {
        if (isTraceEnabled()) {
          traceEvent("mcp.transport_error", {
            server: serverName,
            tool: mcpTool.name,
            prefixedName,
            elapsedMs: Date.now() - startedAt,
            error: (e as Error).message ?? String(e),
            name: (e as Error).name ?? "Error",
          });
        }
        throw e;
      }

      const isErr = "isError" in (result as object) && (result as { isError?: unknown }).isError === true;

      if (isTraceEnabled()) {
        const shape = inspectMcpResult(result);
        const formatted = formatMcpResultText(result);
        const structured = extractStructuredContent(result);
        traceEvent("mcp.result", {
          server: serverName,
          tool: mcpTool.name,
          prefixedName,
          elapsedMs: Date.now() - startedAt,
          isError: isErr,
          shape,
          parsed: shape.firstTextLooksLikeJson
            ? tryParseJsonRedacted(shape.firstTextSample)
            : undefined,
          // Capture structured-only payloads with redaction and bounded size.
          ...redactedStructuredPayload(structured),
          ...redactedPayload(formatted),
        });
      }

      if (isErr) {
        throw new Error(formatMcpResult(result));
      }

      // Render text and structured content before considering toolResult.
      const obj = (typeof result === "object" && result !== null) ? (result as Record<string, unknown>) : null;
      if (obj && (Array.isArray(obj.content) || (typeof obj.structuredContent === "object" && obj.structuredContent !== null))) {
        const rendered = formatMcpResult(result);
        if (rendered) return rendered;
      }

      if (obj && "toolResult" in obj) {
        return formatUnknownPayload(obj.toolResult);
      }

      return "";
    },
  };

  return { spec, originalName: mcpTool.name, serverName };
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

interface McpResultShape {
  hasContent: boolean;
  hasStructuredContent: boolean;
  hasToolResult: boolean;
  contentTypes: string[];
  contentLen: number;
  structuredKeys: string[];
  firstTextSample: string;
  firstTextLooksLikeJson: boolean;
  channel: "content" | "structuredContent" | "toolResult" | "none";
}

// Describe result channels for MCP trace events.
export function inspectMcpResult(result: unknown): McpResultShape {
  const obj = (typeof result === "object" && result !== null) ? (result as Record<string, unknown>) : {};
  const content = Array.isArray(obj.content) ? (obj.content as unknown[]) : [];
  const structured = obj.structuredContent && typeof obj.structuredContent === "object"
    ? (obj.structuredContent as Record<string, unknown>)
    : undefined;
  const hasContent = content.length > 0;
  const hasStructured = !!structured && Object.keys(structured).length > 0;
  const hasToolResult = "toolResult" in obj;
  const types: string[] = [];
  let firstText = "";
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const t = (item as { type?: unknown }).type;
    if (typeof t === "string") types.push(t);
    if (!firstText && t === "text" && typeof (item as { text?: unknown }).text === "string") {
      firstText = (item as { text: string }).text;
    }
  }
  const firstSample = firstText.length > 400 ? firstText.slice(0, 400) : firstText;
  let channel: McpResultShape["channel"] = "none";
  if (hasContent) channel = "content";
  else if (hasStructured) channel = "structuredContent";
  else if (hasToolResult) channel = "toolResult";
  const stripped = firstSample.trim();
  const firstTextLooksLikeJson = stripped.startsWith("{") || stripped.startsWith("[");
  return {
    hasContent,
    hasStructuredContent: hasStructured,
    hasToolResult,
    contentTypes: types,
    contentLen: content.length,
    structuredKeys: structured ? Object.keys(structured) : [],
    firstTextSample: firstSample,
    firstTextLooksLikeJson,
    channel,
  };
}

// Wrapper exposed for testability — internal callers use formatMcpResult.
// Routes any result carrying `content` OR `structuredContent` through
// `formatMcpResult` (which renders both channels). Without the
// `structuredContent` branch, structured-only MCP responses fell back to
// the empty-string default, blanking the trace payload for the exact
// case the trace was meant to diagnose.
export function formatMcpResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const obj = result as Record<string, unknown>;
  if ("content" in obj || "structuredContent" in obj) {
    return formatMcpResult(result);
  }
  if ("toolResult" in obj) {
    return formatUnknownPayload(obj.toolResult);
  }
  return "";
}

// Returns the raw `structuredContent` object when present and non-empty,
// otherwise undefined. Caller is responsible for redaction (we keep this
// pure so tests can inspect the unmasked shape).
export function extractStructuredContent(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const obj = result as Record<string, unknown>;
  const sc = obj.structuredContent;
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) return undefined;
  const record = sc as Record<string, unknown>;
  return Object.keys(record).length > 0 ? record : undefined;
}

function formatMcpResult(result: unknown): string {
  const content = (
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray((result as { content?: unknown[] }).content)
  )
    ? (result as { content: unknown[] }).content
    : [];
  const structuredContent = (
    typeof result === "object" &&
    result !== null &&
    "structuredContent" in result &&
    typeof (result as { structuredContent?: unknown }).structuredContent === "object" &&
    (result as { structuredContent?: unknown }).structuredContent !== null &&
    !Array.isArray((result as { structuredContent?: unknown }).structuredContent)
  )
    ? ((result as { structuredContent: Record<string, unknown> }).structuredContent)
    : undefined;
  const parts: string[] = [];

  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item !== "object" || item === null || !("type" in item)) continue;
      if (item.type === "text" && "text" in item && typeof item.text === "string") {
        parts.push(prettyJsonIfPossible(item.text));
      } else if (
        item.type === "resource" &&
        "resource" in item &&
        typeof item.resource === "object" &&
        item.resource !== null &&
        "text" in item.resource &&
        typeof item.resource.text === "string"
      ) {
        parts.push(item.resource.text);
      }
    }
  }

  if (structuredContent && Object.keys(structuredContent).length > 0) {
    const structured = JSON.stringify(structuredContent, null, 2);
    if (!parts.includes(structured)) parts.push(structured);
  }

  const text = parts.filter((p) => p.trim().length > 0).join("\n");
  const parsed = parseJsonObject(text);
  if (parsed && typeof parsed.error === "string") {
    const code = typeof parsed.code === "string" ? `${parsed.code}: ` : "";
    return `${code}${parsed.error}`;
  }
  return text;
}

function prettyJsonIfPossible(text: string): string {
  const parsed = parseJsonObject(text);
  return parsed ? JSON.stringify(parsed, null, 2) : text;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function formatUnknownPayload(value: unknown): string {
  if (typeof value === "string") return prettyJsonIfPossible(value);
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
