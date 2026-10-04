import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Replaced at build time by tsup's `define` (both tsup.config.ts and
// tsup.bundle.config.ts). In a build where the substitution didn't run
// (e.g. running source via tsx during dev) the identifier stays as a
// literal and we fall back to reading the sibling package.json.
declare const BUILD_VERSION: string;

let cached: string | undefined;

export function getBuildVersion(): string {
  if (cached !== undefined) return cached;
  try {
    if (typeof BUILD_VERSION === "string" && BUILD_VERSION !== "__BUILD_VERSION__") {
      cached = BUILD_VERSION;
      return cached;
    }
  } catch {
    /* identifier genuinely unreplaced — fall through to filesystem */
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(`${here}/../../package.json`, "utf8")) as {
      version?: string;
    };
    cached = pkg.version ?? "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
