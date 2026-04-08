import React from 'react';
import { Box, Text } from 'ink';
import InkSpinner from 'ink-spinner';

interface PullProgressProps {
  remoteName: string;
  batch: number;
  entityCount: number;
  elapsed: number;
}

export function PullProgress({ remoteName, batch, entityCount, elapsed }: PullProgressProps) {
  const elapsedStr = (elapsed / 1000).toFixed(1);
  return (
    <Box>
      <Text color="green">
        <InkSpinner type="dots" />
      </Text>
      <Text>
        {' '}Pulling from &apos;{remoteName}&apos;... Batch {batch} | {entityCount.toLocaleString()} entities | {elapsedStr}s
      </Text>
    </Box>
  );
}
