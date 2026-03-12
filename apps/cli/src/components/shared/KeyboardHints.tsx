import React from 'react';
import { Box, Text } from 'ink';

export interface KeyHint {
  key: string;
  description: string;
}

export interface KeyboardHintsProps {
  hints: KeyHint[];
}

export function KeyboardHints({
  hints,
}: KeyboardHintsProps): React.ReactElement {
  return (
    <Box gap={2}>
      {hints.map((hint) => (
        <Box key={hint.key} gap={1}>
          <Text bold color="yellow">
            {hint.key}
          </Text>
          <Text dimColor>{hint.description}</Text>
        </Box>
      ))}
    </Box>
  );
}
