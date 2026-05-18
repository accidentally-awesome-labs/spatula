import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import type { DataSource, PaginatedResult } from '@spatula/core';
import type { Entity } from '@spatula/shared';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

function makeEntity(id: string, data: Record<string, unknown> = {}): Entity {
  return { id, mergedData: data, qualityScore: 0.9, categories: [], sourceCount: 1 } as Entity;
}

function mockDataSource(overrides: Partial<DataSource> = {}): DataSource {
  return {
    getEntities: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    getEntity: vi.fn(),
    searchEntities: vi.fn(),
    getSchema: vi.fn(),
    getSchemaVersions: vi.fn(),
    getActions: vi.fn(),
    approveAction: vi.fn(),
    rejectAction: vi.fn(),
    getStatus: vi.fn(),
    createExport: vi.fn(),
    getExport: vi.fn(),
    downloadExport: vi.fn(),
    getDocumentation: vi.fn(),
    ...overrides,
  } as DataSource;
}

// Cold CI first-load + parallel turbo load can push these past vitest's 5s
// default; same pattern as connection/auth/queue exports timeout bumps.
describe('exportFromDataSource', { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches all entities in a single batch when total <= batchSize', async () => {
    const { exportFromDataSource } = await import('../../../src/hooks/useExport.js');
    const entities = [makeEntity('e1', { name: 'A' }), makeEntity('e2', { name: 'B' })];
    const ds = mockDataSource({
      getEntities: vi.fn().mockResolvedValue({ data: entities, total: 2 }),
    });
    const filepath = await exportFromDataSource(ds, 'job-12345678', 'json', {
      schemaFields: ['name'],
    });
    expect(ds.getEntities).toHaveBeenCalledTimes(1);
    expect(ds.getEntities).toHaveBeenCalledWith({ limit: 200, offset: 0 });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(filepath).toContain('spatula-job-1234');
  });

  it('fetches entities in multiple batches when total > batchSize', async () => {
    const { exportFromDataSource } = await import('../../../src/hooks/useExport.js');
    const batch1 = Array.from({ length: 200 }, (_, i) => makeEntity(`e${i}`));
    const batch2 = [makeEntity('e200'), makeEntity('e201')];
    const ds = mockDataSource({
      getEntities: vi
        .fn()
        .mockResolvedValueOnce({ data: batch1, total: 202 })
        .mockResolvedValueOnce({ data: batch2, total: 202 }),
    });
    await exportFromDataSource(ds, 'job-456', 'csv', { schemaFields: ['name'] });
    expect(ds.getEntities).toHaveBeenCalledTimes(2);
    expect(ds.getEntities).toHaveBeenNthCalledWith(1, { limit: 200, offset: 0 });
    expect(ds.getEntities).toHaveBeenNthCalledWith(2, { limit: 200, offset: 200 });
  });

  it('writes JSON with metadata wrapper', async () => {
    const { exportFromDataSource } = await import('../../../src/hooks/useExport.js');
    const ds = mockDataSource({
      getEntities: vi.fn().mockResolvedValue({ data: [makeEntity('e1', { x: 1 })], total: 1 }),
    });
    await exportFromDataSource(ds, 'job-789', 'json', { schemaFields: ['x'] });
    const writtenContent = (writeFile as any).mock.calls[0][1];
    const parsed = JSON.parse(writtenContent);
    expect(parsed.metadata.count).toBe(1);
    expect(parsed.entities[0].data.x).toBe(1);
  });

  it('writes CSV with correct fields', async () => {
    const { exportFromDataSource } = await import('../../../src/hooks/useExport.js');
    const ds = mockDataSource({
      getEntities: vi
        .fn()
        .mockResolvedValue({ data: [makeEntity('e1', { name: 'Alice', age: 30 })], total: 1 }),
    });
    await exportFromDataSource(ds, 'job-csv', 'csv', { schemaFields: ['name', 'age'] });
    const writtenContent = (writeFile as any).mock.calls[0][1] as string;
    expect(writtenContent).toContain('name');
    expect(writtenContent).toContain('Alice');
  });
});
