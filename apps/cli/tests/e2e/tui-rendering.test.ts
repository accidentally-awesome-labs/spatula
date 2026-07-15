/**
 * TUI rendering integration tests.
 *
 * Renders ExplorerView and ReviewView with ink-testing-library using REAL data
 * from a REAL SQLite database seeded with entities, schemas, and pending actions.
 *
 * This is a step above unit tests: the store is populated from a real
 * LocalDataSource backed by ProjectAdapter + SQLite, then actual React
 * components are rendered and their text output is asserted.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  createProjectDb,
  initializeProjectDb,
  ProjectAdapter,
} from '@accidentally-awesome-labs/spatula-db';
import { LocalDataSource } from '@accidentally-awesome-labs/spatula-core';
import type { DataSource } from '@accidentally-awesome-labs/spatula-core';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any dynamic imports of the components
// ---------------------------------------------------------------------------

// useKeyboard registers global stdin listeners that conflict with ink-testing-library
vi.mock('../../src/hooks/useKeyboard.js', () => ({
  useKeyboard: vi.fn(),
}));

// useEntityData starts interval-based polling; mock it and wire real data via the store
vi.mock('../../src/hooks/useEntityData.js', () => ({
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

// useEntityFilter starts debounced server queries
vi.mock('../../src/hooks/useEntityFilter.js', () => ({
  useEntityFilter: vi.fn().mockReturnValue({
    setFilterQuery: vi.fn(),
    clearFilter: vi.fn(),
    applyServerFilter: vi.fn(),
  }),
}));

// useJobPolling polls on a timer
vi.mock('../../src/hooks/useJobPolling.js', () => ({
  useJobPolling: vi.fn().mockReturnValue({ isPolling: false, lastError: null }),
  isDataSource: vi.fn().mockReturnValue(true),
  fetchFromDataSource: vi.fn(),
}));

// ink-spinner uses an interval that never clears in test environments
vi.mock('ink-spinner', () => ({
  default: () => React.createElement('ink-text', null, '*'),
}));

// ---------------------------------------------------------------------------
// Shared fixture — real SQLite database with seeded data
// ---------------------------------------------------------------------------

let projectDir: string;
let PROJECT_ID: string;

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'spatula-tui-'));
  writeFileSync(
    join(projectDir, 'spatula.yaml'),
    'name: TUI Test\nseeds:\n  - https://example.com\n',
  );

  const dbDir = join(projectDir, '.spatula');
  mkdirSync(dbDir, { recursive: true });

  const { slugifyPath } = await import('../../src/local-project.js');
  PROJECT_ID = slugifyPath(projectDir);

  const { db, close } = createProjectDb(join(dbDir, 'project.db'));
  initializeProjectDb(db, { projectId: PROJECT_ID, name: 'TUI Test' });

  const adapter = new ProjectAdapter(db, PROJECT_ID);

  // Seed schema
  await adapter.schemaRepo.create({
    jobId: PROJECT_ID,
    tenantId: PROJECT_ID,
    version: 1,
    definition: {
      version: 1,
      fields: [
        { name: 'title', type: 'string', required: true, description: 'Product title' },
        { name: 'price', type: 'currency', required: false, description: 'Price' },
      ],
      fieldAliases: [],
      createdAt: new Date(),
      parentVersion: null,
    },
  });

  // Seed 8 entities with varied quality
  for (let i = 0; i < 8; i++) {
    await adapter.entityRepo.create({
      jobId: PROJECT_ID,
      tenantId: PROJECT_ID,
      mergedData: {
        title: `Product ${String.fromCharCode(72 - i)}`,
        price: 10 + i * 5,
      }, // H, G, F, E, D, C, B, A
      provenance: {},
      qualityScore: 0.5 + i * 0.06, // 0.50, 0.56, 0.62, 0.68, 0.74, 0.80, 0.86, 0.92
      categories: ['product'],
    });
  }

  // Seed 3 pending actions
  for (const [type, field] of [
    ['add_field', 'brand'],
    ['add_field', 'color'],
    ['remove_field', 'old_field'],
  ] as const) {
    await adapter.actionRepo.create({
      jobId: PROJECT_ID,
      tenantId: PROJECT_ID,
      type,
      payload:
        type === 'add_field'
          ? { field: { name: field, type: 'string', description: `${field} field` } }
          : { fieldName: field },
      source: 'schema_evolution',
      status: 'pending_review',
      confidence: 0.9,
      reasoning: `Test action for ${field}`,
    });
  }

  // Seed run
  await adapter.runRepo.create({
    status: 'completed',
    source: 'local',
    configSnapshot: {},
    startedAt: new Date().toISOString(),
  });

  close();
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openTestDataSource(): { dataSource: DataSource; close: () => void } {
  const dbPath = join(projectDir, '.spatula', 'project.db');
  const { db, close } = createProjectDb(dbPath);
  const adapter = new ProjectAdapter(db, PROJECT_ID);
  const dataSource = new LocalDataSource(adapter);
  return { dataSource, close };
}

const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TUI rendering with real DataSource', () => {
  // -------------------------------------------------------------------------
  // ExplorerView
  // -------------------------------------------------------------------------

  it('ExplorerView shows entity data from real database', async () => {
    const { dataSource, close } = openTestDataSource();

    try {
      const { createCliStore } = await import('../../src/store/index.js');
      const store = createCliStore(PROJECT_ID);
      store.getState().setActiveJobId(PROJECT_ID);
      store.getState().setMode('explorer');

      // Pre-load real data into store from the DataSource
      const entities = await dataSource.getEntities({ limit: 20, offset: 0 });
      store.getState().setEntities(entities.data as any);
      store.getState().setTotalEntityCount(entities.total);

      const schema = await dataSource.getSchema();
      if (schema) store.getState().setSchemaData(schema as any);

      // Render with mocked hooks but real store data
      const { ExplorerView } = await import('../../src/components/explorer/ExplorerView.js');
      const { lastFrame, unmount } = render(
        React.createElement(ExplorerView, { store, backend: dataSource }),
      );

      await wait();
      const frame = lastFrame()!;

      // Should show entity data from real DB
      expect(frame).toContain('Product');
      // Should show column headers from schema
      expect(frame).toContain('title');

      unmount();
    } finally {
      close();
    }
  });

  it('ExplorerView shows entity count from real database', async () => {
    const { dataSource, close } = openTestDataSource();

    try {
      const { createCliStore } = await import('../../src/store/index.js');
      const store = createCliStore(PROJECT_ID);
      store.getState().setActiveJobId(PROJECT_ID);

      const entities = await dataSource.getEntities({ limit: 20, offset: 0 });
      store.getState().setEntities(entities.data as any);
      store.getState().setTotalEntityCount(entities.total);

      const schema = await dataSource.getSchema();
      if (schema) store.getState().setSchemaData(schema as any);

      const { ExplorerView } = await import('../../src/components/explorer/ExplorerView.js');
      const { lastFrame, unmount } = render(
        React.createElement(ExplorerView, { store, backend: dataSource }),
      );

      await wait();
      const frame = lastFrame()!;

      // Should show 8 entities total
      expect(frame).toContain('8');

      unmount();
    } finally {
      close();
    }
  });

  it('sort by quality reorders entities in store', async () => {
    const { dataSource, close } = openTestDataSource();

    try {
      const { createCliStore } = await import('../../src/store/index.js');
      const store = createCliStore(PROJECT_ID);

      const entities = await dataSource.getEntities({ limit: 20, offset: 0 });
      store.getState().setEntities(entities.data as any);

      // Sort by quality descending (simulates what applySort('quality') does)
      const sorted = [...store.getState().entities].sort((a, b) => b.qualityScore - a.qualityScore);
      store.getState().setEntities(sorted);

      // After sort, highest quality entity should be first
      const sortedFirst = store.getState().entities[0];
      expect(sortedFirst.qualityScore).toBeCloseTo(0.92, 10); // highest seeded quality
      expect((sortedFirst.mergedData as any).title).toBe('Product A'); // entity with i=7

      // Sort by mergedData to verify different ordering works
      const nameSorted = [...store.getState().entities].sort((a, b) => {
        const aTitle = String((a.mergedData as any).title ?? '');
        const bTitle = String((b.mergedData as any).title ?? '');
        return aTitle.localeCompare(bTitle);
      });
      store.getState().setEntities(nameSorted);

      // After title sort, Product A should be first (alphabetical)
      expect((store.getState().entities[0].mergedData as any).title).toBe('Product A');
      // Product H should be last
      expect((store.getState().entities[7].mergedData as any).title).toBe('Product H');
    } finally {
      close();
    }
  });

  // -------------------------------------------------------------------------
  // ReviewView
  // -------------------------------------------------------------------------

  it('ReviewView shows pending actions from real database', async () => {
    const { dataSource, close } = openTestDataSource();

    try {
      const { createCliStore } = await import('../../src/store/index.js');
      const store = createCliStore(PROJECT_ID);
      store.getState().setActiveJobId(PROJECT_ID);

      // Load real actions from the DataSource
      const actions = await dataSource.getActions('pending_review');
      store
        .getState()
        .setPendingActions(
          (actions as any[]).filter(
            (a) => a && typeof a.id === 'string' && typeof a.type === 'string',
          ),
        );

      const { ReviewView } = await import('../../src/components/review/ReviewView.js');
      const { lastFrame, unmount } = render(
        React.createElement(ReviewView, { store, backend: dataSource }),
      );

      await wait();
      const frame = lastFrame()!;

      // The first action rendered depends on DB insertion order.
      // Verify we see the "1 of 3" counter and one of the seeded action types.
      expect(frame).toContain('1 of 3');
      // At least one of our seeded action types must appear
      const hasActionType = frame.includes('add_field') || frame.includes('remove_field');
      expect(hasActionType).toBe(true);

      unmount();
    } finally {
      close();
    }
  });

  it('ReviewView navigates actions with store index change', async () => {
    const { dataSource, close } = openTestDataSource();

    try {
      const { createCliStore } = await import('../../src/store/index.js');
      const store = createCliStore(PROJECT_ID);
      store.getState().setActiveJobId(PROJECT_ID);

      const actions = await dataSource.getActions('pending_review');
      store
        .getState()
        .setPendingActions((actions as any[]).filter((a) => a && typeof a.id === 'string'));

      const { ReviewView } = await import('../../src/components/review/ReviewView.js');
      const { lastFrame, unmount } = render(
        React.createElement(ReviewView, { store, backend: dataSource }),
      );
      await wait();

      // Simulate navigation by updating store (useKeyboard is mocked, so we
      // test the store->render path directly — the key->store mapping is
      // covered in unit tests)
      store.getState().setReviewIndex(1);
      await wait(100);

      const frame = lastFrame()!;
      expect(frame).toContain('2 of 3');

      unmount();
    } finally {
      close();
    }
  });

  it('approving an action via DataSource removes it from pending', async () => {
    const { dataSource, close } = openTestDataSource();

    try {
      const actions = await dataSource.getActions('pending_review');
      expect(actions.length).toBe(3);

      // Approve the first action
      const firstAction = actions[0] as any;
      await dataSource.approveAction(firstAction.id);

      // Re-fetch — should have 2 pending now
      const remaining = await dataSource.getActions('pending_review');
      expect(remaining.length).toBe(2);
    } finally {
      close();
    }
  });
});
