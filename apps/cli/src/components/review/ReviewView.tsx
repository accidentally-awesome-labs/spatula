import React, { useCallback } from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../../store/index.js';
import type { SpatulaApiClient } from '../../api/client.js';
import { useJobPolling } from '../../hooks/useJobPolling.js';
import { useKeyboard } from '../../hooks/useKeyboard.js';
import { KeyboardHints } from '../shared/KeyboardHints.js';
import { ActionCard } from './ActionCard.js';
import { DiffPreview } from './DiffPreview.js';

export interface ReviewViewProps {
  store: CliStore;
  apiClient: SpatulaApiClient;
}

const reviewHints = [
  { key: 'Y', description: 'Approve' },
  { key: 'N', description: 'Reject' },
  { key: '\u2191/\u2193', description: 'Navigate' },
  { key: 'A', description: 'Approve all' },
];

export function ReviewView({ store, apiClient }: ReviewViewProps): React.ReactElement {
  const activeJobId = useStore(store, (s) => s.activeJobId);
  const pendingActions = useStore(store, (s) => s.pendingActions);
  const reviewIndex = useStore(store, (s) => s.reviewIndex);

  useJobPolling(store, apiClient, activeJobId ?? '', 5000);

  const currentAction = pendingActions[reviewIndex] ?? null;

  const approve = useCallback(async () => {
    if (!activeJobId || !currentAction) return;
    const actionId = String((currentAction as Record<string, unknown>).id);
    await apiClient.approveAction(activeJobId, actionId);
    store.getState().removeAction(actionId);
    const remaining = store.getState().pendingActions.length;
    if (reviewIndex >= remaining && remaining > 0) {
      store.getState().setReviewIndex(remaining - 1);
    }
  }, [activeJobId, currentAction, apiClient, store, reviewIndex]);

  const reject = useCallback(async () => {
    if (!activeJobId || !currentAction) return;
    const actionId = String((currentAction as Record<string, unknown>).id);
    await apiClient.rejectAction(activeJobId, actionId);
    store.getState().removeAction(actionId);
    const remaining = store.getState().pendingActions.length;
    if (reviewIndex >= remaining && remaining > 0) {
      store.getState().setReviewIndex(remaining - 1);
    }
  }, [activeJobId, currentAction, apiClient, store, reviewIndex]);

  const approveAll = useCallback(async () => {
    if (!activeJobId) return;
    await apiClient.approveAllActions(activeJobId);
    store.getState().setPendingActions([]);
    store.getState().setReviewIndex(0);
  }, [activeJobId, apiClient, store]);

  useKeyboard({
    y: approve,
    Y: approve,
    n: reject,
    N: reject,
    a: approveAll,
    A: approveAll,
    upArrow: () => {
      store.getState().setReviewIndex(reviewIndex - 1);
    },
    downArrow: () => {
      const maxIndex = Math.max(0, pendingActions.length - 1);
      store.getState().setReviewIndex(Math.min(reviewIndex + 1, maxIndex));
    },
  });

  if (!activeJobId) {
    return <Text dimColor>No active job. Start a job first.</Text>;
  }

  if (pendingActions.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text color="green" bold>No pending actions to review.</Text>
        <Text dimColor>New actions will appear here as the crawl progresses.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <ActionCard
        action={currentAction as Record<string, unknown>}
        index={reviewIndex}
        total={pendingActions.length}
      />
      <DiffPreview action={currentAction as Record<string, unknown>} />
      <Box marginTop={1}>
        <KeyboardHints hints={reviewHints} />
      </Box>
    </Box>
  );
}
