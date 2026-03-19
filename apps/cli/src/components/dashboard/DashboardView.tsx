import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../../store/index.js';
import type { SpatulaApiClient } from '../../api/client.js';
import { useJobPolling } from '../../hooks/useJobPolling.js';
import { useWebSocket } from '../../hooks/useWebSocket.js';
import { useKeyboard } from '../../hooks/useKeyboard.js';
import { Spinner } from '../shared/Spinner.js';
import { ProgressPanel } from './ProgressPanel.js';
import { SchemaPanel } from './SchemaPanel.js';
import { ActivityFeed } from './ActivityFeed.js';
import { EntityPreview } from './EntityPreview.js';

export interface DashboardViewProps {
  store: CliStore;
  apiClient: SpatulaApiClient;
}

export function DashboardView({
  store,
  apiClient,
}: DashboardViewProps): React.ReactElement {
  const activeJobId = useStore(store, (s) => s.activeJobId);
  const jobData = useStore(store, (s) => s.jobData);
  const recentActions = useStore(store, (s) => s.recentActions);
  const schemaData = useStore(store, (s) => s.schemaData);
  const entityPreviews = useStore(store, (s) => s.entityPreviews);

  // Try WebSocket for real-time updates; use slower polling as supplement
  const { connected: wsConnected } = useWebSocket(
    store,
    apiClient.baseUrl,
    apiClient.tenantId,
    activeJobId ?? '',
  );

  // When WebSocket is connected, use slower 15s polling to keep full job data fresh.
  // When WebSocket is disconnected, poll at normal 3s rate.
  const { lastError } = useJobPolling(
    store,
    apiClient,
    activeJobId ?? '',
    wsConnected ? 15000 : 3000,
  );

  useKeyboard({
    ' ': () => {
      if (!activeJobId || !jobData) return;
      const status = String(jobData.status ?? '');
      if (status === 'running') {
        void apiClient.pauseJob(activeJobId);
      } else if (status === 'paused') {
        void apiClient.resumeJob(activeJobId);
      }
    },
    c: () => {
      if (!activeJobId) return;
      void apiClient.cancelJob(activeJobId);
    },
  });

  if (!activeJobId) {
    return <Text dimColor>No active job. Start a job in conversational mode first.</Text>;
  }

  if (!jobData) {
    return <Spinner label="Loading job data..." />;
  }

  const jobName = String(jobData.name ?? 'Untitled Job');

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box gap={1}>
        <Text bold>{jobName}</Text>
        <Text dimColor>({activeJobId.slice(0, 8)})</Text>
        {lastError && <Text color="red">{' Error: '}{lastError}</Text>}
      </Box>

      <Box flexGrow={1}>
        <Box flexDirection="column" flexGrow={1}>
          <ProgressPanel job={jobData} />
          <ActivityFeed actions={recentActions} />
        </Box>
        <Box flexDirection="column" width={40}>
          <SchemaPanel schema={schemaData} />
          <EntityPreview entities={entityPreviews} />
        </Box>
      </Box>
    </Box>
  );
}
