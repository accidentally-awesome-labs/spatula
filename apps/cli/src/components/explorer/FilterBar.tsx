import React from 'react';
import { Box, Text, useInput } from 'ink';

export interface FilterBarProps {
  filterQuery: string;
  filterMode: 'local' | 'ai';
  matchCount: number;
  totalCount: number;
  focused: boolean;
  onQueryChange: (query: string) => void;
  onToggleMode: () => void;
  onSubmit: () => void;
  onBlur: () => void;
}

export function FilterBar({
  filterQuery,
  filterMode,
  matchCount,
  totalCount,
  focused,
  onQueryChange,
  onToggleMode,
  onBlur,
  onSubmit,
}: FilterBarProps) {
  useInput(
    (input, key) => {
      if (key.escape) {
        // Single Escape: clear filter query AND unfocus (per spec)
        if (filterQuery) {
          onQueryChange('');
        }
        onBlur();
        return;
      }
      if (key.return) {
        onSubmit();
        return;
      }
      if (key.backspace || key.delete) {
        onQueryChange(filterQuery.slice(0, -1));
        return;
      }
      // Toggle AI mode on shift+A
      if (input === 'A') {
        onToggleMode();
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        onQueryChange(filterQuery + input);
      }
    },
    { isActive: focused },
  );

  const modeLabel = filterMode === 'ai' ? 'AI' : 'Local';
  const hasFilter = filterQuery.length > 0;

  return (
    <Box>
      <Text dimColor> Filter: </Text>
      <Text color={focused ? 'cyan' : undefined}>
        {filterQuery || (focused ? '' : '(press F to filter)')}
      </Text>
      {focused && <Text color="cyan">_</Text>}
      <Text>{'  '}</Text>
      <Text dimColor>[{modeLabel}]</Text>
      <Text>{'  '}</Text>
      <Text dimColor>
        {hasFilter ? `${matchCount} of ${totalCount} matches` : `${totalCount} entities`}
      </Text>
    </Box>
  );
}
