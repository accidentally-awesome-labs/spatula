// apps/cli/src/components/explorer/DataTable.tsx
import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Entity } from '@spatula/shared';
import { TableRow } from './TableRow.js';

export interface DataTableProps {
  entities: Entity[];
  schemaFields: string[];
  selectedIndex: number;
  currentPage: number;
  totalPages: number;
  totalCount: number;
  columnOffset: number;
  pageSize: number;
  sourceFilter?: string;
}

const FIXED_COLS_WIDTH = 18;
const COLUMN_WIDTH = 20;

export function DataTable({
  entities,
  schemaFields,
  selectedIndex,
  currentPage,
  totalPages,
  totalCount,
  columnOffset,
  pageSize,
  sourceFilter,
}: DataTableProps) {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 120;

  const maxVisibleColumns = useMemo(() => {
    const available = termWidth - FIXED_COLS_WIDTH;
    return Math.max(1, Math.floor(available / (COLUMN_WIDTH + 2)));
  }, [termWidth]);

  if (entities.length === 0) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text dimColor>
          No entities found for this job. Entities are created during the reconciliation phase.
        </Text>
      </Box>
    );
  }

  const visibleFields = schemaFields.slice(columnOffset, columnOffset + maxVisibleColumns);
  const totalSchemaColumns = schemaFields.length;

  return (
    <Box flexDirection="column">
      {/* Header row */}
      <Box>
        <Text bold dimColor>
          {'   #  Score  Src  '}
        </Text>
        {visibleFields.map((field) => (
          <Text key={field} bold dimColor>
            {field.slice(0, COLUMN_WIDTH).padEnd(COLUMN_WIDTH + 2)}
          </Text>
        ))}
      </Box>

      {/* Data rows */}
      {entities.map((entity, idx) => (
        <TableRow
          key={entity.id}
          entity={entity}
          rowNumber={currentPage * pageSize + idx + 1}
          selected={idx === selectedIndex}
          schemaFields={schemaFields}
          columnOffset={columnOffset}
          maxVisibleColumns={maxVisibleColumns}
          columnWidth={COLUMN_WIDTH}
        />
      ))}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          {' '}Page {currentPage + 1} of {totalPages} ({totalCount} entities)
        </Text>
        {sourceFilter && (
          <Text dimColor>  [Source: {sourceFilter}]</Text>
        )}
        {totalSchemaColumns > maxVisibleColumns && (
          <Text dimColor>
            {'          '}Showing cols {columnOffset + 1}-{Math.min(columnOffset + maxVisibleColumns, totalSchemaColumns)} of {totalSchemaColumns}
            {columnOffset + maxVisibleColumns < totalSchemaColumns ? ' \u2192' : ''}
          </Text>
        )}
      </Box>
    </Box>
  );
}
