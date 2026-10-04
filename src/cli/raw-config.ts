import { readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { configPath, type KimiConfig } from "../config.js";

/** Read the raw config JSON without applying env-var fallbacks or
 *  validating credentials. Subcommands need this — `yolo-code config set`
 *  and `yolo-code mcp add` must work before any auth is configured, but
 *  `loadConfig()` returns null in that case. Returns an empty
 *  partial config when the file doesn't exist. */
export async function readRawConfig(): Promise<Partial<KimiConfig>> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<KimiConfig>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeRawConfig(cfg: Partial<KimiConfig>): Promise<string> {
  const p = configPath();
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify(cfg, null, 2), "utf8");
  await chmod(p, 0o600);
  return p;
}
