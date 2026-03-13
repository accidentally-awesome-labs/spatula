import React from 'react';
import { Box, Text } from 'ink';
import { Panel } from '../shared/Panel.js';

export interface ProgressPanelProps {
  job: Record<string, unknown>;
}

const BAR_WIDTH = 20;

function ProgressBar({
  label,
  current,
  total,
  color,
}: {
  label: string;
  current: number;
  total: number;
  color: string;
}): React.ReactElement {
  const ratio = total > 0 ? current / total : 0;
  const filled = Math.round(ratio * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const percent = Math.round(ratio * 100);

  return (
    <Box>
      <Box width={12}>
        <Text>{label}</Text>
      </Box>
      <Text color={color}>{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(empty)}</Text>
      <Text>{' '}{current}/{total} ({percent}%)</Text>
    </Box>
  );
}

export function ProgressPanel({ job }: ProgressPanelProps): React.ReactElement {
  const stats = (job.stats ?? {}) as Record<string, number>;
  const status = String(job.status ?? 'unknown');
  const pagesFound = stats.pagesFound ?? 0;
  const pagesCrawled = stats.pagesCrawled ?? 0;
  const pagesExtracted = stats.pagesExtracted ?? 0;
  const pagesReconciled = stats.pagesReconciled ?? 0;
  const actionsPending = stats.actionsPending ?? 0;
  const actionsApplied = stats.actionsApplied ?? 0;

  const statusColor =
    status === 'running' ? 'green' :
    status === 'paused' ? 'yellow' :
    status === 'completed' ? 'cyan' :
    status === 'failed' ? 'red' : 'white';

  return (
    <Panel title="Progress">
      <Box flexDirection="column" gap={0}>
        <Text>
          <Text bold>{'Status: '}</Text>
          <Text color={statusColor}>{status}</Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          <ProgressBar label="Crawled" current={pagesCrawled} total={pagesFound} color="green" />
          <ProgressBar label="Extracted" current={pagesExtracted} total={pagesFound} color="cyan" />
          <ProgressBar label="Reconciled" current={pagesReconciled} total={pagesFound} color="magenta" />
        </Box>
        <Box marginTop={1}>
          <Text>
            <Text bold>{'Actions: '}</Text>
            <Text color="yellow">{actionsPending} pending</Text>
            <Text>{' | '}</Text>
            <Text color="green">{actionsApplied} applied</Text>
          </Text>
        </Box>
      </Box>
    </Panel>
  );
}
