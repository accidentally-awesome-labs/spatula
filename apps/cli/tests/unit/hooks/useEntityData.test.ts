import { describe, it, expect, vi } from 'vitest';
import type { DataSource, PaginatedResult } from '@spatula/core';
import type { Entity } from '@spatula/shared';
import { isDataSource } from '../../../src/hooks/useJobPolling.js';

function mockDataSource(overrides: Partial<DataSource> = {}): DataSource {
  return {
    getEntities: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    getEntity: vi.fn().mockResolvedValue(null),
    searchEntities: vi.fn().mockResolvedValue([]),
    getSchema: vi.fn().mockResolvedValue(null),
    getSchemaVersions: vi.fn().mockResolvedValue([]),
    getActions: vi.fn().mockResolvedValue([]),
    approveAction: vi.fn(),
    rejectAction: vi.fn(),
    getStatus: vi.fn().mockResolvedValue({
      totalPages: 0,
      totalEntities: 0,
      pendingActions: 0,
      schemaFields: 0,
      storageBytes: { pages: 0, database: 0, exports: 0 },
    }),
    createExport: vi.fn(),
    getExport: vi.fn(),
    downloadExport: vi.fn(),
    getDocumentation: vi.fn(),
    ...overrides,
  } as DataSource;
}

describe('useEntityData DataSource support', () => {
  it('type guard accepts DataSource', () => {
    const ds = mockDataSource();
    expect(isDataSource(ds)).toBe(true);
  });

  // Note: DataSource method-level tests removed — they were tautological
  // (calling mocks and asserting mock return values). The DataSource contract
  // is tested by real implementations in LocalDataSource and ApiDataSource tests.
});
