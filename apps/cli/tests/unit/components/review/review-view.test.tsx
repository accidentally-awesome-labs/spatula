import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ReviewView } from '../../../../src/components/review/ReviewView.js';
import { createCliStore } from '../../../../src/store/index.js';
import type { SpatulaApiClient } from '../../../../src/api/client.js';

const sampleActions = [
  {
    id: 'a1',
    type: 'add_field',
    confidence: 0.92,
    reasoning: 'Common field detected',
    source: 'schema_evolution',
    payload: { field: { name: 'brand', type: 'string', description: 'Brand name' } },
    status: 'pending_review',
  },
  {
    id: 'a2',
    type: 'merge_fields',
    confidence: 0.85,
    reasoning: 'Synonyms detected',
    source: 'schema_evolution',
    payload: { canonicalName: 'price', aliasNames: ['cost'] },
    status: 'pending_review',
  },
  {
    id: 'a3',
    type: 'remove_field',
    confidence: 0.7,
    reasoning: 'Too rare to be useful',
    source: 'schema_evolution',
    payload: { fieldName: 'old_field', reason: 'too_rare' },
    status: 'pending_review',
  },
];

/**
 * Create a mock API client.
 * `listActions` returns `actions` so that useJobPolling keeps the store in sync.
 */
function createMockApiClient(actions: Record<string, unknown>[] = []): SpatulaApiClient {
  return {
    getJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'running', stats: {} }),
    listActions: vi.fn().mockResolvedValue(actions),
    getSchema: vi.fn().mockResolvedValue(null),
    listEntities: vi.fn().mockResolvedValue([]),
    approveAction: vi.fn().mockResolvedValue({}),
    rejectAction: vi.fn().mockResolvedValue({}),
    approveAllActions: vi.fn().mockResolvedValue([]),
  } as unknown as SpatulaApiClient;
}

/** Wait for React effects to settle. */
const waitForEffects = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('ReviewView', () => {
  it('renders the first action by default', async () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    store.getState().setPendingActions(sampleActions);
    const apiClient = createMockApiClient(sampleActions);

    const { lastFrame } = render(<ReviewView store={store} backend={apiClient} />);
    await waitForEffects();

    const frame = lastFrame()!;
    expect(frame).toContain('add_field');
    expect(frame).toContain('1 of 3');
    expect(frame).toContain('brand');
  });

  it('shows empty state when no pending actions', async () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    store.getState().setPendingActions([]);
    const apiClient = createMockApiClient([]);

    const { lastFrame } = render(<ReviewView store={store} backend={apiClient} />);
    await waitForEffects();

    const frame = lastFrame()!;
    expect(frame).toContain('No pending actions');
  });

  it('navigates to next action on down arrow', async () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    store.getState().setPendingActions(sampleActions);
    const apiClient = createMockApiClient(sampleActions);

    const { stdin, lastFrame } = render(<ReviewView store={store} backend={apiClient} />);
    await waitForEffects();

    stdin.write('\u001B[B'); // down arrow
    await waitForEffects();

    const frame = lastFrame()!;
    expect(frame).toContain('2 of 3');
  });

  it('navigates back on up arrow', async () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    store.getState().setPendingActions(sampleActions);
    store.getState().setReviewIndex(1);
    const apiClient = createMockApiClient(sampleActions);

    const { stdin, lastFrame } = render(<ReviewView store={store} backend={apiClient} />);
    await waitForEffects();

    stdin.write('\u001B[A'); // up arrow
    await waitForEffects();

    const frame = lastFrame()!;
    expect(frame).toContain('1 of 3');
  });

  it('does not render its own keyboard hints (App provides them)', async () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    store.getState().setPendingActions(sampleActions);
    const apiClient = createMockApiClient(sampleActions);

    const { lastFrame } = render(<ReviewView store={store} backend={apiClient} />);
    await waitForEffects();

    const frame = lastFrame()!;
    // ReviewView should show action content, not keyboard hints
    expect(frame).toContain('add_field');
    // Hints like "Approve" should NOT be rendered inside ReviewView
    expect(frame).not.toContain('Approve');
  });

  it('shows DiffPreview', async () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    store.getState().setPendingActions(sampleActions);
    const apiClient = createMockApiClient(sampleActions);

    const { lastFrame } = render(<ReviewView store={store} backend={apiClient} />);
    await waitForEffects();

    const frame = lastFrame()!;
    expect(frame).toContain('Impact Preview');
  });
});
