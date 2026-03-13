import React, { useCallback } from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../../store/index.js';
import type { SpatulaApiClient } from '../../api/client.js';
import { useJobPolling } from '../../hooks/useJobPolling.js';
import { useKeyboard } from '../../hooks/useKeyboard.js';
import { ActionCard } from './ActionCard.js';
import { DiffPreview } from './DiffPreview.js';

export interface ReviewViewProps {
  store: CliStore;
  apiClient: SpatulaApiClient;
}

export function ReviewView({ store, apiClient }: ReviewViewProps): React.ReactElement {
  const activeJobId = useStore(store, (s) => s.activeJobId);
  const pendingActions = useStore(store, (s) => s.pendingActions);
  const reviewIndex = useStore(store, (s) => s.reviewIndex);

  useJobPolling(store, apiClient, activeJobId ?? '', 5000);

  const currentAction = pendingActions[reviewIndex] ?? null;

  const approve = useCallback(() => {
    if (!activeJobId || !currentAction) return;
    const actionId = currentAction.id;
    void apiClient.approveAction(activeJobId, actionId)
      .then(() => {
        store.getState().removeAction(actionId);
        const remaining = store.getState().pendingActions.length;
        if (reviewIndex >= remaining && remaining > 0) {
          store.getState().setReviewIndex(remaining - 1);
        }
      })
      .catch((err) => {
        store.getState().setError(err instanceof Error ? err.message : 'Failed to approve action');
      });
  }, [activeJobId, currentAction, apiClient, store, reviewIndex]);

  const reject = useCallback(() => {
    if (!activeJobId || !currentAction) return;
    const actionId = currentAction.id;
    void apiClient.rejectAction(activeJobId, actionId)
      .then(() => {
        store.getState().removeAction(actionId);
        const remaining = store.getState().pendingActions.length;
        if (reviewIndex >= remaining && remaining > 0) {
          store.getState().setReviewIndex(remaining - 1);
        }
      })
      .catch((err) => {
        store.getState().setError(err instanceof Error ? err.message : 'Failed to reject action');
      });
  }, [activeJobId, currentAction, apiClient, store, reviewIndex]);

  const approveAll = useCallback(() => {
    if (!activeJobId) return;
    void apiClient.approveAllActions(activeJobId)
      .then(() => {
        store.getState().setPendingActions([]);
        store.getState().setReviewIndex(0);
      })
      .catch((err) => {
        store.getState().setError(err instanceof Error ? err.message : 'Failed to approve all actions');
      });
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
    </Box>
  );
}
