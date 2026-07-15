import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import { createCliStore } from '../../store/index.js';
import type { CliStore } from '../../store/index.js';
import type { DataSource } from '@accidentally-awesome-labs/spatula-core';
import { useJobPolling } from '../../hooks/useJobPolling.js';
import { useKeyboard } from '../../hooks/useKeyboard.js';
import { ProgressPanel } from './ProgressPanel.js';
import { SchemaPanel } from './SchemaPanel.js';
import { EntityPreview } from './EntityPreview.js';
import { KeyboardHints } from '../shared/index.js';
import type { KeyHint } from '../shared/index.js';

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

/**
 * Create a CLI store pre-configured for a local pipeline run.
 * Sets `activeJobId` to the given projectId so that useJobPolling
 * can start fetching data immediately.
 */
export function buildRunDashboardStore(projectId: string): CliStore {
  const store = createCliStore(projectId);
  store.getState().setActiveJobId(projectId);
  return store;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface RunDashboardProps {
  store: CliStore;
  dataSource: DataSource;
  projectName: string;
  onDismiss: () => void;
}

const POLL_INTERVAL = 2000;

const HINTS: KeyHint[] = [
  { key: '[D]', description: 'Close dashboard' },
  { key: '[Esc]', description: 'Close dashboard' },
  { key: '[Ctrl+C]', description: 'Stop pipeline' },
];

export function RunDashboard({
  store,
  dataSource,
  projectName,
  onDismiss,
}: RunDashboardProps): React.ReactElement {
  const activeJobId = useStore(store, (s) => s.activeJobId);
  const jobData = useStore(store, (s) => s.jobData);
  const schemaData = useStore(store, (s) => s.schemaData);
  const entityPreviews = useStore(store, (s) => s.entityPreviews);

  useJobPolling(store, dataSource, activeJobId ?? '', POLL_INTERVAL);

  useKeyboard({
    d: onDismiss,
    D: onDismiss,
    escape: onDismiss,
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Dashboard — {projectName}
        </Text>
      </Box>

      <Box flexDirection="column" gap={1}>
        <ProgressPanel job={jobData ?? {}} />
        <Box>
          <Box flexDirection="column" flexGrow={1}>
            <SchemaPanel schema={schemaData} />
          </Box>
          <Box flexDirection="column" width={40}>
            <EntityPreview entities={entityPreviews} />
          </Box>
        </Box>
        {jobData && Number(jobData.errors ?? jobData.errorCount ?? 0) > 0 && (
          <Box>
            <Text color="red" bold>
              Errors: {String(jobData.errors ?? jobData.errorCount ?? 0)}
            </Text>
            {jobData.lastError ? (
              <Text color="red" dimColor>
                {' '}
                — {String(jobData.lastError)}
              </Text>
            ) : null}
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <KeyboardHints hints={HINTS} />
      </Box>
    </Box>
  );
}
