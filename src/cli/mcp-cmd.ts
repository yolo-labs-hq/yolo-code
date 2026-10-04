import type { McpServerConfig } from "../config.js";
import { readRawConfig, writeRawConfig } from "./raw-config.js";

interface AddOpts {
  env: string[];
}

interface AddHttpOpts {
  header: string[];
}

function parseKvPairs(pairs: string[], flagName: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--${flagName} expects KEY=VALUE, got "${pair}"`);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function ensureUniqueName(servers: Record<string, McpServerConfig>, name: string): void {
  if (servers[name]) {
    throw new Error(`MCP server "${name}" already exists; \`yolo-code mcp remove ${name}\` first to replace it`);
  }
}

export async function mcpAdd(name: string, command: string[], opts: AddOpts): Promise<number> {
  if (command.length === 0) {
    process.stderr.write("yolo-code mcp add: missing command\n");
    return 2;
  }
  let env: Record<string, string>;
  try {
    env = parseKvPairs(opts.env, "env");
  } catch (e) {
    process.stderr.write(`yolo-code mcp add: ${(e as Error).message}\n`);
    return 2;
  }
  const cfg = await readRawConfig();
  cfg.mcpServers ??= {};
  try {
    ensureUniqueName(cfg.mcpServers, name);
  } catch (e) {
    process.stderr.write(`yolo-code mcp add: ${(e as Error).message}\n`);
    return 2;
  }
  const entry: McpServerConfig = { type: "local", command };
  if (Object.keys(env).length > 0) entry.env = env;
  cfg.mcpServers[name] = entry;
  const path = await writeRawConfig(cfg);
  process.stdout.write(`added MCP server "${name}" (local: ${command.join(" ")})  (${path})\n`);
  return 0;
}

export async function mcpAddHttp(name: string, url: string, opts: AddHttpOpts): Promise<number> {
  let headers: Record<string, string>;
  try {
    headers = parseKvPairs(opts.header, "header");
  } catch (e) {
    process.stderr.write(`yolo-code mcp add-http: ${(e as Error).message}\n`);
    return 2;
  }
  const cfg = await readRawConfig();
  cfg.mcpServers ??= {};
  try {
    ensureUniqueName(cfg.mcpServers, name);
  } catch (e) {
    process.stderr.write(`yolo-code mcp add-http: ${(e as Error).message}\n`);
    return 2;
  }
  const entry: McpServerConfig = { type: "remote", url };
  if (Object.keys(headers).length > 0) entry.headers = headers;
  cfg.mcpServers[name] = entry;
  const path = await writeRawConfig(cfg);
  process.stdout.write(`added MCP server "${name}" (remote: ${url})  (${path})\n`);
  return 0;
}

export async function mcpRemove(name: string): Promise<number> {
  const cfg = await readRawConfig();
  if (!cfg.mcpServers?.[name]) {
    process.stderr.write(`yolo-code mcp remove: no MCP server named "${name}"\n`);
    return 1;
  }
  delete cfg.mcpServers[name];
  const path = await writeRawConfig(cfg);
  process.stdout.write(`removed MCP server "${name}"  (${path})\n`);
  return 0;
}

export async function mcpList(): Promise<number> {
  const cfg = await readRawConfig();
  const servers = cfg.mcpServers ?? {};
  const names = Object.keys(servers);
  if (names.length === 0) {
    process.stdout.write("(no MCP servers configured)\n");
    return 0;
  }
  // Compute max name width for column alignment.
  const nameWidth = Math.max(4, ...names.map((n) => n.length));
  process.stdout.write(`${"NAME".padEnd(nameWidth)}  TYPE    DETAILS\n`);
  for (const name of names) {
    const s = servers[name]!;
    const detail =
      s.type === "local"
        ? (s.command ?? []).join(" ")
        : s.url ?? "";
    process.stdout.write(`${name.padEnd(nameWidth)}  ${s.type.padEnd(6)}  ${detail}\n`);
  }
  return 0;
}

export async function mcpGet(name: string): Promise<number> {
  const cfg = await readRawConfig();
  const server = cfg.mcpServers?.[name];
  if (!server) {
    process.stderr.write(`yolo-code mcp get: no MCP server named "${name}"\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify(server, null, 2) + "\n");
  return 0;
}
