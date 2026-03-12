import React from 'react';
import { Box, Text } from 'ink';
import InkSpinner from 'ink-spinner';

export interface SpinnerProps {
  label?: string;
}

export function Spinner({
  label = 'Loading...',
}: SpinnerProps): React.ReactElement {
  return (
    <Box gap={1}>
      <Text color="cyan">
        <InkSpinner type="dots" />
      </Text>
      <Text>{label}</Text>
    </Box>
  );
}
