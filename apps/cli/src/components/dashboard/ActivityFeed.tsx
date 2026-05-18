import React from 'react';
import { Box, Text } from 'ink';
import { Panel } from '../shared/Panel.js';

export interface ActivityFeedProps {
  actions: Record<string, unknown>[];
}

const MAX_ITEMS = 8;

function statusIndicator(status: string): { symbol: string; color: string } {
  switch (status) {
    case 'applied':
      return { symbol: '✓', color: 'green' };
    case 'approved':
      return { symbol: '✔', color: 'green' };
    case 'pending_review':
      return { symbol: '○', color: 'yellow' };
    case 'rejected':
      return { symbol: '✗', color: 'red' };
    default:
      return { symbol: '·', color: 'white' };
  }
}

function formatActionLabel(action: Record<string, unknown>): string {
  const type = String(action.type ?? 'unknown');
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  if (payload.field && typeof payload.field === 'object') {
    const field = payload.field as Record<string, unknown>;
    return `${type}: ${String(field.name ?? '')}`;
  }
  if (payload.fieldName) return `${type}: ${String(payload.fieldName)}`;
  if (payload.canonicalName) return `${type}: ${String(payload.canonicalName)}`;
  return type;
}

export function ActivityFeed({ actions }: ActivityFeedProps): React.ReactElement {
  if (actions.length === 0) {
    return (
      <Panel title="Activity">
        <Text dimColor>No activity yet</Text>
      </Panel>
    );
  }

  const sorted = [...actions]
    .sort((a, b) => {
      const aTime = String(a.createdAt ?? '');
      const bTime = String(b.createdAt ?? '');
      return bTime.localeCompare(aTime);
    })
    .slice(0, MAX_ITEMS);

  return (
    <Panel title="Activity">
      <Box flexDirection="column">
        {sorted.map((action, i) => {
          const status = String(action.status ?? 'unknown');
          const { symbol, color } = statusIndicator(status);
          const label = formatActionLabel(action);
          return (
            <Box key={i} gap={1}>
              <Text color={color}>{symbol}</Text>
              <Text>{label}</Text>
            </Box>
          );
        })}
      </Box>
    </Panel>
  );
}
