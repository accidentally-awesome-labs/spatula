import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../store/index.js';
import type { SpatulaApiClient } from '../api/client.js';
import { Header, KeyboardHints } from './shared/index.js';
import { ConversationalView } from './conversational/ConversationalView.js';
import { DashboardView } from './dashboard/DashboardView.js';
import { ReviewView } from './review/ReviewView.js';
import type { KeyHint } from './shared/index.js';

export interface AppProps {
  store: CliStore;
  apiClient: SpatulaApiClient;
  onStartJob: (config: Record<string, unknown>) => void;
  onExit: () => void;
}

const conversationalHints: KeyHint[] = [
  { key: 'Enter', description: 'Send' },
  { key: 'D', description: 'Dashboard' },
  { key: 'R', description: 'Review' },
  { key: 'Ctrl+C', description: 'Quit' },
];

const dashboardHints: KeyHint[] = [
  { key: 'Space', description: 'Pause/Resume' },
  { key: 'C', description: 'Cancel job' },
  { key: 'R', description: 'Review' },
  { key: 'Ctrl+C', description: 'Quit' },
];

const reviewHints: KeyHint[] = [
  { key: 'Y/N', description: 'Approve/Reject' },
  { key: '↑/↓', description: 'Navigate' },
  { key: 'A', description: 'Approve all' },
  { key: 'D', description: 'Dashboard' },
  { key: 'Ctrl+C', description: 'Quit' },
];

function hintsForMode(mode: string): KeyHint[] {
  switch (mode) {
    case 'dashboard': return dashboardHints;
    case 'review': return reviewHints;
    default: return conversationalHints;
  }
}

export function App({
  store,
  apiClient,
  onStartJob,
  onExit: _onExit,
}: AppProps): React.ReactElement {
  const mode = useStore(store, (s) => s.mode);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Header mode={mode} />
      <Box flexGrow={1}>
        {mode === 'conversational' && (
          <ConversationalView store={store} onStartJob={onStartJob} />
        )}
        {mode === 'dashboard' && (
          <DashboardView store={store} apiClient={apiClient} />
        )}
        {mode === 'review' && (
          <ReviewView store={store} apiClient={apiClient} />
        )}
        {mode === 'explorer' && (
          <Text>Explorer mode — coming in Phase 9c</Text>
        )}
      </Box>
      <KeyboardHints hints={hintsForMode(mode)} />
    </Box>
  );
}
