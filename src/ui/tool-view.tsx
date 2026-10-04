import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { DiffView } from "./diff-view.js";
import { collapsePathsInText } from "../util/paths.js";

export interface ToolEventState {
  id: string;
  name: string;
  args: string;
  status: "running" | "done" | "error";
  result?: string;
  render?: { title: string; body?: string; diff?: { path: string; before: string; after: string } };
  expanded?: boolean;
}

interface Props {
  evt: ToolEventState;
  verbose?: boolean;
}

export const ToolView = React.memo(function ToolView({ evt, verbose }: Props) {
  const statusIcon =
    evt.status === "running" ? (
      <Text color="gray">
        <Spinner type="dots" />
      </Text>
    ) : evt.status === "error" ? (
      <Text color="red">✗</Text>
    ) : (
      <Text color="green">✓</Text>
    );
  const title = evt.render?.title ?? `${evt.name}(${compactArgs(evt.args)})`;
  const expand = Boolean(evt.expanded || verbose);
  const lines = evt.result ? evt.result.split("\n") : [];
  const showLimit = verbose ? 200 : 20;
  const summary =
    evt.status === "done" && evt.result && !evt.render?.diff
      ? resultSummary(evt.name, evt.result)
      : null;

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>
        {statusIcon}{" "}
        <Text color="gray">{title}</Text>
        {summary ? (
          <Text color="gray" dimColor>
            {"  "}· {summary}
          </Text>
        ) : null}
      </Text>
      {evt.render?.diff ? (
        <Box marginLeft={2}>
          <DiffView {...evt.render.diff} />
        </Box>
      ) : null}
      {evt.result && expand ? (
        <Box
          marginLeft={2}
          marginTop={1}
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
        >
          {lines.slice(0, showLimit).map((l, i) => (
            <Text key={i} color="gray" dimColor>
              {l}
            </Text>
          ))}
          {lines.length > showLimit && (
            <Text color="gray" dimColor>
              … ({lines.length - showLimit} more lines)
            </Text>
          )}
        </Box>
      ) : null}
    </Box>
  );
});

function compactArgs(raw: string): string {
  const collapsed = collapsePathsInText(raw, process.cwd());
  const s = collapsed.replace(/\s+/g, " ");
  return s.length <= 80 ? s : s.slice(0, 80) + "…";
}

/** One-line, tool-aware summary shown inline next to the tool title when
 *  the tool is done and not expanded. Keeps the transcript quiet — users
 *  get a numeric signal without a full first-line preview of the payload
 *  (which was noisy: e.g. the first line of a large `read` is usually an
 *  import statement, not useful). Matches Claude Code's "● Read(file)
 *  (50 lines)" style. */
function resultSummary(toolName: string, result: string): string | null {
  const trimmed = result.trim();
  if (!trimmed) return "empty";
  const lines = result.split("\n").length;

  switch (toolName) {
    case "read":
      return `${lines} line${lines === 1 ? "" : "s"}`;
    case "write": {
      // write's result is short (e.g. "Wrote 42 lines to path"); pass it
      // through when terse, otherwise fall back to line count.
      const first = trimmed.split("\n")[0]!;
      return first.length <= 60 ? first : `${lines} line${lines === 1 ? "" : "s"}`;
    }
    case "edit":
      return "applied";
    case "bash": {
      const first = trimmed.split("\n").find((l) => l.trim().length > 0) ?? "";
      if (lines === 1 && first.length <= 60) return first;
      return `${lines} line${lines === 1 ? "" : "s"}`;
    }
    case "grep": {
      // `grep` usually returns one match per line; count them.
      const matchLines = result.split("\n").filter((l) => l.trim().length > 0).length;
      return `${matchLines} match${matchLines === 1 ? "" : "es"}`;
    }
    case "glob": {
      const paths = result.split("\n").filter((l) => l.trim().length > 0).length;
      return `${paths} path${paths === 1 ? "" : "s"}`;
    }
    case "web_fetch":
    case "web_search":
      return `${lines} line${lines === 1 ? "" : "s"}`;
    case "tasks_set":
      return "updated";
    default:
      return `${lines} line${lines === 1 ? "" : "s"}`;
  }
}
