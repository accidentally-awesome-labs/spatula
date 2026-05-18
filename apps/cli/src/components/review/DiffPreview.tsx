import React from 'react';
import { Box, Text } from 'ink';
import { Panel } from '../shared/Panel.js';

export interface DiffPreviewProps {
  action: Record<string, unknown>;
}

export function DiffPreview({ action }: DiffPreviewProps): React.ReactElement {
  const type = String(action.type ?? 'unknown');
  const payload = (action.payload ?? {}) as Record<string, unknown>;

  const renderDiff = (): React.ReactElement => {
    switch (type) {
      case 'add_field': {
        const field = (payload.field ?? {}) as Record<string, unknown>;
        const description = field.description ? String(field.description) : null;
        return (
          <Box flexDirection="column">
            <Text color="green">
              {'+ '}
              {String(field.name)}: {String(field.type)}
            </Text>
            {description && (
              <Text dimColor>
                {'  '}
                {description}
              </Text>
            )}
          </Box>
        );
      }
      case 'merge_fields': {
        const canonical = String(payload.canonicalName ?? '');
        const aliases = (payload.aliasNames ?? []) as string[];
        return (
          <Box flexDirection="column">
            {aliases.map((alias, i) => (
              <Text key={i} color="red">
                {'- '}
                {alias}
              </Text>
            ))}
            <Text color="green">
              {'+ '}
              {canonical} (merged)
            </Text>
          </Box>
        );
      }
      case 'remove_field': {
        return (
          <Box flexDirection="column">
            <Text color="red">
              {'- '}
              {String(payload.fieldName)}
            </Text>
            <Text dimColor>
              {'  Reason: '}
              {String(payload.reason)}
            </Text>
          </Box>
        );
      }
      case 'modify_field': {
        const changes = (payload.changes ?? {}) as Record<string, unknown>;
        return (
          <Box flexDirection="column">
            <Text color="yellow">
              {'~ '}
              {String(payload.fieldName)}
            </Text>
            {Object.entries(changes).map(([key, value], i) => (
              <Text key={i}>
                {'  '}
                <Text dimColor>{key}: </Text>
                <Text color="green">{String(value)}</Text>
              </Text>
            ))}
          </Box>
        );
      }
      case 'rename_field': {
        return (
          <Box flexDirection="column">
            <Text color="red">
              {'- '}
              {String(payload.currentName)}
            </Text>
            <Text color="green">
              {'+ '}
              {String(payload.newName)}
            </Text>
          </Box>
        );
      }
      case 'resolve_conflict': {
        const allValues = (payload.allValues ?? []) as Array<Record<string, unknown>>;
        return (
          <Box flexDirection="column">
            <Text bold>{String(payload.fieldName)}</Text>
            {allValues.map((v, i) => (
              <Text key={i} dimColor>
                {'  '}
                {String(v.source)}: {String(v.value)}
              </Text>
            ))}
            <Text color="green">
              {'  → '}
              {String(payload.resolvedValue)} (from {String(payload.sourcePreferred)})
            </Text>
          </Box>
        );
      }
      default: {
        const keys = Object.keys(payload);
        if (keys.length === 0) {
          return <Text dimColor>{'No changes to preview'}</Text>;
        }
        return (
          <Box flexDirection="column">
            {keys.map((key, i) => (
              <Text key={i} dimColor>
                {'  '}
                {key}: {JSON.stringify(payload[key])}
              </Text>
            ))}
          </Box>
        );
      }
    }
  };

  return (
    <Panel title="Impact Preview" borderColor="white">
      {renderDiff()}
    </Panel>
  );
}
