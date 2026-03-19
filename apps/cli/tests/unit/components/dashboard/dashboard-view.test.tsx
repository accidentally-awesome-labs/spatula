import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { createCliStore } from '../../../../src/store/index.js';
import type { CliStore } from '../../../../src/store/index.js';
import type { SpatulaApiClient } from '../../../../src/api/client.js';
import { DashboardView } from '../../../../src/components/dashboard/DashboardView.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../../src/hooks/useJobPolling.js', () => ({
  useJobPolling: vi.fn().mockReturnValue({ isPolling: false, lastError: null }),
}));

vi.mock('../../../../src/hooks/useWebSocket.js', () => ({
  useWebSocket: vi.fn().mockReturnValue({ connected: false, error: null }),
}));

vi.mock('../../../../src/hooks/useKeyboard.js', () => ({
  useKeyboard: vi.fn(),
}));

vi.mock('ink-spinner', () => ({
  default: () => React.createElement('ink-text', null, '*'),
}));

function createMockApiClient(): SpatulaApiClient {
  return {
    getJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'running', stats: {} }),
    listActions: vi.fn().mockResolvedValue([]),
    getSchema: vi.fn().mockResolvedValue(null),
    listEntities: vi.fn().mockResolvedValue([]),
    pauseJob: vi.fn().mockResolvedValue({}),
    resumeJob: vi.fn().mockResolvedValue({}),
    cancelJob: vi.fn().mockResolvedValue({}),
  } as unknown as SpatulaApiClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardView', () => {
  let store: CliStore;
  let apiClient: SpatulaApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createCliStore('test-tenant');
    apiClient = createMockApiClient();
  });

  it('renders all four panels when job data is present', () => {
    const state = store.getState();
    state.setActiveJobId('job-12345678-abcd');
    state.setJobData({
      id: 'job-12345678-abcd',
      name: 'Test Crawl Job',
      status: 'running',
      stats: {
        pagesFound: 50,
        pagesCrawled: 30,
        pagesExtracted: 20,
        pagesReconciled: 10,
        actionsPending: 3,
        actionsApplied: 7,
      },
    });
    state.setSchemaData({
      mode: 'discovery',
      version: 1,
      definition: { fields: [], categories: [] },
    });
    state.setPendingActions([]);
    state.setRecentActions([]);
    state.setEntityPreviews([]);

    const { lastFrame } = render(
      <DashboardView store={store} apiClient={apiClient} />,
    );
    const frame = lastFrame()!;

    // All four panel titles should be present
    expect(frame).toContain('Progress');
    expect(frame).toContain('Schema');
    expect(frame).toContain('Activity');
    expect(frame).toContain('Entities');
  });

  it('shows job name in header area', () => {
    const state = store.getState();
    state.setActiveJobId('job-abcdef12-3456');
    state.setJobData({
      id: 'job-abcdef12-3456',
      name: 'My Awesome Crawl',
      status: 'running',
      stats: {},
    });

    const { lastFrame } = render(
      <DashboardView store={store} apiClient={apiClient} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('My Awesome Crawl');
    expect(frame).toContain('job-abcd');
  });

  it('shows loading spinner when no job data yet', () => {
    const state = store.getState();
    state.setActiveJobId('job-loading-test');
    // Do NOT set jobData — it remains null

    const { lastFrame } = render(
      <DashboardView store={store} apiClient={apiClient} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('Loading job data...');
  });

  it('shows no-active-job message when activeJobId is null', () => {
    // Do not set activeJobId — remains null

    const { lastFrame } = render(
      <DashboardView store={store} apiClient={apiClient} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('No active job');
  });

  it('shows error when useJobPolling reports an error', async () => {
    const { useJobPolling } = await import('../../../../src/hooks/useJobPolling.js');
    vi.mocked(useJobPolling).mockReturnValue({
      isPolling: false,
      lastError: 'Connection refused',
    });

    const state = store.getState();
    state.setActiveJobId('job-error-test1');
    state.setJobData({
      id: 'job-error-test1',
      name: 'Error Job',
      status: 'running',
      stats: {},
    });

    const { lastFrame } = render(
      <DashboardView store={store} apiClient={apiClient} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('Error:');
    expect(frame).toContain('Connection refused');
  });

  it('displays default job name when name is missing', () => {
    const state = store.getState();
    state.setActiveJobId('job-no-name-12');
    state.setJobData({
      id: 'job-no-name-12',
      status: 'running',
      stats: {},
    });

    const { lastFrame } = render(
      <DashboardView store={store} apiClient={apiClient} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('Untitled Job');
  });
});
