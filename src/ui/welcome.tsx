import React from "react";
import { Box, Text } from "ink";
import { Octavius } from "./octavius.js";
import type { Theme } from "./theme.js";

interface Props {
  theme: Theme;
}

const SUGGESTIONS = [
  "Explain this codebase",
  "Find and fix a bug",
  "Refactor a file",
];

export function Welcome({ theme }: Props) {
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} paddingX={2}>
      <Box>
        <Box marginRight={3}>
          <Octavius color={theme.accent} />
        </Box>
        <Box flexDirection="column">
          <Box>
            <Text bold color={theme.accent}>
              YOLO Code
            </Text>
            <Text color={theme.info.color}>
              {"  "}Ready when you are.
            </Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            {SUGGESTIONS.map((s, i) => (
              <Box key={i}>
                <Text color={theme.info.color}>{"› "}</Text>
                <Text color={theme.user}>{s}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.info.color}>
          Type a message or /help for commands · ctrl-c to interrupt · shift+tab to cycle modes
        </Text>
      </Box>
    </Box>
  );
}
