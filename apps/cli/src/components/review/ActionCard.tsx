import React from 'react';
import { Box, Text } from 'ink';
import { Panel } from '../shared/Panel.js';

export interface ActionCardProps {
  action: Record<string, unknown>;
  index: number;
  total: number;
}

function getRiskLevel(confidence: number): { label: string; color: string } {
  if (confidence >= 0.85) {
    return { label: 'LOW', color: 'green' };
  }
  if (confidence >= 0.6) {
    return { label: 'MEDIUM', color: 'yellow' };
  }
  return { label: 'HIGH', color: 'red' };
}

function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.85) {
    return 'green';
  }
  if (confidence >= 0.6) {
    return 'yellow';
  }
  return 'red';
}

function PayloadSummary({ action }: { action: Record<string, unknown> }): React.ReactElement {
  const type = String(action.type ?? '');
  const payload = (action.payload ?? {}) as Record<string, unknown>;

  switch (type) {
    case 'add_field': {
      const field = (payload.field ?? {}) as Record<string, unknown>;
      const description = field.description ? String(field.description) : null;
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold>{'Field: '}</Text>
            <Text color="green">{String(field.name)}</Text>
            <Text dimColor>
              {' ('}
              {String(field.type)}
              {')'}
            </Text>
            {field.required === true && <Text color="red">{' required'}</Text>}
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
          <Text>
            <Text bold>{'Merge: '}</Text>
            <Text>{aliases.join(', ')}</Text>
            <Text dimColor>{' → '}</Text>
            <Text color="green">{canonical}</Text>
          </Text>
        </Box>
      );
    }
    case 'remove_field': {
      return (
        <Text>
          <Text bold>{'Remove: '}</Text>
          <Text color="red">{String(payload.fieldName)}</Text>
          <Text dimColor>
            {' ('}
            {String(payload.reason)}
            {')'}
          </Text>
        </Text>
      );
    }
    case 'modify_field': {
      const changes = (payload.changes ?? {}) as Record<string, unknown>;
      const changeList = Object.entries(changes)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ');
      return (
        <Text>
          <Text bold>{'Modify: '}</Text>
          <Text>{String(payload.fieldName)}</Text>
          <Text dimColor>
            {' ('}
            {changeList}
            {')'}
          </Text>
        </Text>
      );
    }
    case 'resolve_conflict': {
      return (
        <Text>
          <Text bold>{'Resolve: '}</Text>
          <Text>{String(payload.fieldName)}</Text>
          <Text dimColor>{' → '}</Text>
          <Text>{String(payload.resolvedValue)}</Text>
        </Text>
      );
    }
    default: {
      const keys = Object.keys(payload).slice(0, 3);
      return (
        <Text dimColor>
          {type}
          {': '}
          {keys.join(', ')}
        </Text>
      );
    }
  }
}

export function ActionCard({ action, index, total }: ActionCardProps): React.ReactElement {
  const type = String(action.type ?? 'unknown');
  const confidence = Number(action.confidence ?? 0);
  const reasoning = action.reasoning ? String(action.reasoning) : null;
  const source = action.source ? String(action.source) : null;
  const risk = getRiskLevel(confidence);
  const confidenceColor = getConfidenceColor(confidence);
  const confidencePercent = Math.round(confidence * 100);

  return (
    <Panel title={type} borderColor={risk.color}>
      <Box flexDirection="column" gap={0}>
        <Box gap={2}>
          <Text dimColor>
            {index + 1} of {total}
          </Text>
          <Text>
            <Text bold>{'Confidence: '}</Text>
            <Text color={confidenceColor}>{confidencePercent}%</Text>
          </Text>
          <Text>
            <Text bold>{'Risk: '}</Text>
            <Text color={risk.color}>{risk.label}</Text>
          </Text>
        </Box>

        {reasoning && (
          <Text>
            <Text bold>{'Reasoning: '}</Text>
            <Text>{reasoning}</Text>
          </Text>
        )}

        {source && (
          <Text>
            <Text bold>{'Source: '}</Text>
            <Text dimColor>{source}</Text>
          </Text>
        )}

        <Box marginTop={1}>
          <PayloadSummary action={action} />
        </Box>
      </Box>
    </Panel>
  );
}
