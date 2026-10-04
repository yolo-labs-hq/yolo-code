import { configPath, type KimiConfig } from "../config.js";
import { readRawConfig, writeRawConfig } from "./raw-config.js";

// Top-level config keys the CLI is willing to set via `yolo-code config set`.
// `mcpServers` is intentionally NOT here — that's edited by `yolo-code mcp`
// subcommands so users don't have to hand-craft JSON for nested types.
const SETTABLE_KEYS = [
  "accountId",
  "apiToken",
  "model",
  "theme",
  "reasoningEffort",
  "coauthor",
  "coauthorName",
  "coauthorEmail",
  "cacheStablePrompts",
  "compiledContext",
  "imageHistoryTurns",
  "maxToolIterations",
  "maxInputTokens",
  "maxCompletionTokens",
  "routerBaseUrl",
  "studioMcpUrl",
] as const;

type SettableKey = (typeof SETTABLE_KEYS)[number];

const BOOL_KEYS = new Set<SettableKey>([
  "coauthor",
  "cacheStablePrompts",
  "compiledContext",
]);

const NUMBER_KEYS = new Set<SettableKey>([
  "imageHistoryTurns",
  "maxToolIterations",
  "maxInputTokens",
  "maxCompletionTokens",
]);

const ENUM_KEYS: Partial<Record<SettableKey, readonly string[]>> = {
  reasoningEffort: ["low", "medium", "high"],
};

// Keys whose values shouldn't be echoed back in `config list` /
// `config get` (treat as secret-ish — the file itself is mode 0600).
const SECRET_KEYS = new Set<SettableKey>(["apiToken"]);

function isSettable(key: string): key is SettableKey {
  return (SETTABLE_KEYS as readonly string[]).includes(key);
}

function parseValue(key: SettableKey, raw: string): unknown {
  if (BOOL_KEYS.has(key)) {
    if (raw === "true" || raw === "1" || raw === "yes") return true;
    if (raw === "false" || raw === "0" || raw === "no") return false;
    throw new Error(`${key}: expected boolean (true|false), got "${raw}"`);
  }
  if (NUMBER_KEYS.has(key)) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`${key}: expected positive integer, got "${raw}"`);
    }
    return n;
  }
  const allowed = ENUM_KEYS[key];
  if (allowed && !allowed.includes(raw)) {
    throw new Error(`${key}: expected one of ${allowed.join("|")}, got "${raw}"`);
  }
  return raw;
}

function redactSecrets(cfg: Partial<KimiConfig>): Partial<KimiConfig> {
  const redacted: Partial<KimiConfig> = { ...cfg };
  for (const key of SECRET_KEYS) {
    if (redacted[key] !== undefined && redacted[key] !== "") {
      (redacted as Record<string, unknown>)[key] = "***hidden***";
    }
  }
  return redacted;
}

export async function configGet(key: string): Promise<number> {
  if (!isSettable(key) && key !== "mcpServers") {
    process.stderr.write(`yolo-code config: unknown key "${key}"\n`);
    process.stderr.write(`Settable keys: ${SETTABLE_KEYS.join(", ")}\n`);
    return 2;
  }
  const cfg = await readRawConfig();
  const value = (cfg as Record<string, unknown>)[key];
  if (value === undefined) return 1;
  if (SECRET_KEYS.has(key as SettableKey) && typeof value === "string" && value.length > 0) {
    process.stdout.write("***hidden***\n");
    return 0;
  }
  if (typeof value === "object") {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  } else {
    process.stdout.write(String(value) + "\n");
  }
  return 0;
}

export async function configSet(key: string, raw: string): Promise<number> {
  if (!isSettable(key)) {
    process.stderr.write(`yolo-code config: cannot set "${key}" via config set\n`);
    if (key === "mcpServers") {
      process.stderr.write(`Use \`yolo-code mcp add\` / \`yolo-code mcp remove\` instead.\n`);
    } else {
      process.stderr.write(`Settable keys: ${SETTABLE_KEYS.join(", ")}\n`);
    }
    return 2;
  }
  let value: unknown;
  try {
    value = parseValue(key, raw);
  } catch (e) {
    process.stderr.write(`yolo-code config: ${(e as Error).message}\n`);
    return 2;
  }
  const cfg = await readRawConfig();
  (cfg as Record<string, unknown>)[key] = value;
  const path = await writeRawConfig(cfg);
  const display = SECRET_KEYS.has(key) && typeof value === "string" ? "***hidden***" : JSON.stringify(value);
  process.stdout.write(`set ${key} = ${display}  (${path})\n`);
  return 0;
}

export async function configRemove(key: string): Promise<number> {
  if (!isSettable(key) && key !== "mcpServers") {
    process.stderr.write(`yolo-code config: unknown key "${key}"\n`);
    return 2;
  }
  const cfg = await readRawConfig();
  if ((cfg as Record<string, unknown>)[key] === undefined) {
    process.stderr.write(`yolo-code config: ${key} is not set\n`);
    return 1;
  }
  delete (cfg as Record<string, unknown>)[key];
  const path = await writeRawConfig(cfg);
  process.stdout.write(`removed ${key}  (${path})\n`);
  return 0;
}

export async function configList(): Promise<number> {
  const cfg = await readRawConfig();
  const display = redactSecrets(cfg);
  process.stdout.write(JSON.stringify(display, null, 2) + "\n");
  return 0;
}

export async function configPathCmd(): Promise<number> {
  process.stdout.write(configPath() + "\n");
  return 0;
}
