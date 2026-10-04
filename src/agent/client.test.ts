import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runKimi } from "./client.js";

describe("runKimi session affinity header", () => {
  let originalFetch: typeof globalThis.fetch;
  let lastRequest: Request | null = null;

  before(() => {
    originalFetch = globalThis.fetch;
    process.env.YOLO_TOKEN_FILE = "/dev/null/nonexistent-test-token-path";
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      lastRequest = new Request(input, init);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.YOLO_TOKEN_FILE;
  });

  it("sends X-Session-ID header when sessionId is provided", async () => {
    const gen = runKimi({
      accountId: "test",
      apiToken: "token",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      sessionId: "sess-123",
    });
    // exhaust generator
    for await (const _ of gen) {
      /* noop */
    }
    assert.ok(lastRequest);
    assert.strictEqual(lastRequest!.headers.get("X-Session-ID"), "sess-123");
  });

  it("does not send X-Session-ID header when sessionId is omitted", async () => {
    const gen = runKimi({
      accountId: "test",
      apiToken: "token",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    for await (const _ of gen) {
      /* noop */
    }
    assert.ok(lastRequest);
    assert.strictEqual(lastRequest!.headers.get("X-Session-ID"), null);
  });
});

describe("runKimi routing mode", () => {
  let originalFetch: typeof globalThis.fetch;
  let lastRequest: Request | null = null;
  let lastBody: string | null = null;

  before(() => {
    originalFetch = globalThis.fetch;
    process.env.YOLO_TOKEN_FILE = "/dev/null/nonexistent-test-token-path";
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      lastRequest = req;
      lastBody = init?.body === undefined ? null : String(init.body);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.YOLO_TOKEN_FILE;
  });

  it("direct mode: posts to api.cloudflare.com with model in the URL path (no model in body)", async () => {
    const gen = runKimi({
      accountId: "acct-xyz",
      apiToken: "cf-token",
      model: "@cf/moonshotai/kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
    });
    for await (const _ of gen) {
      /* noop */
    }
    assert.ok(lastRequest);
    assert.strictEqual(
      lastRequest!.url,
      "https://api.cloudflare.com/client/v4/accounts/acct-xyz/ai/run/@cf/moonshotai/kimi-k2.6",
    );
    assert.ok(lastBody);
    const body = JSON.parse(lastBody!) as Record<string, unknown>;
    assert.strictEqual(body.model, undefined, "direct mode must not set model in body");
  });

  it("router mode: posts to ${baseUrl}/v1/chat/completions with model in body", async () => {
    const gen = runKimi({
      accountId: "unused",
      apiToken: "router-token",
      model: "@cf/moonshotai/kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
      baseUrl: "https://router.example.com",
    });
    for await (const _ of gen) {
      /* noop */
    }
    assert.ok(lastRequest);
    assert.strictEqual(
      lastRequest!.url,
      "https://router.example.com/v1/chat/completions",
    );
    assert.strictEqual(
      lastRequest!.headers.get("Authorization"),
      "Bearer router-token",
      "router mode uses apiToken as the router bearer",
    );
    assert.ok(lastBody);
    const body = JSON.parse(lastBody!) as Record<string, unknown>;
    assert.strictEqual(body.model, "@cf/moonshotai/kimi-k2.6");
  });

  it("router mode: trims trailing slash from baseUrl", async () => {
    const gen = runKimi({
      accountId: "unused",
      apiToken: "router-token",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      baseUrl: "https://router.example.com///",
    });
    for await (const _ of gen) {
      /* noop */
    }
    assert.ok(lastRequest);
    assert.strictEqual(
      lastRequest!.url,
      "https://router.example.com/v1/chat/completions",
    );
  });
});

describe("runKimi rotated token", () => {
  let originalFetch: typeof globalThis.fetch;
  let lastAuth: string | null = null;
  let tmpDir: string;
  let tokenFile: string;

  before(() => {
    originalFetch = globalThis.fetch;
    tmpDir = mkdtempSync(join(tmpdir(), "yolo-client-test-"));
    tokenFile = join(tmpDir, "token");
    process.env.YOLO_TOKEN_FILE = tokenFile;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      lastAuth = req.headers.get("Authorization");
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.YOLO_TOKEN_FILE;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses the rotated-file token over opts.apiToken when the file exists", async () => {
    writeFileSync(tokenFile, "rotated-token-xyz\n", "utf-8");
    const gen = runKimi({
      accountId: "unused",
      apiToken: "stale-process-start-token",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      baseUrl: "https://router.example.com",
    });
    for await (const _ of gen) {
      /* noop */
    }
    assert.strictEqual(lastAuth, "Bearer rotated-token-xyz");
  });
});
