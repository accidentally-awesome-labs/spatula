// apps/cli/src/components/explorer/TableRow.tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { Entity } from '@spatula/shared';

export interface TableRowProps {
  entity: Entity;
  rowNumber: number;
  selected: boolean;
  schemaFields: string[];
  columnOffset: number;
  maxVisibleColumns: number;
  columnWidth: number;
}

function truncate(value: unknown, maxLen: number): string {
  const str = value === null || value === undefined ? '' : String(value);
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '\u2026' : str;
}

export function TableRow({
  entity,
  rowNumber,
  selected,
  schemaFields,
  columnOffset,
  maxVisibleColumns,
  columnWidth,
}: TableRowProps) {
  const visibleFields = schemaFields.slice(columnOffset, columnOffset + maxVisibleColumns);
  const prefix = selected ? '>' : ' ';

  return (
    <Box>
      <Text color={selected ? 'cyan' : undefined} bold={selected}>
        {prefix}
        {String(rowNumber).padStart(3)}
        {'  '}
        {(entity.qualityScore ?? 0).toFixed(2).padStart(5)}
        {'  '}
        {String(entity.sourceCount ?? 0).padStart(3)}
        {'  '}
      </Text>
      {visibleFields.map((field) => (
        <Text key={field} color={selected ? 'cyan' : undefined}>
          {truncate(entity.mergedData[field], columnWidth).padEnd(columnWidth + 2)}
        </Text>
      ))}
    </Box>
  );
}
