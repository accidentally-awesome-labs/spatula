import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../../store/index.js';
import type { SpatulaApiClient } from '../../api/client.js';
import type { DataSource } from '@spatula/core';
import { useJobPolling, isDataSource } from '../../hooks/useJobPolling.js';
import { useWebSocket } from '../../hooks/useWebSocket.js';
import { useKeyboard } from '../../hooks/useKeyboard.js';
import { Spinner } from '../shared/Spinner.js';
import { ProgressPanel } from './ProgressPanel.js';
import { SchemaPanel } from './SchemaPanel.js';
import { ActivityFeed } from './ActivityFeed.js';
import { EntityPreview } from './EntityPreview.js';

export interface DashboardViewProps {
  store: CliStore;
  backend: DataSource | SpatulaApiClient;
}

export function DashboardView({
  store,
  backend,
}: DashboardViewProps): React.ReactElement {
  const activeJobId = useStore(store, (s) => s.activeJobId);
  const jobData = useStore(store, (s) => s.jobData);
  const recentActions = useStore(store, (s) => s.recentActions);
  const schemaData = useStore(store, (s) => s.schemaData);
  const entityPreviews = useStore(store, (s) => s.entityPreviews);

  // Try WebSocket for real-time updates; use slower polling as supplement.
  // In local DataSource mode, WebSocket is disabled (empty baseUrl triggers early return).
  const wsBaseUrl = isDataSource(backend) ? '' : backend.baseUrl;
  const wsTenantId = isDataSource(backend) ? '' : backend.tenantId;
  const { connected: wsConnected } = useWebSocket(
    store,
    wsBaseUrl,
    wsTenantId,
    activeJobId ?? '',
  );

  // When WebSocket is connected, use slower 15s polling to keep full job data fresh.
  // When WebSocket is disconnected, poll at normal 3s rate.
  const { lastError } = useJobPolling(
    store,
    backend,
    activeJobId ?? '',
    wsConnected ? 15000 : 3000,
  );

  useKeyboard({
    ' ': () => {
      if (!activeJobId || !jobData || isDataSource(backend)) return;
      const status = String(jobData.status ?? '');
      if (status === 'running') {
        void backend.pauseJob(activeJobId);
      } else if (status === 'paused') {
        void backend.resumeJob(activeJobId);
      }
    },
    c: () => {
      if (!activeJobId || isDataSource(backend)) return;
      void backend.cancelJob(activeJobId);
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
