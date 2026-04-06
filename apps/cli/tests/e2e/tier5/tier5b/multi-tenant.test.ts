import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupTenantPair,
  bearerHeaders,
  minimalJobBody,
  type AuthTestContext,
} from './helpers.js';

describe('Tier 5B: Multi-Tenant Isolation', () => {
  let ctx: AuthTestContext;
  let tenantB: { tenantId: string; key: string };
  let dbAvailable = false;
  let tenantAJobId: string;

  beforeAll(async () => {
    const result = await setupTenantPair();
    if (!result) return;
    ctx = result.ctx;
    tenantB = result.tenantB;
    dbAvailable = true;

    // Create a job in tenant A
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify(minimalJobBody({ name: 'Tenant A Job' })),
    });
    const body = await res.json();
    tenantAJobId = body.data.id;
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  // ── Test 9: Tenant A data invisible to Tenant B ────────────────────
  it('tenant A jobs invisible to tenant B', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(tenantB.key),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  // ── Test 10: Tenant B GET tenant A job by ID → 404 ────────────────
  it('tenant B cannot access tenant A job by ID', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request(`/api/v1/jobs/${tenantAJobId}`, {
      headers: bearerHeaders(tenantB.key),
    });
    expect(res.status).toBe(404);
  });

  // ── Test 11: Tenant B cannot approve tenant A action → 404 ────────
  it('tenant B cannot modify tenant A actions', async (t) => {
    if (!dbAvailable) return t.skip();

    // Insert an action for tenant A's job directly via DB
    // Note: actions table requires source, confidence, reasoning (NOT NULL columns)
    const { actions } = await import('@spatula/db/dist/schema/index.js');
    const [action] = await ctx.db.insert(actions).values({
      jobId: tenantAJobId,
      tenantId: ctx.tenantId,
      type: 'add_field',
      status: 'pending_review',
      payload: { field: 'test', reason: 'test action' },
      source: 'schema_evolution',
      confidence: 0.9,
      reasoning: 'test action for multi-tenant isolation',
    }).returning({ id: actions.id });

    // Tenant B tries to approve tenant A's action
    const res = await ctx.app.request(
      `/api/v1/jobs/${tenantAJobId}/actions/${action.id}/approve`,
      {
        method: 'POST',
        headers: bearerHeaders(tenantB.key),
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(404);
  });
});
