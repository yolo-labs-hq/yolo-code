import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** All env vars that loadConfig reads. Snapshot and restore so tests
 *  don't leak into each other or the host shell. */
const ENV_KEYS = [
  "YOLO_ROUTER_BASE_URL",
  "YOLO_ROUTER_API_KEY",
  "YOLO_API_TOKEN",
  "YOLO_STUDIO_MCP_URL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CF_ACCOUNT_ID",
  "CF_API_TOKEN",
  "KIMI_MODEL",
  "KIMI_REASONING_EFFORT",
  "KIMI_THEME",
  "YOLO_CODE_COAUTHOR",
  "YOLO_CODE_COAUTHOR_NAME",
  "YOLO_CODE_COAUTHOR_EMAIL",
  "YOLO_CODE_CACHE_STABLE_PROMPTS",
  "YOLO_CODE_COMPILED_CONTEXT",
  "YOLO_CODE_IMAGE_HISTORY_TURNS",
  "YOLO_CODE_MAX_TOOL_ITERATIONS",
  "YOLO_CODE_MAX_INPUT_TOKENS",
  "YOLO_CODE_MAX_COMPLETION_TOKENS",
  "XDG_CONFIG_HOME",
];

const saved: Record<string, string | undefined> = {};

describe("loadConfig — studio MCP URL detection", () => {
  let tmp: string;

  before(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    tmp = mkdtempSync(join(tmpdir(), "yolo-code-cfg-"));
  });

  after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Isolate: start each case from a clean env, then redirect XDG_CONFIG_HOME
    // to an empty tmp dir so readFile(configPath()) fails with ENOENT and the
    // file-loaded branch isn't exercised.
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.XDG_CONFIG_HOME = tmp;
  });

  it("router mode without explicit YOLO_STUDIO_MCP_URL → studioMcpUrl undefined", async () => {
    // No auto-default: the in-container localhost:7780 proxy is per-agent
    // and not universally "the studio MCP", so sandbox infra must set
    // YOLO_STUDIO_MCP_URL explicitly.
    process.env.YOLO_ROUTER_BASE_URL = "https://router.example.com";
    process.env.YOLO_ROUTER_API_KEY = "rk_test";
    const { loadConfig } = await import(`./config.js?case=router-default&t=${Date.now()}`);
    const cfg = await loadConfig();
    assert.ok(cfg);
    assert.strictEqual(cfg!.routerBaseUrl, "https://router.example.com");
    assert.strictEqual(cfg!.studioMcpUrl, undefined);
  });

  it("standalone CF mode leaves studioMcpUrl undefined", async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
    process.env.CLOUDFLARE_API_TOKEN = "tok";
    const { loadConfig } = await import(`./config.js?case=standalone&t=${Date.now()}`);
    const cfg = await loadConfig();
    assert.ok(cfg);
    assert.strictEqual(cfg!.routerBaseUrl, undefined);
    assert.strictEqual(cfg!.studioMcpUrl, undefined);
  });

  it("YOLO_STUDIO_MCP_URL sets studioMcpUrl regardless of mode", async () => {
    process.env.YOLO_ROUTER_BASE_URL = "https://router.example.com";
    process.env.YOLO_ROUTER_API_KEY = "rk_test";
    process.env.YOLO_STUDIO_MCP_URL = "https://custom-mcp.example/mcp";
    const { loadConfig } = await import(`./config.js?case=override&t=${Date.now()}`);
    const cfg = await loadConfig();
    assert.ok(cfg);
    assert.strictEqual(cfg!.studioMcpUrl, "https://custom-mcp.example/mcp");
  });

  it("YOLO_STUDIO_MCP_URL empty-string explicitly disables studio MCP", async () => {
    process.env.YOLO_ROUTER_BASE_URL = "https://router.example.com";
    process.env.YOLO_ROUTER_API_KEY = "rk_test";
    process.env.YOLO_STUDIO_MCP_URL = "";
    const { loadConfig } = await import(`./config.js?case=disabled&t=${Date.now()}`);
    const cfg = await loadConfig();
    assert.ok(cfg);
    assert.strictEqual(cfg!.studioMcpUrl, undefined);
  });

  it("returns null when no credentials are configured at all", async () => {
    const { loadConfig } = await import(`./config.js?case=empty&t=${Date.now()}`);
    const cfg = await loadConfig();
    assert.strictEqual(cfg, null);
  });
});
