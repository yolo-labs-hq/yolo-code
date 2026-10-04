// Replays a saved SSE body through the parseStream logic to verify
// the accumulator handles reasoning/content/tool_calls deltas and the
// Cloudflare-specific trailing `{"response":"",...}` event + [DONE].
//
// Usage: tsx scripts/replay-stream.ts <path-to-sse-body>

import { readFile } from "node:fs/promises";
import { readSSE } from "../src/util/sse.js";

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: tsx scripts/replay-stream.ts <path>");
    process.exit(2);
  }
  const bytes = await readFile(path);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  // Inline a minimal copy of the accumulator logic for isolated testing —
  // we're exercising the same parsing code that runs in the client.
  const events: unknown[] = [];
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let lastUsage: unknown = null;
  let reasoning = "";
  let content = "";
  let finishReason: string | null = null;

  for await (const data of readSSE(stream)) {
    if (data === "[DONE]") {
      events.push({ type: "DONE" });
      break;
    }
    let c: any;
    try { c = JSON.parse(data); } catch { events.push({ type: "PARSE_ERROR", raw: data.slice(0, 80) }); continue; }
    if (c.usage) lastUsage = c.usage;
    const choice = c.choices?.[0];
    if (choice?.delta) {
      if (typeof choice.delta.reasoning_content === "string") reasoning += choice.delta.reasoning_content;
      if (typeof choice.delta.content === "string") content += choice.delta.content;
      if (Array.isArray(choice.delta.tool_calls)) {
        for (const tc of choice.delta.tool_calls) {
          const idx = tc.index ?? 0;
          let buf = toolCalls.get(idx);
          if (!buf) {
            buf = { id: tc.id ?? `tc_${idx}`, name: tc.function?.name ?? "", args: "" };
            toolCalls.set(idx, buf);
          } else {
            if (!buf.name && tc.function?.name) buf.name = tc.function.name;
            if (buf.id.startsWith("tc_") && tc.id) buf.id = tc.id;
          }
          if (typeof tc.function?.arguments === "string") buf.args += tc.function.arguments;
        }
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }

  console.log("reasoning chars:", reasoning.length);
  console.log("reasoning head:", JSON.stringify(reasoning.slice(0, 80)));
  console.log("content chars:", content.length);
  console.log("content:", JSON.stringify(content));
  console.log("finish_reason:", finishReason);
  console.log("tool_calls:");
  for (const [idx, tc] of toolCalls) {
    console.log(`  #${idx} id=${tc.id} name=${tc.name} args=${tc.args}`);
    try { console.log(`    parsed args:`, JSON.parse(tc.args)); } catch { console.log("    (args not valid JSON yet)"); }
  }
  console.log("last usage:", lastUsage);
  console.log("events seen:", events.length);
}

main().catch(e => { console.error(e); process.exit(1); });
