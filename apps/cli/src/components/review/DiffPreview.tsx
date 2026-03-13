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
        const name = String(payload.name ?? 'unknown');
        const fieldType = String(payload.fieldType ?? payload.type ?? 'string');
        return (
          <Box flexDirection="column">
            <Text color="green">{'+ '}{name}: {fieldType}</Text>
          </Box>
        );
      }
      case 'merge_fields': {
        const aliases = (payload.aliases ?? payload.sources ?? []) as string[];
        const canonical = String(payload.canonical ?? payload.target ?? 'unknown');
        return (
          <Box flexDirection="column">
            {aliases.map((alias, i) => (
              <Text key={i} color="red">{'- '}{alias}</Text>
            ))}
            <Text color="green">{'+ '}{canonical} (merged)</Text>
          </Box>
        );
      }
      case 'remove_field': {
        const name = String(payload.name ?? payload.field ?? 'unknown');
        const reason = payload.reason ? String(payload.reason) : null;
        return (
          <Box flexDirection="column">
            <Text color="red">{'- '}{name}</Text>
            {reason && <Text dimColor>{'  reason: '}{reason}</Text>}
          </Box>
        );
      }
      case 'modify_field': {
        const name = String(payload.name ?? payload.field ?? 'unknown');
        const changes = (payload.changes ?? {}) as Record<string, unknown>;
        const changeEntries = Object.entries(changes);
        return (
          <Box flexDirection="column">
            <Text color="yellow">{'~ '}{name}</Text>
            {changeEntries.map(([key, value], i) => (
              <Text key={i} dimColor>{'  '}{key}: {String(value)}</Text>
            ))}
          </Box>
        );
      }
      case 'rename_field': {
        const oldName = String(payload.oldName ?? payload.from ?? 'unknown');
        const newName = String(payload.newName ?? payload.to ?? 'unknown');
        return (
          <Box flexDirection="column">
            <Text color="red">{'- '}{oldName}</Text>
            <Text color="green">{'+ '}{newName}</Text>
          </Box>
        );
      }
      case 'resolve_conflict': {
        const sources = (payload.sources ?? payload.values ?? []) as Array<Record<string, unknown>>;
        const resolvedValue = payload.resolvedValue ?? payload.resolved ?? 'unknown';
        return (
          <Box flexDirection="column">
            {sources.map((src, i) => (
              <Text key={i} dimColor>
                {'  '}{String(src.source ?? src.label ?? `source${i + 1}`)}: {String(src.value ?? src)}
              </Text>
            ))}
            <Text color="cyan">{'  -> '}{String(resolvedValue)}</Text>
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
                {'  '}{key}: {JSON.stringify(payload[key])}
              </Text>
            ))}
          </Box>
        );
      }
    }
  };

  return (
    <Panel title="Diff Preview" borderColor="white">
      {renderDiff()}
    </Panel>
  );
}
