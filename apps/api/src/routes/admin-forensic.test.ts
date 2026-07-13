/**
 * Tests for the admin-forensic.ts route.
 *
 * Verifies:
 * - GET /api/v1/admin/forensic/extractions returns 403 without admin:forensic:read scope
 * - With correct scope: returns {data, nextCursor, hasMore} cursor-first shape
 * - Each item has metadata (extractionId, tenantId, reason, createdAt) + contentRef signed URL
 * - No response field contains raw <html markup
 * - When content store lacks presigned URL support, returns 503
 */
import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../app.js';
import type { AppDeps } from '../types.js';
import type { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

// ContentStore mock that supports presigned URLs
function makePresignedContentStore() {
  return {
    store: vi.fn(),
    retrieve: vi.fn(),
    delete: vi.fn(),
    storeBinary: vi.fn(),
    retrieveBinary: vi.fn(),
    // supportsPresignedUrls guard checks for this method
    getDownloadUrl: vi
      .fn()
      .mockResolvedValue('https://s3.example.com/signed-url?X-Amz-Expires=900'),
  };
}

// ContentStore mock WITHOUT presigned URL support (LocalContentStore)
function makeLocalContentStore() {
  return {
    store: vi.fn(),
    retrieve: vi.fn(),
    delete: vi.fn(),
    storeBinary: vi.fn(),
    retrieveBinary: vi.fn(),
    // No getDownloadUrl method — simulates LocalContentStore
  };
}

function createMockDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    jobRepo: {
      findById: vi.fn(),
      findByTenant: vi.fn().mockResolvedValue([]),
      countByTenant: vi.fn(),
      create: vi.fn(),
      updateStatus: vi.fn(),
      updateStats: vi.fn(),
      deleteWithData: vi.fn(),
    } as any,
    schemaRepo: {} as any,
    extractionRepo: {} as any,
    entityRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
    jobManager: {
      createJob: vi.fn(),
      startJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      triggerReconciliation: vi.fn(),
    } as any,
    exportRepo: {} as any,
    contentStore: makePresignedContentStore() as any,
    exportQueue: {} as any,
    tenantRepo: {
      findById: vi.fn().mockResolvedValue({ id: TENANT_ID, name: 'Test Tenant' }),
      findAll: vi.fn().mockResolvedValue([]),
      countAll: vi.fn().mockResolvedValue(0),
      update: vi.fn(),
    } as any,
    dlqRepo: {
      findUnresolved: vi.fn().mockResolvedValue([
        {
          id: 'dlq-record-1',
          queueName: 'suspicious_extraction',
          jobId: 'extraction-id-1',
          tenantId: TENANT_ID,
          payload: {
            extractionId: 'extraction-id-1',
            forensicRef: 'forensic/tenant/extraction-id-1/1747000000000.html',
            reason: 'suspicious_extraction',
            scanFlags: [],
          },
          attempts: 1,
          failedAt: new Date('2026-05-20T20:00:00Z'),
          resolvedAt: null,
        },
      ]),
      insert: vi.fn(),
    } as any,
    auditLogger: { log: vi.fn() } as any,
    ...overrides,
  };
}

const tenantHeader = { 'x-tenant-id': TENANT_ID };

describe('GET /api/v1/admin/forensic/extractions', () => {
  it('returns 403 without admin:forensic:read scope', async () => {
    // Use a custom authProvider that returns only 'jobs:read' (no admin, no admin:forensic:read)
    const deps = createMockDeps({
      authProvider: {
        authenticate: async () => ({
          tenantId: TENANT_ID,
          userId: 'user-1',
          scopes: ['jobs:read'],
          strategy: 'api-key',
        }),
      } as any,
    });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/forensic/extractions', {
      headers: { ...tenantHeader, Authorization: 'Bearer test-key' },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toMatch(/INSUFFICIENT_SCOPE|AUTH/);
  });

  it('returns 200 with cursor-first {data, nextCursor, hasMore} when admin scope is present', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);

    // NoAuthProvider grants admin (all scopes)
    const res = await app.request('/api/v1/admin/forensic/extractions', {
      headers: tenantHeader,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body).toHaveProperty('nextCursor');
    expect(body).toHaveProperty('hasMore');
  });

  it('returns forensic items with metadata and signed-URL contentRef', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);

    const res = await app.request('/api/v1/admin/forensic/extractions', {
      headers: tenantHeader,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) {
      expect(item).toHaveProperty('extractionId');
      expect(item).toHaveProperty('tenantId');
      expect(item).toHaveProperty('reason');
      expect(item).toHaveProperty('createdAt');
      expect(item).toHaveProperty('contentRef');
      // contentRef must be a URL string (signed URL), not raw HTML
      expect(typeof item.contentRef).toBe('string');
      expect(item.contentRef).not.toMatch(/<html/i);
      expect(item.contentRef).not.toMatch(/<body/i);
    }
  });

  it('contentRef is a signed URL from getDownloadUrl (15-minute TTL = 900s)', async () => {
    const contentStore = makePresignedContentStore();
    const deps = createMockDeps({ contentStore: contentStore as any });
    const app = createApp(deps);

    const res = await app.request('/api/v1/admin/forensic/extractions', {
      headers: tenantHeader,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.data.length).toBeGreaterThan(0);
    // getDownloadUrl was called with 900 seconds (15-minute TTL)
    expect(contentStore.getDownloadUrl).toHaveBeenCalledWith(expect.any(String), 900);
    expect(body.data[0].contentRef).toBe('https://s3.example.com/signed-url?X-Amz-Expires=900');
  });

  it('no response field contains raw HTML markup', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);

    const res = await app.request('/api/v1/admin/forensic/extractions', {
      headers: tenantHeader,
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toMatch(/<html/i);
    expect(raw).not.toMatch(/<body/i);
    expect(raw).not.toMatch(/<script/i);
  });

  it('returns 503 with standard error envelope when content store lacks presigned URL support', async () => {
    const deps = createMockDeps({ contentStore: makeLocalContentStore() as any });
    const app = createApp(deps);

    const res = await app.request('/api/v1/admin/forensic/extractions', {
      headers: tenantHeader,
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.error).toBeDefined();
    expect(body.error.message).toMatch(/signed URL|object storage|presigned/i);
  });
});
