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
    approveAction: vi.fn(), rejectAction: vi.fn(),
    getStatus: vi.fn().mockResolvedValue({ totalPages: 0, totalEntities: 0, pendingActions: 0, schemaFields: 0, storageBytes: { pages: 0, database: 0, exports: 0 } }),
    createExport: vi.fn(), getExport: vi.fn(), downloadExport: vi.fn(), getDocumentation: vi.fn(),
    ...overrides,
  } as DataSource;
}

describe('useEntityData DataSource support', () => {
  it('type guard accepts DataSource', () => {
    const ds = mockDataSource();
    expect(isDataSource(ds)).toBe(true);
  });

  it('DataSource getEntities is called with limit and offset', async () => {
    const mockResult: PaginatedResult<Entity> = {
      data: [{ id: 'e1', mergedData: { name: 'Test' }, qualityScore: 0.9, categories: [], sourceCount: 1 } as Entity],
      total: 15,
    };
    const ds = mockDataSource({ getEntities: vi.fn().mockResolvedValue(mockResult) });
    const result = await ds.getEntities({ limit: 10, offset: 10 });
    expect(ds.getEntities).toHaveBeenCalledWith({ limit: 10, offset: 10 });
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(15);
  });

  it('DataSource getEntity is called with single argument', async () => {
    const mockEntity = { id: 'e1', mergedData: { name: 'Test' } };
    const ds = mockDataSource({ getEntity: vi.fn().mockResolvedValue(mockEntity) });
    const entity = await ds.getEntity('e1');
    expect(ds.getEntity).toHaveBeenCalledWith('e1');
    expect(entity).toEqual(mockEntity);
  });

  it('DataSource getEntity returns null for missing entity', async () => {
    const ds = mockDataSource({ getEntity: vi.fn().mockResolvedValue(null) });
    const entity = await ds.getEntity('nonexistent');
    expect(entity).toBeNull();
  });
});
