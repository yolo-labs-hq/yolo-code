import type { ToolDef } from "../agent/messages.js";
import type { Task } from "../tasks-state.js";

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  onTasks?: (tasks: Task[]) => void;
  coauthor?: { name: string; email: string };
}

export interface ToolRender {
  title: string;
  body?: string;
  diff?: { path: string; before: string; after: string };
}

export interface ToolOutput {
  content: string;
  rawBytes: number;
  reducedBytes: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolSpec<Args = any> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  needsPermission: boolean;
  /** Original (un-prefixed) tool name when the spec wraps an MCP tool.
   *  The agent-side loop guard reads this so it can classify a tool
   *  as read-only/mutating from the SEMANTIC name (e.g. "get_run")
   *  rather than the server-prefixed name (e.g.
   *  "mcp_yolo_studio_studio_list_tiles") whose leading segments could
   *  contain a user-configured server name that aliases a verb. */
  originalName?: string;
  render?: (args: Args) => ToolRender;
  run: (args: Args, ctx: ToolContext) => Promise<string | ToolOutput>;
}

export function toOpenAIToolDefs(tools: ToolSpec[]): ToolDef[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
