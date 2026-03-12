import React from 'react';
import { Box, Text } from 'ink';

export interface HeaderProps {
  mode: 'conversational' | 'dashboard' | 'review' | 'explorer';
}

export function Header({ mode }: HeaderProps): React.ReactElement {
  return (
    <Box gap={1}>
      <Text bold color="magenta">
        Spatula
      </Text>
      <Text dimColor>|</Text>
      <Text color="cyan">{mode}</Text>
    </Box>
  );
}
