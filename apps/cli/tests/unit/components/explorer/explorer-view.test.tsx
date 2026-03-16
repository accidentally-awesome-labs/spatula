import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { createCliStore } from '../../../../src/store/index.js';
import type { CliStore } from '../../../../src/store/index.js';
import type { SpatulaApiClient } from '../../../../src/api/client.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../../src/hooks/useKeyboard.js', () => ({
  useKeyboard: vi.fn(),
}));

vi.mock('../../../../src/hooks/useEntityData.js', () => ({
  useEntityData: vi.fn().mockReturnValue({
    pageSize: 20,
    totalPages: 1,
    goToPage: vi.fn(),
    nextPage: vi.fn(),
    prevPage: vi.fn(),
    fetchEntity: vi.fn(),
    fetchPage: vi.fn(),
  }),
}));

vi.mock('ink-spinner', () => ({
  default: () => React.createElement('ink-text', null, '*'),
}));

function createMockApiClient(): SpatulaApiClient {
  return {
    getJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'running', stats: {} }),
    listEntitiesPaginated: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    getEntity: vi.fn().mockResolvedValue({}),
    getSchema: vi.fn().mockResolvedValue(null),
  } as unknown as SpatulaApiClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExplorerView', () => {
  let store: CliStore;
  let apiClient: SpatulaApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createCliStore('test-tenant');
    apiClient = createMockApiClient();
  });

  it('shows no-active-job message when activeJobId is null', async () => {
    const { ExplorerView } = await import(
      '../../../../src/components/explorer/ExplorerView.js'
    );

    const { lastFrame } = render(
      <ExplorerView store={store} apiClient={apiClient} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('No active job');
  });

  it('renders empty state when no entities', async () => {
    const { ExplorerView } = await import(
      '../../../../src/components/explorer/ExplorerView.js'
    );

    const state = store.getState();
    state.setActiveJobId('job-test-1234');
    state.setEntities([]);
    state.setTotalEntityCount(0);

    const { lastFrame } = render(
      <ExplorerView store={store} apiClient={apiClient} />,
    );
    const frame = lastFrame()!;

    // DataTable shows "No entities found" when entities is empty
    expect(frame).toContain('No entities found');
    // FilterBar should be visible
    expect(frame).toContain('Filter');
  });

  it('renders data table when entities are present', async () => {
    const { ExplorerView } = await import(
      '../../../../src/components/explorer/ExplorerView.js'
    );

    const state = store.getState();
    state.setActiveJobId('job-table-test');
    state.setEntities([
      {
        id: 'e1',
        jobId: 'job-table-test',
        mergedData: { name: 'Widget A', price: '$10' },
        qualityScore: 0.92,
        sourceCount: 2,
        categories: [],
        createdAt: '2026-03-10T00:00:00Z',
      },
      {
        id: 'e2',
        jobId: 'job-table-test',
        mergedData: { name: 'Widget B', price: '$25' },
        qualityScore: 0.85,
        sourceCount: 1,
        categories: [],
        createdAt: '2026-03-10T00:00:00Z',
      },
    ]);
    state.setTotalEntityCount(2);
    state.setSchemaData({
      version: 1,
      fields: [
        { name: 'name', type: 'string' },
        { name: 'price', type: 'string' },
      ],
    });

    const { lastFrame } = render(
      <ExplorerView store={store} apiClient={apiClient} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('Widget A');
    expect(frame).toContain('Widget B');
    expect(frame).toContain('0.92');
    expect(frame).toContain('Page 1');
  });

  it('extracts schema fields from nested definition.fields', async () => {
    const { ExplorerView } = await import(
      '../../../../src/components/explorer/ExplorerView.js'
    );

    const state = store.getState();
    state.setActiveJobId('job-schema-nested');
    state.setEntities([
      {
        id: 'e1',
        jobId: 'job-schema-nested',
        mergedData: { title: 'Article 1' },
        qualityScore: 0.9,
        sourceCount: 1,
        categories: [],
        createdAt: '2026-03-10T00:00:00Z',
      },
    ]);
    state.setTotalEntityCount(1);
    state.setSchemaData({
      mode: 'discovery',
      version: 2,
      definition: {
        fields: [{ name: 'title', type: 'string' }],
        categories: [],
      },
    });

    const { lastFrame } = render(
      <ExplorerView store={store} apiClient={apiClient} />,
    );
    const frame = lastFrame()!;

    // The column header should include the extracted field name
    expect(frame).toContain('title');
    expect(frame).toContain('Article 1');
  });

  it('renders keyboard hints for table view', async () => {
    const { ExplorerView } = await import(
      '../../../../src/components/explorer/ExplorerView.js'
    );

    const state = store.getState();
    state.setActiveJobId('job-hints-test');

    const { lastFrame } = render(
      <ExplorerView store={store} apiClient={apiClient} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('Navigate');
    expect(frame).toContain('Filter');
    expect(frame).toContain('Export');
  });
});
