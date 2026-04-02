import React, { useCallback } from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../store/index.js';
import type { SpatulaApiClient } from '../api/client.js';
import type { DataSource } from '@spatula/core';
import { Header, KeyboardHints } from './shared/index.js';
import { useKeyboard } from '../hooks/useKeyboard.js';
import { ConversationalView } from './conversational/ConversationalView.js';
import { DashboardView } from './dashboard/DashboardView.js';
import { ReviewView } from './review/ReviewView.js';
import { ExplorerView } from './explorer/index.js';
import type { KeyHint } from './shared/index.js';

export interface AppProps {
  store: CliStore;
  apiClient: SpatulaApiClient | null;
  backend?: DataSource | SpatulaApiClient | null;
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
    case 'explorer': return []; // ExplorerView manages its own hints
    default: return conversationalHints;
  }
}

export function App({
  store,
  apiClient,
  backend,
  onStartJob,
  onExit,
}: AppProps): React.ReactElement {
  const effectiveBackend = backend ?? apiClient;
  const mode = useStore(store, (s) => s.mode);
  const filterFocused = useStore(store, (s) => s.filterFocused);

  const switchToDashboard = useCallback(() => {
    store.getState().setMode('dashboard');
  }, [store]);

  const switchToReview = useCallback(() => {
    store.getState().setMode('review');
  }, [store]);

  const switchToConversational = useCallback(() => {
    store.getState().setMode('conversational');
  }, [store]);

  // Mode-switching keys are context-aware:
  // - Conversational: D→dashboard, R→review
  // - Dashboard: R→review, C→conversational (c is also "cancel" in DashboardView,
  //   but mode switching uses uppercase C while cancel uses lowercase c)
  // - Review: D→dashboard (approve/reject keys handled by ReviewView)
  const modeKeys: Record<string, Record<string, () => void>> = {
    conversational: {
      d: switchToDashboard,
      D: switchToDashboard,
      r: switchToReview,
      R: switchToReview,
    },
    dashboard: {
      r: switchToReview,
      R: switchToReview,
    },
    review: {
      d: switchToDashboard,
      D: switchToDashboard,
    },
    explorer: {
      d: switchToDashboard,
      D: switchToDashboard,
      r: switchToReview,
      R: switchToReview,
      c: switchToConversational,
      C: switchToConversational,
    },
  };

  useKeyboard(modeKeys[mode] ?? {}, !filterFocused);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Header mode={mode} />
      <Box flexGrow={1}>
        {mode === 'conversational' && (
          <ConversationalView store={store} onStartJob={onStartJob} />
        )}
        {mode === 'dashboard' && effectiveBackend && (
          <DashboardView store={store} backend={effectiveBackend} />
        )}
        {mode === 'review' && effectiveBackend && (
          <ReviewView store={store} backend={effectiveBackend} />
        )}
        {mode === 'explorer' && effectiveBackend && (
          <ExplorerView store={store} backend={effectiveBackend} />
        )}
        {(mode === 'dashboard' || mode === 'review' || mode === 'explorer') && !effectiveBackend && (
          <Box paddingX={2} paddingY={1}>
            <Text color="yellow">
              {mode.charAt(0).toUpperCase() + mode.slice(1)} mode requires a remote connection. Use `spatula run` for local crawling, or set SPATULA_TENANT_ID for remote mode.
            </Text>
          </Box>
        )}
      </Box>
      <KeyboardHints hints={hintsForMode(mode)} />
    </Box>
  );
}
