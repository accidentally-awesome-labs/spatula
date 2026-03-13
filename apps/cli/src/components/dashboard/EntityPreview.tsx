import React from 'react';
import { Box, Text } from 'ink';
import { Panel } from '../shared/Panel.js';

export interface EntityPreviewProps {
  entities: Record<string, unknown>[];
  totalCount?: number;
}

export function EntityPreview({ entities, totalCount }: EntityPreviewProps): React.ReactElement {
  if (entities.length === 0) {
    return (
      <Panel title="Entities">
        <Text dimColor>No entities yet</Text>
      </Panel>
    );
  }

  const countLabel = totalCount !== undefined
    ? `Entities (${entities.length} of ${totalCount})`
    : `Entities (${entities.length})`;

  return (
    <Panel title={countLabel}>
      <Box flexDirection="column">
        {entities.map((entity, i) => {
          const mergedData = (entity.mergedData ?? {}) as Record<string, unknown>;
          const name = String(mergedData.name ?? mergedData.title ?? `Entity ${i + 1}`);
          const categories = (entity.categories ?? []) as string[];
          const fieldCount = Object.keys(mergedData).length;
          return (
            <Box key={i} gap={1}>
              <Text bold>{name}</Text>
              {categories.length > 0 && (
                <Text dimColor>[{categories.join(', ')}]</Text>
              )}
              <Text dimColor>({fieldCount} fields)</Text>
            </Box>
          );
        })}
      </Box>
    </Panel>
  );
}
