import { describe, it } from "node:test";
import assert from "node:assert";
import {
  mcpToolToSpec,
  inspectMcpResult,
  formatMcpResultText,
  extractStructuredContent,
} from "./adapter.js";

describe("mcpToolToSpec", () => {
  it("forwards the tool context AbortSignal to client.callTool", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;

    const entry = mcpToolToSpec(
      "studio",
      {
        name: "create_record",
        description: "test tool",
        inputSchema: { type: "object", properties: {} },
      },
      {
        async callTool(_params: unknown, _schema: unknown, options?: { signal?: AbortSignal }) {
          seenSignal = options?.signal;
          return { content: [{ type: "text", text: "ok" }] };
        },
      } as never,
    );

    const result = await entry.spec.run({}, { cwd: process.cwd(), signal: controller.signal });

    assert.strictEqual(result, "ok");
    assert.strictEqual(seenSignal, controller.signal);
  });

  it("returns rendered text for structuredContent-only responses", async () => {
    const entry = mcpToolToSpec(
      "studio",
      { name: "create_record", description: "", inputSchema: { type: "object", properties: {} } },
      {
        async callTool() {
          return { structuredContent: { recordId: "p1", state: "draft", version: 1 } };
        },
      } as never,
    );
    const result = await entry.spec.run({}, { cwd: process.cwd() });
    assert.strictEqual(typeof result, "string");
    assert.match(result as string, /"recordId": "p1"/);
    assert.match(result as string, /"state": "draft"/);
  });

  it("pretty-prints JSON text payloads so the model can reliably read ids", async () => {
    const entry = mcpToolToSpec(
      "studio",
      {
        name: "create_record",
        description: "test tool",
        inputSchema: { type: "object", properties: {} },
      },
      {
        async callTool() {
          return {
            content: [{ type: "text", text: "{\"recordId\":\"p1\",\"state\":\"draft\",\"version\":1}" }],
          };
        },
      } as never,
    );

    const result = await entry.spec.run({}, { cwd: process.cwd() });

    assert.strictEqual(typeof result, "string");
    if (typeof result !== "string") throw new Error("expected string result");
    assert.match(result, /"recordId": "p1"/);
    assert.match(result, /"state": "draft"/);
  });

  it("inspectMcpResult identifies the content channel and JSON-looking text", () => {
    const shape = inspectMcpResult({
      content: [
        { type: "text", text: '{"recordId":"p1"}' },
        { type: "resource", resource: { text: "ignored" } },
      ],
    });
    assert.strictEqual(shape.channel, "content");
    assert.strictEqual(shape.hasContent, true);
    assert.strictEqual(shape.hasStructuredContent, false);
    assert.strictEqual(shape.hasToolResult, false);
    assert.deepStrictEqual(shape.contentTypes, ["text", "resource"]);
    assert.strictEqual(shape.firstTextLooksLikeJson, true);
  });

  it("inspectMcpResult flags structuredContent as a distinct channel", () => {
    const shape = inspectMcpResult({
      structuredContent: { record: { id: "p1" } },
    });
    assert.strictEqual(shape.channel, "structuredContent");
    assert.strictEqual(shape.hasStructuredContent, true);
    assert.deepStrictEqual(shape.structuredKeys, ["record"]);
  });

  it("inspectMcpResult flags toolResult as a distinct channel", () => {
    const shape = inspectMcpResult({ toolResult: "legacy compatibility" });
    assert.strictEqual(shape.channel, "toolResult");
    assert.strictEqual(shape.hasToolResult, true);
  });

  it("inspectMcpResult tolerates non-object inputs", () => {
    const shape = inspectMcpResult(null);
    assert.strictEqual(shape.channel, "none");
    assert.strictEqual(shape.hasContent, false);
  });

  it("formatMcpResultText renders structuredContent-only responses (codex P2 fix)", () => {
    // Previously this returned "" because the routing check only looked for
    // `content`/`toolResult`, leaving structured-only MCP responses
    // invisible in the mcp.result trace event.
    const text = formatMcpResultText({
      structuredContent: { recordId: "p1", state: "draft" },
    });
    assert.ok(text.length > 0, "structured-only result should produce non-empty text");
    assert.match(text, /"recordId": "p1"/);
    assert.match(text, /"state": "draft"/);
  });

  it("formatMcpResultText still renders content-only responses", () => {
    const text = formatMcpResultText({
      content: [{ type: "text", text: "hello" }],
    });
    assert.match(text, /hello/);
  });

  it("formatMcpResultText still renders toolResult-only responses", () => {
    const text = formatMcpResultText({ toolResult: "legacy compat" });
    assert.match(text, /legacy compat/);
  });

  it("extractStructuredContent returns the object when populated", () => {
    const sc = extractStructuredContent({
      structuredContent: { recordId: "p1" },
    });
    assert.deepStrictEqual(sc, { recordId: "p1" });
  });

  it("extractStructuredContent returns undefined for missing/empty/array shapes", () => {
    assert.strictEqual(extractStructuredContent(null), undefined);
    assert.strictEqual(extractStructuredContent("not an object"), undefined);
    assert.strictEqual(extractStructuredContent({}), undefined);
    assert.strictEqual(extractStructuredContent({ structuredContent: {} }), undefined);
    assert.strictEqual(extractStructuredContent({ structuredContent: [] }), undefined);
    assert.strictEqual(extractStructuredContent({ structuredContent: null }), undefined);
  });

  it("throws when MCP reports an error result", async () => {
    const entry = mcpToolToSpec(
      "studio",
      {
        name: "create_record",
        description: "test tool",
        inputSchema: { type: "object", properties: {} },
      },
      {
        async callTool() {
          return {
            isError: true,
            content: [{ type: "text", text: "{\"error\":\"bad input\",\"code\":\"INVALID_ARGUMENT\"}" }],
          };
        },
      } as never,
    );

    await assert.rejects(
      entry.spec.run({}, { cwd: process.cwd() }),
      /INVALID_ARGUMENT: bad input/,
    );
  });
});
