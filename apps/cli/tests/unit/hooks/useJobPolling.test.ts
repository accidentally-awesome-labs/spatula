import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { createCliStore } from '../../../src/store/index.js';
import { useJobPolling } from '../../../src/hooks/useJobPolling.js';
import type { SpatulaApiClient } from '../../../src/api/client.js';

function createMockApiClient(overrides: Partial<SpatulaApiClient> = {}): SpatulaApiClient {
  return {
    getJob: vi.fn().mockResolvedValue({ id: 'job-1', name: 'Test Job', status: 'running' }),
    listActions: vi.fn().mockResolvedValue([
      { id: 'a1', type: 'add_field', status: 'pending_review', confidence: 0.9 },
    ]),
    getSchema: vi.fn().mockResolvedValue({ mode: 'hybrid', version: 2 }),
    listEntities: vi.fn().mockResolvedValue([{ id: 'e1', mergedData: { name: 'Test' } }]),
    ...overrides,
  } as unknown as SpatulaApiClient;
}

function TestComponent({
  store,
  apiClient,
  jobId,
  interval,
}: {
  store: ReturnType<typeof createCliStore>;
  apiClient: SpatulaApiClient;
  jobId: string;
  interval?: number;
}) {
  const { isPolling, lastError } = useJobPolling(store, apiClient, jobId, interval);
  return React.createElement(
    Text,
    null,
    `${isPolling ? 'polling' : 'idle'}|${lastError ?? 'none'}`,
  );
}

/** Let React effects and microtasks (promise callbacks) settle. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 50));

describe('useJobPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches job data immediately on mount', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    render(
      React.createElement(TestComponent, { store, apiClient, jobId: 'job-1' }),
    );

    // Flush microtasks (promise resolution) and effects
    await vi.advanceTimersByTimeAsync(100);

    expect(apiClient.getJob).toHaveBeenCalledWith('job-1');
    expect(store.getState().jobData).toEqual({ id: 'job-1', name: 'Test Job', status: 'running' });
  });

  it('fetches pending actions filtered by status', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    render(
      React.createElement(TestComponent, { store, apiClient, jobId: 'job-1' }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(apiClient.listActions).toHaveBeenCalledWith('job-1', { status: 'pending_review' });
    expect(store.getState().pendingActions).toHaveLength(1);
  });

  it('stores schema data in the store', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    render(
      React.createElement(TestComponent, { store, apiClient, jobId: 'job-1' }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(apiClient.getSchema).toHaveBeenCalledWith('job-1');
    expect(store.getState().schemaData).toEqual({ mode: 'hybrid', version: 2 });
  });

  it('stores entity previews in the store', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    render(
      React.createElement(TestComponent, { store, apiClient, jobId: 'job-1' }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(apiClient.listEntities).toHaveBeenCalledWith('job-1', { limit: 5 });
    expect(store.getState().entityPreviews).toEqual([{ id: 'e1', mergedData: { name: 'Test' } }]);
  });

  it('polls at the configured interval', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    render(
      React.createElement(TestComponent, {
        store,
        apiClient,
        jobId: 'job-1',
        interval: 3000,
      }),
    );

    // Let the initial fetch complete
    await vi.advanceTimersByTimeAsync(100);
    expect(apiClient.getJob).toHaveBeenCalledTimes(1);

    // Advance past the polling interval
    await vi.advanceTimersByTimeAsync(3000);
    expect(apiClient.getJob).toHaveBeenCalledTimes(2);
  });

  it('handles API errors without crashing', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient({
      getJob: vi.fn().mockRejectedValue(new Error('Network failure')),
    });

    const { lastFrame } = render(
      React.createElement(TestComponent, { store, apiClient, jobId: 'job-1' }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(lastFrame()!).toContain('Network failure');
    // Store should not have been updated since the whole Promise.all rejected
    expect(store.getState().jobData).toBeNull();
  });

  it('gracefully handles schema fetch failure', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient({
      getSchema: vi.fn().mockRejectedValue(new Error('Schema not found')),
    });

    render(
      React.createElement(TestComponent, { store, apiClient, jobId: 'job-1' }),
    );

    await vi.advanceTimersByTimeAsync(100);

    // getSchema failure is caught individually, so other data should still be stored
    expect(store.getState().jobData).toEqual({ id: 'job-1', name: 'Test Job', status: 'running' });
    expect(store.getState().schemaData).toBeNull();
  });

  it('stops polling on unmount', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    const { unmount } = render(
      React.createElement(TestComponent, {
        store,
        apiClient,
        jobId: 'job-1',
        interval: 2000,
      }),
    );

    // Let the initial fetch complete
    await vi.advanceTimersByTimeAsync(100);
    expect(apiClient.getJob).toHaveBeenCalledTimes(1);

    unmount();

    // Advance well past multiple intervals
    await vi.advanceTimersByTimeAsync(10000);

    // Should not have fetched again after unmount
    expect(apiClient.getJob).toHaveBeenCalledTimes(1);
  });
});
