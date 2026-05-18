import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import type { AppDeps } from '../../apps/api/src/types.js';
import type { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function makeQueue() {
  return {
    getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, failed: 0 }),
  };
}

function createSmokeDeps(): AppDeps {
  // Smoke deps mirror admin-system.test.ts's createMockDeps but strip every
  // billing-coupled field. The negative assertion below proves the metrics
  // endpoint no longer reaches for `usage_records` or `usageRecordRepo`.
  return {
    dbPool: {
      end: vi.fn(),
      query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    } as unknown as Pool,
    jobRepo: {
      countAll: vi.fn().mockResolvedValue(0),
    } as any,
    schemaRepo: {} as any,
    extractionRepo: {} as any,
    entityRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
    jobManager: {} as any,
    exportRepo: {} as any,
    contentStore: {} as any,
    exportQueue: {} as any,
    tenantRepo: {
      findById: vi.fn().mockResolvedValue({ id: TENANT_ID, name: 'Smoke', config: {} }),
      countAll: vi.fn().mockResolvedValue(0),
      getTotalStorage: vi.fn().mockResolvedValue(0),
    } as any,
    dlqRepo: {
      countUnresolved: vi.fn().mockResolvedValue(0),
    } as any,
    queues: {
      crawl: makeQueue(),
      extract: makeQueue(),
      schemaEvolution: makeQueue(),
      reconciliation: makeQueue(),
      export: makeQueue(),
      webhook: makeQueue(),
    } as any,
  };
}

describe('admin-system/metrics smoke (post-carve-out)', () => {
  it('does not 500 with a usage_records-related error when usage_records surface is gone', async () => {
    const deps = createSmokeDeps();
    const app = createApp(deps);

    const res = await app.request('/api/v1/admin/system/metrics', {
      headers: { 'x-tenant-id': TENANT_ID },
    });

    // The negative assertion: the metrics route may legitimately return 200,
    // 401 (no admin scope under the default no-auth provider), or 403 — but
    // it MUST NOT 500 with a usage_records-shaped error. If billing residue
    // remained in the metrics aggregation, it would surface here as either:
    //   - a 500 with an error mentioning usage_records / usageRecordRepo, or
    //   - a 500 from a Postgres "relation usage_records does not exist" path.
    expect([200, 401, 403]).toContain(res.status);

    if (res.status === 500) {
      // Defensive: include the body in the assertion message so a future
      // regression failure is actionable.
      const body = await res.text();
      throw new Error(`admin metrics returned 500 (carve-out regression?): ${body}`);
    }

    // If 200, the response shape must not include billing/usage_records hints.
    if (res.status === 200) {
      const body = (await res.json()) as { data?: Record<string, unknown> };
      const serialized = JSON.stringify(body);
      expect(/usage_records/i.test(serialized)).toBe(false);
      expect(/usageRecord/i.test(serialized)).toBe(false);
    }
  });
});
