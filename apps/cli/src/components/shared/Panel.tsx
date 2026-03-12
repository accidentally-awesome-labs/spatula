import React from 'react';
import { Box, Text } from 'ink';

export interface PanelProps {
  title?: string;
  children: React.ReactNode;
  borderColor?: string;
  width?: number | string;
}

export function Panel({
  title,
  children,
  borderColor = 'cyan',
  width,
}: PanelProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      width={width as number | undefined}
    >
      {title && (
        <Text bold color={borderColor}>
          {title}
        </Text>
      )}
      {typeof children === 'string' ? <Text>{children}</Text> : children}
    </Box>
  );
}
