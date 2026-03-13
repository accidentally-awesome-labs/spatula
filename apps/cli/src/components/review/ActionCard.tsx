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
      const name = String(payload.name ?? 'unknown');
      const fieldType = String(payload.fieldType ?? payload.type ?? 'string');
      const required = payload.required === true;
      const description = payload.description ? String(payload.description) : null;
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold>{'Field: '}</Text>
            <Text color="green">{name}</Text>
            <Text dimColor>{' ('}{fieldType}{')'}</Text>
            {required && <Text color="red">{' required'}</Text>}
          </Text>
          {description && (
            <Text dimColor>{'  '}{description}</Text>
          )}
        </Box>
      );
    }
    case 'merge_fields': {
      const aliases = (payload.aliases ?? payload.sources ?? []) as string[];
      const canonical = String(payload.canonical ?? payload.target ?? 'unknown');
      return (
        <Box flexDirection="column">
          <Text>
            <Text dimColor>{'Merge: '}</Text>
            <Text>{aliases.join(', ')}</Text>
            <Text dimColor>{' -> '}</Text>
            <Text bold color="cyan">{canonical}</Text>
          </Text>
        </Box>
      );
    }
    case 'remove_field': {
      const name = String(payload.name ?? payload.field ?? 'unknown');
      const reason = payload.reason ? String(payload.reason) : null;
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold>{'Field: '}</Text>
            <Text color="red">{name}</Text>
          </Text>
          {reason && (
            <Text dimColor>{'  Reason: '}{reason}</Text>
          )}
        </Box>
      );
    }
    case 'modify_field': {
      const name = String(payload.name ?? payload.field ?? 'unknown');
      const changes = (payload.changes ?? {}) as Record<string, unknown>;
      const changeKeys = Object.keys(changes);
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold>{'Field: '}</Text>
            <Text color="yellow">{name}</Text>
          </Text>
          {changeKeys.length > 0 && (
            <Text dimColor>{'  Changes: '}{changeKeys.join(', ')}</Text>
          )}
        </Box>
      );
    }
    case 'resolve_conflict': {
      const name = String(payload.name ?? payload.field ?? 'unknown');
      const resolvedValue = payload.resolvedValue ?? payload.resolved ?? 'unknown';
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold>{'Field: '}</Text>
            <Text color="cyan">{name}</Text>
          </Text>
          <Text dimColor>{'  Resolved: '}{String(resolvedValue)}</Text>
        </Box>
      );
    }
    default: {
      const keys = Object.keys(payload);
      return (
        <Box flexDirection="column">
          {keys.length > 0 ? (
            <Text dimColor>{'Keys: '}{keys.join(', ')}</Text>
          ) : (
            <Text dimColor>{'No payload'}</Text>
          )}
        </Box>
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
    <Panel title={`Action ${index + 1}/${total}`} borderColor={risk.color}>
      <Box flexDirection="column" gap={0}>
        <Text>
          <Text bold>{'Type: '}</Text>
          <Text color="white">{type}</Text>
          <Text>{'  '}</Text>
          <Text bold>{'Confidence: '}</Text>
          <Text color={confidenceColor}>{confidencePercent}%</Text>
          <Text>{'  '}</Text>
          <Text bold>{'Risk: '}</Text>
          <Text color={risk.color}>{risk.label}</Text>
        </Text>

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
