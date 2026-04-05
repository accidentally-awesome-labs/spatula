/**
 * Tier 4 — API Lifecycle Integration Tests
 *
 * Exercises the full Hono API stack (routes, middleware, repositories) against
 * real Postgres + optional Redis via `app.request()`.  All 23 tests skip
 * gracefully when DATABASE_URL is not set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  createTestApp,
  createTenant,
  authHeaders,
  seedJobWithData,
  startWebhookReceiver,
  type TestApp,
  type SeedResult,
  type WebhookReceiver,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let app: TestApp['app'];
let pool: TestApp['pool'];
let db: TestApp['db'];
let cleanup: (() => Promise<void>) | null = null;
let tenantId: string;
let dbAvailable = false;

// Seeded data for schema / entity / action tests
let seed: SeedResult;

beforeAll(async () => {
  const result = await createTestApp();
  if (!result) return; // DATABASE_URL not set — all tests will skip
  dbAvailable = true;
  app = result.app;
  pool = result.pool;
  db = result.db;
  cleanup = result.cleanup;

  // Bootstrap a tenant for use in most tests
  const tenant = await createTenant(app);
  tenantId = tenant.tenantId;

  // Seed data for schema / entity / action groups
  seed = await seedJobWithData(db, tenantId);
}, 30_000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skip(ctx: { skip: () => void }) {
  if (!dbAvailable) ctx.skip();
}

/** Minimal valid body for POST /api/v1/jobs. */
function minimalJobBody() {
  return {
    name: 'Lifecycle Test Job',
    description: 'Created by tier-4 API lifecycle test',
    seedUrls: ['https://example.com'],
    crawl: {
      maxDepth: 1,
      maxPages: 10,
      concurrency: 1,
      crawlerType: 'playwright',
    },
    schema: { mode: 'discovery' },
    llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
  };
}

// =========================================================================
// 1. Tenant & Auth (2)
// =========================================================================

describe('Tenant & Auth', () => {
  it('1 — bootstrap creates tenant', async (ctx) => {
    skip(ctx);
    const res = await app.request('/api/v1/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Lifecycle Tenant' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeDefined();
    expect(typeof body.data.id).toBe('string');
  });

  it('2 — missing tenant header rejected', async (ctx) => {
    skip(ctx);
    const res = await app.request('/api/v1/jobs');
    // 401 from authMiddleware when no x-tenant-id
    expect([400, 401]).toContain(res.status);
  });
});

// =========================================================================
// 2. Job CRUD (5)
// =========================================================================

describe('Job CRUD', () => {
  let createdJobId: string;

  it('3 — create job', async (ctx) => {
    skip(ctx);
    const res = await app.request('/api/v1/jobs', {
      method: 'POST',
      headers: authHeaders(tenantId),
      body: JSON.stringify(minimalJobBody()),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeDefined();
    createdJobId = body.data.id;
  });

  it('4 — list jobs', async (ctx) => {
    skip(ctx);
    const res = await app.request('/api/v1/jobs', {
      headers: authHeaders(tenantId),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    // The seed job and the just-created job should both appear
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('5 — get job details', async (ctx) => {
    skip(ctx);
    const res = await app.request(`/api/v1/jobs/${createdJobId}`, {
      headers: authHeaders(tenantId),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(createdJobId);
  });

  it('6 — start job (PATCH)', async (ctx) => {
    skip(ctx);
    const res = await app.request(`/api/v1/jobs/${createdJobId}`, {
      method: 'PATCH',
      headers: authHeaders(tenantId),
      body: JSON.stringify({ action: 'start' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.action).toBe('start');
  });

  it('7 — delete job then 404', async (ctx) => {
    skip(ctx);

    // Create a throwaway job for deletion so we don't disrupt other groups
    const createRes = await app.request('/api/v1/jobs', {
      method: 'POST',
      headers: authHeaders(tenantId),
      body: JSON.stringify(minimalJobBody()),
    });
    const { data } = await createRes.json();
    const deleteId = data.id;

    const delRes = await app.request(`/api/v1/jobs/${deleteId}`, {
      method: 'DELETE',
      headers: authHeaders(tenantId),
    });
    expect(delRes.status).toBe(204);

    // Subsequent GET should 404
    const getRes = await app.request(`/api/v1/jobs/${deleteId}`, {
      headers: authHeaders(tenantId),
    });
    expect(getRes.status).toBe(404);
  });
});

// =========================================================================
// 3. Schema & Entities (3)
// =========================================================================

describe('Schema & Entities', () => {
  it('8 — get schema', async (ctx) => {
    skip(ctx);
    const res = await app.request(`/api/v1/jobs/${seed.jobId}/schema`, {
      headers: authHeaders(tenantId),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.data.definition).toBeDefined();
    expect(body.data.definition.fields.length).toBeGreaterThanOrEqual(2);
  });

  it('9 — list entities with limit', async (ctx) => {
    skip(ctx);
    const res = await app.request(`/api/v1/jobs/${seed.jobId}/entities?limit=2`, {
      headers: authHeaders(tenantId),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeLessThanOrEqual(2);
    expect(body.pagination.total).toBeGreaterThanOrEqual(3);
  });

  it('10 — get entity detail', async (ctx) => {
    skip(ctx);
    const entityId = seed.entityIds[0];
    const res = await app.request(
      `/api/v1/jobs/${seed.jobId}/entities/${entityId}`,
      { headers: authHeaders(tenantId) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(entityId);
    expect(body.data.mergedData).toBeDefined();
  });
});

// =========================================================================
// 4. Actions (3)
// =========================================================================

describe('Actions', () => {
  it('11 — list pending actions', async (ctx) => {
    skip(ctx);
    const res = await app.request(
      `/api/v1/jobs/${seed.jobId}/actions?status=pending_review`,
      { headers: authHeaders(tenantId) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('12 — approve action', async (ctx) => {
    skip(ctx);
    const actionId = seed.actionIds[0];
    const res = await app.request(
      `/api/v1/jobs/${seed.jobId}/actions/${actionId}/approve`,
      {
        method: 'POST',
        headers: authHeaders(tenantId),
        body: JSON.stringify({}),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
  });

  it('13 — batch actions', async (ctx) => {
    skip(ctx);
    // Use the second seeded action (first was already approved in test 12)
    const res = await app.request('/api/v1/actions/batch', {
      method: 'POST',
      headers: authHeaders(tenantId),
      body: JSON.stringify({
        action: 'approve',
        ids: [seed.actionIds[1]],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.succeeded).toBeDefined();
    expect(body.data.failed).toBeDefined();
  });
});

// =========================================================================
// 5. Export (2)
// =========================================================================

describe('Export', () => {
  let exportId: string;

  it('14 — create export', async (ctx) => {
    skip(ctx);
    const res = await app.request(`/api/v1/jobs/${seed.jobId}/export`, {
      method: 'POST',
      headers: authHeaders(tenantId),
      body: JSON.stringify({ format: 'json' }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.id).toBeDefined();
    exportId = body.data.id;
  });

  it('15 — get export status', async (ctx) => {
    skip(ctx);
    const res = await app.request(
      `/api/v1/jobs/${seed.jobId}/export/${exportId}`,
      { headers: authHeaders(tenantId) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(exportId);
  });
});

// =========================================================================
// 6. Webhook (2)
// =========================================================================

describe('Webhook', () => {
  let receiver: WebhookReceiver;

  beforeAll(async () => {
    if (!dbAvailable) return;
    receiver = await startWebhookReceiver();
  });

  afterAll(async () => {
    if (receiver) await receiver.close();
  });

  it('16 — WebhookSender delivers to receiver', async (ctx) => {
    skip(ctx);
    const { WebhookSender } = await import('@spatula/queue');
    const sender = new WebhookSender();

    const event = {
      id: 'evt_test123',
      type: 'job.completed' as const,
      timestamp: new Date().toISOString(),
      data: {
        jobId: seed.jobId,
        tenantId,
        status: 'completed',
      },
    };

    await sender.send(`http://127.0.0.1:${receiver.port}/webhook`, event);

    const received = await receiver.waitForRequest(5_000);
    expect(received).toBeDefined();
    expect(receiver.requests.length).toBeGreaterThanOrEqual(1);

    const lastReq = receiver.requests[receiver.requests.length - 1];
    expect((lastReq.body as any).type).toBe('job.completed');
    expect((lastReq.body as any).id).toBe('evt_test123');
  });

  it('17 — X-Spatula-Signature present when secret configured', async (ctx) => {
    skip(ctx);
    const { WebhookSender } = await import('@spatula/queue');
    const sender = new WebhookSender();
    const secret = 'test-secret-at-least-16-chars';

    const event = {
      id: 'evt_sig_test',
      type: 'job.failed' as const,
      timestamp: new Date().toISOString(),
      data: {
        jobId: seed.jobId,
        tenantId,
        status: 'failed',
      },
    };

    await sender.send(`http://127.0.0.1:${receiver.port}/webhook`, event, secret);

    const lastReq = receiver.requests[receiver.requests.length - 1];
    const sigHeader = lastReq.headers['x-spatula-signature'];
    expect(sigHeader).toBeDefined();
    expect(sigHeader).toMatch(/^sha256=/);

    // Verify the HMAC is correct
    const expectedSig = createHmac('sha256', secret)
      .update(JSON.stringify(event))
      .digest('hex');
    expect(sigHeader).toBe(`sha256=${expectedSig}`);
  });
});

// =========================================================================
// 7. Health (2)
// =========================================================================

describe('Health', () => {
  it('18 — GET /health returns ok', async (ctx) => {
    skip(ctx);
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('19 — GET /health/ready has checks', async (ctx) => {
    skip(ctx);
    const res = await app.request('/health/ready');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks).toBeDefined();
    expect(typeof body.checks).toBe('object');
  });
});

// =========================================================================
// 8. Extractions, Usage, API Keys (3)
// =========================================================================

describe('Extractions, Usage, API Keys', () => {
  it('20 — list extractions', async (ctx) => {
    skip(ctx);
    const res = await app.request(
      `/api/v1/jobs/${seed.jobId}/extractions`,
      { headers: authHeaders(tenantId) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
  });

  it('21 — get usage', async (ctx) => {
    skip(ctx);
    const res = await app.request('/api/v1/usage', {
      headers: authHeaders(tenantId),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.data.period).toBeDefined();
  });

  it('22 — API key CRUD cycle', async (ctx) => {
    skip(ctx);

    // Create
    const createRes = await app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: authHeaders(tenantId),
      body: JSON.stringify({ name: 'Test Key' }),
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.data.id).toBeDefined();
    expect(createBody.data.key).toMatch(/^sk_live_/);
    const keyId = createBody.data.id;

    // List
    const listRes = await app.request('/api/v1/api-keys', {
      headers: authHeaders(tenantId),
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(Array.isArray(listBody.data)).toBe(true);
    const found = listBody.data.find((k: { id: string }) => k.id === keyId);
    expect(found).toBeDefined();

    // Revoke (DELETE)
    const revokeRes = await app.request(`/api/v1/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: authHeaders(tenantId),
    });
    expect(revokeRes.status).toBe(200);
    const revokeBody = await revokeRes.json();
    expect(revokeBody.data.revoked).toBe(true);
  });
});

// =========================================================================
// 9. Rate Limiting (1)
// =========================================================================

describe('Rate Limiting', () => {
  it('23 — authenticated request has rate limit headers (when Redis available)', async (ctx) => {
    skip(ctx);
    const res = await app.request('/api/v1/jobs', {
      headers: authHeaders(tenantId),
    });

    expect(res.status).toBe(200);

    // Rate limit headers are only added when Redis is configured.
    // If Redis is not available, the middleware is skipped and headers are absent.
    // We check for the headers' presence but do not fail if Redis was not wired.
    const limitHeader = res.headers.get('X-RateLimit-Limit');
    const remainingHeader = res.headers.get('X-RateLimit-Remaining');

    if (limitHeader !== null) {
      expect(Number(limitHeader)).toBeGreaterThan(0);
      expect(remainingHeader).not.toBeNull();
      expect(Number(remainingHeader!)).toBeGreaterThanOrEqual(0);
    }
    // When no Redis, just assert the request succeeded (already checked above)
  });
});
