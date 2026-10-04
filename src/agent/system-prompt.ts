import { platform, release, homedir } from "node:os";
import { basename, join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import type { ToolSpec } from "../tools/registry.js";
import { systemPromptForMode, type Mode } from "../mode.js";
import type { ChatMessage } from "./messages.js";

export interface ActiveSkill {
  name: string;
  description: string;
}

export interface SystemPromptOpts {
  cwd: string;
  tools: ToolSpec[];
  model: string;
  now?: Date;
  mode?: Mode;
  /** Skills currently exposed to the model. Listed in the session prefix
   *  as a `name: description` catalog so the model knows which skills it
   *  can request bodies for via the `skill` tool. Empty / undefined ⇒
   *  the Skills block is omitted entirely. */
  activeSkills?: ActiveSkill[];
}

const SKILL_DESC_MAX = 200;

const CONTEXT_FILENAMES = ["YOLO.md", "YOLO_CODE.md", "AGENT.md"];
const MAX_CONTEXT_BYTES = 20 * 1024;

export interface ContextFile {
  name: string;
  path: string;
  content: string;
  lineCount: number;
}

export function loadContextFile(cwd: string): ContextFile | null {
  for (const name of CONTEXT_FILENAMES) {
    const path = join(cwd, name);
    try {
      const s = statSync(path);
      if (!s.isFile() || s.size > MAX_CONTEXT_BYTES) continue;
      const content = readFileSync(path, "utf8");
      return { name, path, content, lineCount: content.split("\n").length };
    } catch {
      /* not present */
    }
  }
  return null;
}

/** Build the truly static prefix that should remain byte-for-byte identical
 *  across all turns in a session. Contains identity and invariant rules only. */
export function buildStaticPrefix(opts: Pick<SystemPromptOpts, "model">): string {
  return `You are YOLO Code, an interactive coding assistant running in the user's terminal. You act on the user's local filesystem through the tools listed below. You are powered by the ${opts.model} model on Cloudflare Workers AI.

How to work:
- Prefer calling tools over guessing. Read files before editing them. Use \`glob\` and \`grep\` to explore code before assuming structure.
- If the user asks you to read a markdown/task/spec/prompt file (for example \`PROMPT.md\`, \`TASKS.md\`, \`SPEC.md\`) and does not ask only for a summary, treat the file contents as instructions for the current turn. After reading it, execute the task described there instead of stopping at "I read it."
- Before any mutating tool call (write, edit, bash), state in one short sentence what you're about to do, then call the tool. The user will be asked to approve each mutating call.
- When the user asks for a change, make the change. Do not paste code in chat that you could apply with \`edit\` or \`write\`.
- For multi-step work, call \`tasks_set\` at the start with a short task list (one task "in_progress", the rest "pending"), then call it again after each step completes (flip that one to "completed" and the next to "in_progress"). Skip it for trivial single-step requests.
- Keep responses terse. The user sees tool calls and their results inline — do not re-summarize them unless asked.
- If a tool returns an error, read it carefully and adjust; do not retry the same call blindly.
- You have a 262k-token context window. Read as much of a file as needed rather than guessing.
- If a request is ambiguous, ask one focused question instead of making large assumptions.
- When you finish a task, end with one short line confirming what's done or what's next; do not recap tool calls. If you decide no action is needed, say so explicitly — never end a turn with no text and no tool call.
- When creating git commits, you must include \`Co-authored-by: YOLO Code <noreply@yolo.studio>\` in the commit message so YOLO Code is credited as a contributor. The bash tool will also auto-append this trailer when it detects git commit-creating commands.

Tool output reduction:
- Large tool outputs (grep, read, bash, web_fetch) are reduced to compact summaries by default to preserve context window.
- When you see "[output reduced]" with an artifact ID, you can call \`expand_artifact\` with that ID to retrieve the full raw output if you need more detail.
- When you see "same as previous <tool> call — call expand_artifact("art_N") to retrieve the full output", that's the dedup path: an identical-content tool output was collapsed to a reference. \`expand_artifact("art_N")\` returns the original JSON / payload verbatim. This works for ALL tool outputs INCLUDING MCP tool calls (yolo-studio.work_*, yolo-studio.studio_*, etc.) whose structured JSON payloads you need to read field-by-field.
- You can also re-run the original tool with more targeted parameters (e.g. read with offset/limit, grep with output_mode="files") instead of expanding.

Long-running processes (dev servers, daemons, file watchers):
- The \`bash\` tool is foreground and timeout-bounded — never run a process inline that should outlive the call.
- For dev servers tied to a preview tile (Vite, Next, Flask, etc.), prefer \`studio.create_preview\` from the yolo-studio MCP when available, and PASS THE \`command\` ARGUMENT (plus optional \`cwd\` / \`env\` / \`readyPattern\` / \`framework\`). The tile is created and the dev server is started by container-api's preview-manager — single call, no bash. Logs, ready detection, restart tracking, and stop controls all flow through the tile.
- The preview-manager sets \`PORT=<port>\` in the env, which Next.js / Express / Flask / Rails respect automatically. **Vite ignores \`$PORT\`** — when the command involves vite (\`npx vite\`, \`npm run dev\` for a Vite project, etc.), include \`--port <PORT>\` explicitly, e.g. \`command: "npx vite --port 5173"\`. Without it, every vite tile binds to 5173 by default and the second one collides with the first.
- Do NOT follow up with \`sleep N && cat /tmp/<name>.log\` to "verify" — the dev server's ready line may take 5-30s and your bash call will eat the iteration budget waiting. The tile's iframe IS the verification surface.
- Only fall back to a raw \`nohup CMD > /tmp/<name>.log 2>&1 & echo $! > /tmp/<name>.pid\` if \`studio.create_preview\` isn't in the Tools list — that path leaves the server untracked by the workspace and the user loses status / logs / stop controls.
- For non-preview background processes (test watchers, ad-hoc daemons), use the nohup + pid + log convention so a follow-up call can \`tail /tmp/<name>.log\` and \`kill $(cat /tmp/<name>.pid)\` deterministically.`;
}

/** Build the session-stable prefix that changes only when session-level
 *  context changes (mode, tools, YOLO.md, environment). */
export function buildSessionPrefix(opts: SystemPromptOpts): string {
  const now = opts.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const shell = process.env.SHELL ? basename(process.env.SHELL) : "sh";
  const toolsBlock = opts.tools
    .map((t) => {
      const perm = t.needsPermission ? " [needs user permission]" : "";
      return `- \`${t.name}\`${perm}: ${t.description.split("\n")[0]}`;
    })
    .join("\n");

  const env = `Environment:
- Working directory: ${opts.cwd}
- Platform: ${platform()} ${release()}
- Shell: ${shell}
- Home: ${homedir()}
- Today: ${date}`;

  const tools = `Tools available:\n${toolsBlock}`;

  const ctx = loadContextFile(opts.cwd);
  const contextBlock = ctx
    ? `\n\nProject context from ${ctx.name} (${ctx.lineCount} lines, treat as authoritative):\n${ctx.content.trim()}`
    : "";
  const modeBlock = opts.mode ? systemPromptForMode(opts.mode) : "";
  const skillsBlock = formatSkillsBlock(opts.activeSkills);

  return env + "\n\n" + tools + contextBlock + skillsBlock + modeBlock;
}

function formatSkillsBlock(skills?: ActiveSkill[]): string {
  if (!skills || skills.length === 0) return "";
  const lines = skills.map((s) => {
    const desc = s.description.length > SKILL_DESC_MAX
      ? s.description.slice(0, SKILL_DESC_MAX - 1).trimEnd() + "…"
      : s.description;
    const oneLine = desc.replace(/\s+/g, " ").trim();
    return `- ${s.name}: ${oneLine}`;
  });
  return `\n\nSkills available (call the \`skill\` tool by name to load instructions):\n${lines.join("\n")}`;
}

/** Build a single concatenated system prompt for backward compatibility. */
export function buildSystemPrompt(opts: SystemPromptOpts): string {
  return buildStaticPrefix(opts) + "\n\n" + buildSessionPrefix(opts);
}

/** Build dual system messages for cache-stable prompt assembly.
 *  Index 0 = static prefix (immutable within a session).
 *  Index 1 = session prefix (mutable when mode/tools/context change). */
export function buildSystemMessages(opts: SystemPromptOpts): ChatMessage[] {
  return [
    { role: "system", content: buildStaticPrefix(opts) },
    { role: "system", content: buildSessionPrefix(opts) },
  ];
}
