import { describe, it, expect, vi } from 'vitest';
import { processCleanupJob } from '../../src/cleanup-worker.js';
import type { CleanupDeps } from '../../src/cleanup-worker.js';

function createMockDeps(overrides?: Partial<CleanupDeps>): CleanupDeps {
  return {
    db: {
      execute: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as any,
    tenantRepo: {
      findAll: vi.fn().mockResolvedValue([
        {
          id: 'tenant-1',
          config: {
            retention: { completedJobsDays: 90, failedJobsDays: 30, rawPagesDays: 30, exportsDays: 30 },
          },
        },
      ]),
    } as any,
    contentStore: {
      delete: vi.fn().mockResolvedValue(undefined),
    } as any,
    ...overrides,
  };
}

describe('processCleanupJob', () => {
  it('processes tenants and returns statistics', async () => {
    const deps = createMockDeps();
    const result = await processCleanupJob(deps);
    expect(result.tenantsProcessed).toBe(1);
    expect(deps.tenantRepo.findAll).toHaveBeenCalled();
  });

  it('uses default retention when tenant has no config', async () => {
    const deps = createMockDeps({
      tenantRepo: {
        findAll: vi.fn().mockResolvedValue([{ id: 'tenant-2', config: {} }]),
      } as any,
    });
    const result = await processCleanupJob(deps);
    expect(result.tenantsProcessed).toBe(1);
  });

  it('continues processing other tenants if one fails', async () => {
    const callCount = { n: 0 };
    const deps = createMockDeps({
      tenantRepo: {
        findAll: vi.fn().mockResolvedValue([
          { id: 'tenant-1', config: {} },
          { id: 'tenant-2', config: {} },
        ]),
      } as any,
      db: {
        execute: vi.fn().mockImplementation(async () => {
          callCount.n++;
          if (callCount.n === 1) throw new Error('DB error');
          return { rows: [], rowCount: 0 };
        }),
      } as any,
    });
    const result = await processCleanupJob(deps);
    expect(result.tenantsProcessed).toBe(2);
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('cleans system-wide data even with no tenants', async () => {
    const deps = createMockDeps({
      tenantRepo: { findAll: vi.fn().mockResolvedValue([]) } as any,
    });
    const result = await processCleanupJob(deps);
    expect(deps.db.execute).toHaveBeenCalled();
    expect(result.systemCleanup).toBeDefined();
  });

  it('skips content store cleanup when contentStore is undefined', async () => {
    const deps = createMockDeps({
      tenantRepo: { findAll: vi.fn().mockResolvedValue([]) } as any,
      contentStore: undefined,
    });
    const result = await processCleanupJob(deps);
    expect(result.systemCleanup.contentOrphans).toBeUndefined();
  });

  it('Phase C: orphan content store scan deletes orphans', async () => {
    const deps = createMockDeps({
      tenantRepo: { findAll: vi.fn().mockResolvedValue([]) } as any,
      db: {
        execute: vi.fn().mockImplementation(async (query: any) => {
          const queryStr = query?.queryChunks?.map((c: any) => c.value ?? c).join('') ?? String(query);
          if (queryStr.includes('content_store') && queryStr.includes('NOT IN')) {
            return { rows: [{ id: 'orphan-1', key: 'pg://orphan-1' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      } as any,
    });
    await processCleanupJob(deps);
    expect(deps.contentStore!.delete).toHaveBeenCalledWith('pg://orphan-1');
  });
});
