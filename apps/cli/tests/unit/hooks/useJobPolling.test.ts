import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { createCliStore } from '../../../src/store/index.js';
import { useJobPolling, isDataSource, fetchFromDataSource } from '../../../src/hooks/useJobPolling.js';
import type { SpatulaApiClient } from '../../../src/api/client.js';
import type { DataSource } from '@spatula/core';

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
  backend,
  jobId,
  interval,
}: {
  store: ReturnType<typeof createCliStore>;
  backend: DataSource | SpatulaApiClient;
  jobId: string;
  interval?: number;
}) {
  const { isPolling, lastError } = useJobPolling(store, backend, jobId, interval);
  return React.createElement(
    Text,
    null,
    `${isPolling ? 'polling' : 'idle'}|${lastError ?? 'none'}`,
  );
}

// ---------------------------------------------------------------------------
// isDataSource type guard
// ---------------------------------------------------------------------------

describe('isDataSource', () => {
  it('returns true for DataSource objects', () => {
    const ds = {
      getEntities: vi.fn(),
      getSchema: vi.fn(),
      getActions: vi.fn(),
      getStatus: vi.fn(),
    };
    expect(isDataSource(ds as unknown as DataSource | SpatulaApiClient)).toBe(true);
  });

  it('returns false for SpatulaApiClient objects', () => {
    const client = { getJob: vi.fn(), listActions: vi.fn(), tenantId: 'test' };
    expect(isDataSource(client as unknown as DataSource | SpatulaApiClient)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchFromDataSource
// ---------------------------------------------------------------------------

describe('fetchFromDataSource', () => {
  it('calls DataSource methods and populates store', async () => {
    const mockStatus = {
      totalPages: 10,
      totalEntities: 5,
      pendingActions: 2,
      schemaFields: 3,
      storageBytes: { pages: 0, database: 0, exports: 0 },
    };
    const mockActions = [{ id: 'a1', type: 'add_field', status: 'pending_review' }];
    const mockSchema = { version: 1, fields: [] };
    const mockEntities = { data: [{ id: 'e1', mergedData: {} }], total: 1 };

    const ds: Partial<DataSource> = {
      getStatus: vi.fn().mockResolvedValue(mockStatus),
      getActions: vi.fn().mockResolvedValue(mockActions),
      getSchema: vi.fn().mockResolvedValue(mockSchema),
      getEntities: vi.fn().mockResolvedValue(mockEntities),
    };

    const setJobData = vi.fn();
    const setPendingActions = vi.fn();
    const setRecentActions = vi.fn();
    const setSchemaData = vi.fn();
    const setEntityPreviews = vi.fn();

    const store = {
      getState: vi.fn().mockReturnValue({
        setJobData,
        setPendingActions,
        setRecentActions,
        setSchemaData,
        setEntityPreviews,
      }),
    };

    await fetchFromDataSource(store as any, ds as DataSource);

    expect(ds.getStatus).toHaveBeenCalled();
    expect(ds.getActions).toHaveBeenCalledWith('pending_review');
    expect(ds.getSchema).toHaveBeenCalled();
    expect(ds.getEntities).toHaveBeenCalledWith({ limit: 5 });

    expect(setJobData).toHaveBeenCalledWith(mockStatus);
    expect(setPendingActions).toHaveBeenCalledWith(mockActions);
    expect(setRecentActions).toHaveBeenCalledWith([]);
    expect(setSchemaData).toHaveBeenCalledWith(mockSchema);
    expect(setEntityPreviews).toHaveBeenCalledWith(mockEntities.data);
  });

  it('handles getSchema failure gracefully', async () => {
    const ds: Partial<DataSource> = {
      getStatus: vi.fn().mockResolvedValue({
        totalPages: 0,
        totalEntities: 0,
        pendingActions: 0,
        schemaFields: 0,
        storageBytes: { pages: 0, database: 0, exports: 0 },
      }),
      getActions: vi.fn().mockResolvedValue([]),
      getSchema: vi.fn().mockRejectedValue(new Error('No schema')),
      getEntities: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    };

    const setSchemaData = vi.fn();
    const store = {
      getState: vi.fn().mockReturnValue({
        setJobData: vi.fn(),
        setPendingActions: vi.fn(),
        setRecentActions: vi.fn(),
        setSchemaData,
        setEntityPreviews: vi.fn(),
      }),
    };

    await fetchFromDataSource(store as any, ds as DataSource);
    expect(setSchemaData).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// useJobPolling — ApiClient mode (original tests preserved)
// ---------------------------------------------------------------------------

describe('useJobPolling (ApiClient mode)', () => {
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
      React.createElement(TestComponent, { store, backend: apiClient, jobId: 'job-1' }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(apiClient.getJob).toHaveBeenCalledWith('job-1');
    expect(store.getState().jobData).toEqual({ id: 'job-1', name: 'Test Job', status: 'running' });
  });

  it('fetches pending actions filtered by status', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    render(
      React.createElement(TestComponent, { store, backend: apiClient, jobId: 'job-1' }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(apiClient.listActions).toHaveBeenCalledWith('job-1', { status: 'pending_review' });
    expect(store.getState().pendingActions).toHaveLength(1);
  });

  it('stores schema data in the store', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    render(
      React.createElement(TestComponent, { store, backend: apiClient, jobId: 'job-1' }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(apiClient.getSchema).toHaveBeenCalledWith('job-1');
    expect(store.getState().schemaData).toEqual({ mode: 'hybrid', version: 2 });
  });

  it('stores entity previews in the store', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    render(
      React.createElement(TestComponent, { store, backend: apiClient, jobId: 'job-1' }),
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
        backend: apiClient,
        jobId: 'job-1',
        interval: 3000,
      }),
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(apiClient.getJob).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(apiClient.getJob).toHaveBeenCalledTimes(2);
  });

  it('handles API errors without crashing', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient({
      getJob: vi.fn().mockRejectedValue(new Error('Network failure')),
    });

    const { lastFrame } = render(
      React.createElement(TestComponent, { store, backend: apiClient, jobId: 'job-1' }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(lastFrame()!).toContain('Network failure');
    expect(store.getState().jobData).toBeNull();
  });

  it('gracefully handles schema fetch failure', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient({
      getSchema: vi.fn().mockRejectedValue(new Error('Schema not found')),
    });

    render(
      React.createElement(TestComponent, { store, backend: apiClient, jobId: 'job-1' }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(store.getState().jobData).toEqual({ id: 'job-1', name: 'Test Job', status: 'running' });
    expect(store.getState().schemaData).toBeNull();
  });

  it('stops polling on unmount', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    const { unmount } = render(
      React.createElement(TestComponent, {
        store,
        backend: apiClient,
        jobId: 'job-1',
        interval: 2000,
      }),
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(apiClient.getJob).toHaveBeenCalledTimes(1);

    unmount();

    await vi.advanceTimersByTimeAsync(10000);
    expect(apiClient.getJob).toHaveBeenCalledTimes(1);
  });

  it('does not fetch when jobId is empty', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    render(
      React.createElement(TestComponent, { store, backend: apiClient, jobId: '' }),
    );

    await vi.advanceTimersByTimeAsync(5000);

    expect(apiClient.getJob).not.toHaveBeenCalled();
    expect(store.getState().jobData).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// useJobPolling — DataSource mode
// ---------------------------------------------------------------------------

describe('useJobPolling (DataSource mode)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createMockDataSource(overrides: Partial<DataSource> = {}): DataSource {
    return {
      getStatus: vi.fn().mockResolvedValue({
        totalPages: 42,
        totalEntities: 7,
        pendingActions: 3,
        schemaFields: 5,
        storageBytes: { pages: 0, database: 0, exports: 0 },
      }),
      getActions: vi.fn().mockResolvedValue([
        { id: 'a1', type: 'add_field', status: 'pending_review' },
      ]),
      getSchema: vi.fn().mockResolvedValue({ version: 2, fields: [] }),
      getEntities: vi.fn().mockResolvedValue({
        data: [{ id: 'e1', mergedData: { name: 'Local Entity' } }],
        total: 1,
      }),
      getEntity: vi.fn(),
      searchEntities: vi.fn(),
      getSchemaVersions: vi.fn(),
      approveAction: vi.fn(),
      rejectAction: vi.fn(),
      createExport: vi.fn(),
      getExport: vi.fn(),
      downloadExport: vi.fn(),
      getDocumentation: vi.fn(),
      ...overrides,
    } as unknown as DataSource;
  }

  it('detects DataSource and calls getStatus instead of getJob', async () => {
    const store = createCliStore('test-tenant');
    const ds = createMockDataSource();

    render(
      React.createElement(TestComponent, { store, backend: ds, jobId: 'local' }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(ds.getStatus).toHaveBeenCalled();
    expect(store.getState().jobData).toMatchObject({ totalPages: 42, totalEntities: 7 });
  });

  it('calls getActions with pending_review filter', async () => {
    const store = createCliStore('test-tenant');
    const ds = createMockDataSource();

    render(
      React.createElement(TestComponent, { store, backend: ds, jobId: 'local' }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(ds.getActions).toHaveBeenCalledWith('pending_review');
    expect(store.getState().pendingActions).toHaveLength(1);
  });

  it('stores schema from DataSource', async () => {
    const store = createCliStore('test-tenant');
    const ds = createMockDataSource();

    render(
      React.createElement(TestComponent, { store, backend: ds, jobId: 'local' }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(ds.getSchema).toHaveBeenCalled();
    expect(store.getState().schemaData).toEqual({ version: 2, fields: [] });
  });

  it('stores entity previews from DataSource', async () => {
    const store = createCliStore('test-tenant');
    const ds = createMockDataSource();

    render(
      React.createElement(TestComponent, { store, backend: ds, jobId: 'local' }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(ds.getEntities).toHaveBeenCalledWith({ limit: 5 });
    expect(store.getState().entityPreviews).toEqual([
      { id: 'e1', mergedData: { name: 'Local Entity' } },
    ]);
  });

  it('sets recentActions to empty array in DataSource mode', async () => {
    const store = createCliStore('test-tenant');
    const ds = createMockDataSource();

    render(
      React.createElement(TestComponent, { store, backend: ds, jobId: 'local' }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(store.getState().recentActions).toEqual([]);
  });
});
