import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolSpec } from "../tools/registry.js";
import { getBuildVersion } from "../util/version.js";
import { mcpToolToSpec, type McpToolEntry } from "./adapter.js";

export type McpTransportKind = "stdio" | "sse" | "http";

export interface McpServerInfo {
  name: string;
  toolCount: number;
  type: McpTransportKind;
}

type AnyMcpTransport =
  | StdioClientTransport
  | SSEClientTransport
  | StreamableHTTPClientTransport;

interface ActiveConnection {
  client: Client;
  transport: AnyMcpTransport;
  tools: McpToolEntry[];
  kind: McpTransportKind;
}

export class McpManager {
  private connections = new Map<string, ActiveConnection>();

  async addLocalServer(name: string, command: string[], env?: Record<string, string>): Promise<void> {
    if (this.connections.has(name)) {
      await this.removeServer(name);
    }

    const transport = new StdioClientTransport({
      command: command[0]!,
      args: command.slice(1),
      env,
      stderr: "pipe",
    });
    await this.finalize(name, transport, "stdio");
  }

  async addRemoteServer(name: string, url: string, headers?: Record<string, string>): Promise<void> {
    if (this.connections.has(name)) {
      await this.removeServer(name);
    }

    const transport = new SSEClientTransport(new URL(url), {
      requestInit: headers ? { headers } : undefined,
    });
    await this.finalize(name, transport, "sse");
  }

  /**
   * Connect via Streamable HTTP (POST /mcp). This is the preferred
   * transport for the in-container yolo-studio mcp-proxy at
   * localhost:7780/mcp — stateless, no legacy SSE session handshake.
   */
  async addHttpServer(name: string, url: string, headers?: Record<string, string>): Promise<void> {
    if (this.connections.has(name)) {
      await this.removeServer(name);
    }

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: headers ? { headers } : undefined,
    });
    await this.finalize(name, transport, "http");
  }

  private async finalize(
    name: string,
    transport: AnyMcpTransport,
    kind: McpTransportKind,
  ): Promise<void> {
    const client = new Client({ name: "yolo-code", version: getBuildVersion() });
    await client.connect(transport);

    const listResult = await client.listTools();
    const tools = listResult.tools.map((t) => mcpToolToSpec(name, t, client));

    this.connections.set(name, { client, transport, tools, kind });
  }

  removeServer(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return Promise.resolve();
    this.connections.delete(name);
    return conn.transport.close().catch(() => {});
  }

  async disconnectAll(): Promise<void> {
    for (const [name] of this.connections) {
      await this.removeServer(name);
    }
  }

  getAllTools(): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const conn of this.connections.values()) {
      for (const entry of conn.tools) {
        out.push(entry.spec);
      }
    }
    return out;
  }

  listServers(): McpServerInfo[] {
    const out: McpServerInfo[] = [];
    for (const [name, conn] of this.connections) {
      out.push({
        name,
        toolCount: conn.tools.length,
        type: conn.kind,
      });
    }
    return out;
  }
}
