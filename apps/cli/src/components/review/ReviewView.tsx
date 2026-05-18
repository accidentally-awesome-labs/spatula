import React, { useCallback } from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../../store/index.js';
import type { SpatulaApiClient } from '../../api/client.js';
import type { DataSource } from '@spatula/core';
import { useJobPolling, isDataSource } from '../../hooks/useJobPolling.js';
import { useKeyboard } from '../../hooks/useKeyboard.js';
import { ActionCard } from './ActionCard.js';
import { DiffPreview } from './DiffPreview.js';

export interface ReviewViewProps {
  store: CliStore;
  backend: DataSource | SpatulaApiClient;
}

export function ReviewView({ store, backend }: ReviewViewProps): React.ReactElement {
  const activeJobId = useStore(store, (s) => s.activeJobId);
  const pendingActions = useStore(store, (s) => s.pendingActions);
  const reviewIndex = useStore(store, (s) => s.reviewIndex);

  useJobPolling(store, backend, activeJobId ?? '', 5000);

  const currentAction = pendingActions[reviewIndex] ?? null;

  const approve = useCallback(() => {
    if (!activeJobId || !currentAction) return;
    const actionId = currentAction.id;
    const promise = isDataSource(backend)
      ? backend.approveAction(actionId)
      : backend.approveAction(activeJobId, actionId);
    void promise
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
  }, [activeJobId, currentAction, backend, store, reviewIndex]);

  const reject = useCallback(() => {
    if (!activeJobId || !currentAction) return;
    const actionId = currentAction.id;
    const promise = isDataSource(backend)
      ? backend.rejectAction(actionId)
      : backend.rejectAction(activeJobId, actionId);
    void promise
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
  }, [activeJobId, currentAction, backend, store, reviewIndex]);

  const approveAll = useCallback(() => {
    if (!activeJobId) return;
    const promise = isDataSource(backend)
      ? Promise.all(pendingActions.map((a) => backend.approveAction(a.id)))
      : backend.approveAllActions(activeJobId);
    void promise
      .then(() => {
        store.getState().setPendingActions([]);
        store.getState().setReviewIndex(0);
      })
      .catch((err) => {
        store
          .getState()
          .setError(err instanceof Error ? err.message : 'Failed to approve all actions');
      });
  }, [activeJobId, backend, store, pendingActions]);

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
        <Text color="green" bold>
          No pending actions to review.
        </Text>
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
