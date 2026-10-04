import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import type { ToolSpec } from "../tools/registry.js";
import type { PermissionDecision } from "../tools/executor.js";
import { DiffView } from "./diff-view.js";
import type { Theme } from "./theme.js";

interface Props {
  tool: ToolSpec;
  args: Record<string, unknown>;
  /** Permission key the executor will store in its session-allowed set
   *  if the operator picks "Allow for this session". Used to render an
   *  honest scope label — e.g. `bash:git` rather than the opaque
   *  "Allow for this session". */
  sessionKey: string;
  onDecide: (decision: PermissionDecision) => void;
  theme: Theme;
}

export function PermissionModal({ tool, args, sessionKey, onDecide, theme }: Props) {
  const render = tool.render?.(args);
  const sessionLabel = describeSessionScope(tool.name, sessionKey);
  const items = [
    { label: "Allow once", value: "allow" as const },
    { label: `Allow ${sessionLabel} for this session`, value: "allow_session" as const },
    { label: "Deny", value: "deny" as const },
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.permission} paddingX={1}>
      <Text color={theme.permission} bold>
        Permission requested
      </Text>
      <Text>
        tool: <Text color={theme.tool}>{tool.name}</Text>
      </Text>
      {render?.title ? <Text>action: {render.title}</Text> : null}
      {render?.diff ? (
        <Box marginTop={1} flexDirection="column">
          <DiffView {...render.diff} />
        </Box>
      ) : (
        <Text color={theme.info.color} dimColor={theme.info.dim}>args: {JSON.stringify(args)}</Text>
      )}
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={(item) => onDecide(item.value)} />
      </Box>
      <Text color={theme.info.color} dimColor={theme.info.dim}>
        {`Session permissions can be listed/revoked with /permissions.`}
      </Text>
    </Box>
  );
}

/** Turn the executor's internal permission key into an operator-readable
 *  scope label so "Allow for this session" doesn't feel like a black box.
 *
 *    `bash:git` → ``bash` (`git …`)``
 *    `write`    → ``any `write`` call``
 *
 *  Keep in sync with `ToolExecutor.permissionKey()`. If that helper
 *  grows a new shape, extend the cases here so the label stays honest.
 */
export function describeSessionScope(toolName: string, sessionKey: string): string {
  if (sessionKey.startsWith("bash:")) {
    const verb = sessionKey.slice("bash:".length);
    return `\`bash\` starting with \`${verb}\``;
  }
  return `any \`${toolName}\` call`;
}
