import React from 'react';
import { Box, Text } from 'ink';
import { Panel } from '../shared/Panel.js';

export interface SchemaPanelProps {
  schema: Record<string, unknown> | null;
}

export function SchemaPanel({ schema }: SchemaPanelProps): React.ReactElement {
  if (!schema) {
    return (
      <Panel title="Schema">
        <Text dimColor>No schema data yet</Text>
      </Panel>
    );
  }

  const mode = String(schema.mode ?? 'unknown');
  const version = Number(schema.version ?? 0);
  const definition = (schema.definition ?? {}) as Record<string, unknown>;
  const fields = (definition.fields ?? []) as Array<Record<string, unknown>>;
  const categories = (definition.categories ?? []) as string[];

  return (
    <Panel title="Schema">
      <Box flexDirection="column" gap={0}>
        <Text>
          <Text bold>{'Mode: '}</Text>
          <Text color="yellow">{mode}</Text>
          <Text dimColor>{' | '}</Text>
          <Text>{fields.length} fields</Text>
          <Text dimColor>{' | '}</Text>
          <Text dimColor>v{version}</Text>
        </Text>

        {fields.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {fields.slice(0, 10).map((field, i) => (
              <Text key={i}>
                {'  '}{String(field.name)}{' '}
                <Text dimColor>({String(field.type)})</Text>
                {field.required === true ? <Text color="red">{' *'}</Text> : null}
              </Text>
            ))}
            {fields.length > 10 && (
              <Text dimColor>{'  ... and '}{fields.length - 10}{' more'}</Text>
            )}
          </Box>
        )}

        {categories.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{'Categories:'}</Text>
            {categories.map((cat, i) => (
              <Text key={i} color="cyan">{'  '}{cat}</Text>
            ))}
          </Box>
        )}
      </Box>
    </Panel>
  );
}
