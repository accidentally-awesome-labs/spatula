/**
 * `spatula review` — standalone TUI for reviewing pending schema actions.
 *
 * Opens the local project database, checks for pending actions, then renders
 * the ReviewView component in an Ink app with quit (q) and skip (s) keybindings.
 * On exit, prints a summary of how many actions were processed.
 */

import React, { useCallback } from 'react';
import { render, Box } from 'ink';
import { useStore } from 'zustand';
import { openLocalProject } from '../local-project.js';
import { createCliStore } from '../store/index.js';
import type { CliStore } from '../store/index.js';
import type { DataSource } from '@spatula/core';
import { ReviewView } from '../components/review/ReviewView.js';
import { useKeyboard } from '../hooks/useKeyboard.js';
import { Header, KeyboardHints } from '../components/shared/index.js';
import type { KeyHint } from '../components/shared/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REVIEW_HINTS: KeyHint[] = [
  { key: 'Y/N', description: 'Approve/Reject' },
  { key: '\u2191/\u2193', description: 'Navigate' },
  { key: 'A', description: 'Approve all' },
  { key: 'S', description: 'Skip' },
  { key: 'Q', description: 'Quit' },
];

// ---------------------------------------------------------------------------
// Exported helpers (for testability)
// ---------------------------------------------------------------------------

/**
 * Build a CliStore pre-configured for review mode.
 */
export function buildReviewStore(projectId: string): CliStore {
  const store = createCliStore(projectId);
  store.getState().setActiveJobId(projectId);
  store.getState().setMode('review');
  return store;
}

/**
 * Format the exit summary line.
 */
export function formatReviewSummary(processed: number, remaining: number): string {
  return `Reviewed ${processed} action(s), ${remaining} remaining.`;
}

// ---------------------------------------------------------------------------
// Wrapper component
// ---------------------------------------------------------------------------

interface ReviewAppProps {
  store: CliStore;
  backend: DataSource;
  onExit: () => void;
}

function ReviewApp({ store, backend, onExit }: ReviewAppProps): React.ReactElement {
  const pendingActions = useStore(store, (s) => s.pendingActions);

  const handleSkip = useCallback(() => {
    const idx = store.getState().reviewIndex;
    const max = store.getState().pendingActions.length - 1;
    if (idx < max) {
      store.getState().setReviewIndex(idx + 1);
    }
  }, [store]);

  useKeyboard({
    q: onExit,
    Q: onExit,
    s: handleSkip,
    S: handleSkip,
  });

  return (
    <Box flexDirection="column">
      <Header mode="review" />
      <ReviewView store={store} backend={backend} />
      {pendingActions.length > 0 && <KeyboardHints hints={REVIEW_HINTS} />}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runReviewCommand(): Promise<void> {
  const project = await openLocalProject(process.cwd());

  try {
    // Check for pending actions before rendering
    const actions = await project.dataSource.getActions('pending_review');
    const initialCount = actions.length;

    if (initialCount === 0) {
      console.log('No pending actions to review.');
      return;
    }

    console.log(`${initialCount} pending action(s) to review.`);

    // Build the store
    const store = buildReviewStore(project.projectId);
    const validActions = actions.filter(
      (a): a is Record<string, unknown> & { id: string; type: string } =>
        typeof a === 'object' &&
        a !== null &&
        typeof (a as any).id === 'string' &&
        typeof (a as any).type === 'string',
    );
    store.getState().setPendingActions(validActions);

    // Render the Ink app
    const { unmount, waitUntilExit } = render(
      <ReviewApp store={store} backend={project.dataSource} onExit={() => unmount()} />,
    );

    await waitUntilExit();

    // Print summary
    const remaining = store.getState().pendingActions.length;
    const processed = initialCount - remaining;
    console.log(formatReviewSummary(processed, remaining));
  } finally {
    project.close();
  }
}
