/**
 * Unit tests for the tenant-delete BullMQ worker.
 *
 * Uses mocked TenantDataRepository, TenantRepository, and ContentStore.
 * Tests the cascade order, idempotency blob error handling, and fail-loud behaviour.
 */
import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import { processTenantDeleteJob } from '../../src/workers/tenant-delete-worker.js';
import type { TenantDeleteJobDeps } from '../../src/workers/tenant-delete-worker.js';
import type { TenantDeleteJobData } from '../../src/queues.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJobData(overrides?: Partial<TenantDeleteJobData>): TenantDeleteJobData {
  return {
    tenantId: 'tenant-abc',
    requestedBy: 'admin@example.com',
    requestedAt: '2026-05-20T10:00:00Z',
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<TenantDeleteJobDeps>): TenantDeleteJobDeps {
  return {
    tenantDataRepo: {
      cascadeDeleteTenantData: vi.fn().mockResolvedValue({ deletedCounts: {} }),
      redactTenantAuditLog: vi.fn().mockResolvedValue(5),
      insertDeletionTombstone: vi.fn().mockResolvedValue(undefined),
    } as any,
    tenantRepo: {
      findById: vi.fn().mockResolvedValue({ id: 'tenant-abc', name: 'Test Tenant' }),
      update: vi.fn().mockResolvedValue(undefined),
      // delete method
      delete: vi.fn().mockResolvedValue(undefined),
    } as any,
    contentStore: {
      delete: vi.fn().mockResolvedValue(undefined),
      // listKeys for prefix scan — returns raw_page refs + export refs + forensic refs
      listKeys: vi.fn().mockResolvedValue([]),
    } as any,
    db: {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue({ rowCount: 1 }),
      }),
    } as any,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processTenantDeleteJob', () => {
  it('calls cascade steps in the correct order', async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      tenantDataRepo: {
        cascadeDeleteTenantData: vi.fn().mockImplementation(async () => {
          callOrder.push('cascadeDeleteTenantData');
          return { deletedCounts: {} };
        }),
        redactTenantAuditLog: vi.fn().mockImplementation(async () => {
          callOrder.push('redactTenantAuditLog');
          return 0;
        }),
        insertDeletionTombstone: vi.fn().mockImplementation(async () => {
          callOrder.push('insertDeletionTombstone');
        }),
      } as any,
      db: {
        // db.execute is called for blob-ref queries (returns no rows) and the final tenant DELETE
        execute: vi.fn().mockImplementation(async (query: any) => {
          const sql = query?.queryChunks?.map((c: any) => c?.value ?? c).join(' ') ?? '';
          const isTenantDelete =
            typeof sql === 'string' && sql.includes('DELETE') && sql.includes('tenants');
          if (isTenantDelete) callOrder.push('deleteTenantRow');
          return { rows: [], rowCount: 1 };
        }),
      } as any,
    });

    await processTenantDeleteJob(makeJobData(), deps);

    // Cascade must come before redaction, tombstone inserted after redaction,
    // tenant row deleted last.
    const cascadeIdx = callOrder.indexOf('cascadeDeleteTenantData');
    const redactIdx = callOrder.indexOf('redactTenantAuditLog');
    const tombstoneIdx = callOrder.indexOf('insertDeletionTombstone');
    const deleteRowIdx = callOrder.indexOf('deleteTenantRow');

    expect(cascadeIdx).toBeGreaterThanOrEqual(0);
    expect(redactIdx).toBeGreaterThan(cascadeIdx);
    expect(tombstoneIdx).toBeGreaterThan(redactIdx);
    expect(deleteRowIdx).toBeGreaterThan(tombstoneIdx);
  });

  it('swallows NoSuchKey-shaped blob error (idempotency)', async () => {
    const noSuchKeyError = new Error('NoSuchKey');
    (noSuchKeyError as any).code = 'NoSuchKey';

    const deps = makeDeps({
      contentStore: {
        delete: vi.fn().mockRejectedValue(noSuchKeyError),
        listKeys: vi.fn().mockResolvedValue(['forensic/tenant-abc/extId/123.html']),
      } as any,
    });

    // Should NOT throw — NoSuchKey is treated as "already gone"
    await expect(processTenantDeleteJob(makeJobData(), deps)).resolves.not.toThrow();
  });

  it('swallows ENOENT-shaped blob error (idempotency)', async () => {
    const enoentError = new Error('ENOENT: no such file');
    (enoentError as any).code = 'ENOENT';

    const deps = makeDeps({
      contentStore: {
        delete: vi.fn().mockRejectedValue(enoentError),
        listKeys: vi.fn().mockResolvedValue(['forensic/tenant-abc/extId/456.html']),
      } as any,
    });

    await expect(processTenantDeleteJob(makeJobData(), deps)).resolves.not.toThrow();
  });

  it('swallows 404-shaped blob error (idempotency)', async () => {
    const notFoundError = new Error('Not Found');
    (notFoundError as any).statusCode = 404;

    const deps = makeDeps({
      contentStore: {
        delete: vi.fn().mockRejectedValue(notFoundError),
        listKeys: vi.fn().mockResolvedValue(['forensic/tenant-abc/extId/789.html']),
      } as any,
    });

    await expect(processTenantDeleteJob(makeJobData(), deps)).resolves.not.toThrow();
  });

  it('rethrows unexpected blob errors (fail-loud, D-09)', async () => {
    const unexpectedError = new Error('S3 service unavailable');
    (unexpectedError as any).statusCode = 503;

    const deps = makeDeps({
      contentStore: {
        delete: vi.fn().mockRejectedValue(unexpectedError),
        listKeys: vi.fn().mockResolvedValue(['forensic/tenant-abc/extId/999.html']),
      } as any,
    });

    // Must THROW — BullMQ should retry
    await expect(processTenantDeleteJob(makeJobData(), deps)).rejects.toThrow(
      'S3 service unavailable',
    );
  });

  it('deletes tenant row LAST (after tombstone)', async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      tenantDataRepo: {
        cascadeDeleteTenantData: vi.fn().mockImplementation(async () => ({ deletedCounts: {} })),
        redactTenantAuditLog: vi.fn().mockResolvedValue(0),
        insertDeletionTombstone: vi.fn().mockImplementation(async () => {
          callOrder.push('tombstone');
        }),
      } as any,
      db: {
        execute: vi.fn().mockImplementation(async (query: any) => {
          const sql = query?.queryChunks?.map((c: any) => c?.value ?? c).join(' ') ?? '';
          const isTenantDelete =
            typeof sql === 'string' && sql.includes('DELETE') && sql.includes('tenants');
          if (isTenantDelete) callOrder.push('deleteTenantRow');
          return { rows: [], rowCount: 1 };
        }),
      } as any,
    });

    await processTenantDeleteJob(makeJobData(), deps);

    const tombstoneIdx = callOrder.indexOf('tombstone');
    const deleteIdx = callOrder.indexOf('deleteTenantRow');
    expect(tombstoneIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(tombstoneIdx);
  });

  it('includes forensic/ prefix blobs in the deletion sweep', async () => {
    const forensicRef = 'forensic/tenant-abc/extId/ts.html';
    const deleteBlob = vi.fn().mockResolvedValue(undefined);

    const deps = makeDeps({
      contentStore: {
        delete: deleteBlob,
        listKeys: vi.fn().mockImplementation(async (prefix: string) => {
          if (prefix === `forensic/tenant-abc/`) return [forensicRef];
          return [];
        }),
      } as any,
    });

    await processTenantDeleteJob(makeJobData(), deps);

    expect(deleteBlob).toHaveBeenCalledWith(forensicRef);
  });

  it('does not throw when no blobs exist for the tenant', async () => {
    const deps = makeDeps({
      contentStore: {
        delete: vi.fn(),
        listKeys: vi.fn().mockResolvedValue([]),
      } as any,
    });

    await expect(processTenantDeleteJob(makeJobData(), deps)).resolves.not.toThrow();
  });
});
