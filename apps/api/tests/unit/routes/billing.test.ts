import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { billingRoutes } from '../../../src/routes/billing.js';

function createTestApp(stripeConfigured = true, plan = 'free', stripeCustomerId: string | null = 'cus_1') {
  const app = new Hono();

  const mockStripeClient = {
    isConfigured: () => stripeConfigured,
    getSubscription: vi.fn().mockResolvedValue({ id: 'sub_1', status: 'active' }),
    getInvoices: vi.fn().mockResolvedValue([{ id: 'inv_1', amount_due: 1000, amount_paid: 1000, status: 'paid', created: 1711929600, hosted_invoice_url: 'https://pay.stripe.com/inv_1' }]),
    createPortalSession: vi.fn().mockResolvedValue('https://billing.stripe.com/portal'),
  };

  const mockTenantRepo = {
    findById: vi.fn().mockResolvedValue({ id: 'tenant-1', plan, stripeCustomerId }),
  };

  const mockUsageRecordRepo = {
    aggregateByTenant: vi.fn().mockResolvedValue([
      { dimension: 'pages', total: 500 },
      { dimension: 'llm_tokens', total: 5000 },
    ]),
  };

  app.use('*', async (c, next) => {
    (c as any).set('tenantId', 'tenant-1');
    (c as any).set('auth', { tenantId: 'tenant-1', userId: 'user-1', scopes: ['billing:read', 'billing:write'], strategy: 'jwt' });
    (c as any).set('deps', {
      stripeClient: mockStripeClient,
      tenantRepo: mockTenantRepo,
      usageRecordRepo: mockUsageRecordRepo,
    });
    return next();
  });

  app.route('/api/v1/billing', billingRoutes());

  return { app, mockStripeClient, mockTenantRepo, mockUsageRecordRepo };
}

describe('billing routes', () => {
  describe('GET /subscription', () => {
    it('returns plan, limits, and usage', async () => {
      const { app } = createTestApp();
      const res = await app.request('/api/v1/billing/subscription');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.plan).toBe('free');
      expect(body.data.limits).toBeDefined();
      expect(body.data.usage.pages).toBe(500);
    });

    it('returns 503 when Stripe not configured', async () => {
      const { app } = createTestApp(false);
      const res = await app.request('/api/v1/billing/subscription');
      expect(res.status).toBe(503);
    });

    it('serializes Infinity limits as -1', async () => {
      const { app } = createTestApp(true, 'enterprise');
      const res = await app.request('/api/v1/billing/subscription');
      const body = await res.json() as any;
      expect(body.data.limits.jobsPerMonth).toBe(-1);
      expect(body.data.limits.rateLimitPerMin).toBe(-1);
    });
  });

  describe('GET /invoices', () => {
    it('returns invoice list', async () => {
      const { app } = createTestApp();
      const res = await app.request('/api/v1/billing/invoices');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('inv_1');
    });

    it('returns empty array when no Stripe customer', async () => {
      const { app } = createTestApp(true, 'free', null);
      const res = await app.request('/api/v1/billing/invoices');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data).toEqual([]);
    });
  });

  describe('POST /portal', () => {
    it('returns redirect URL', async () => {
      const { app, mockStripeClient } = createTestApp();
      const res = await app.request('/api/v1/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://app.spatula.dev' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.url).toBe('https://billing.stripe.com/portal');
      expect(mockStripeClient.createPortalSession).toHaveBeenCalledWith('cus_1', 'https://app.spatula.dev');
    });

    it('returns 400 when no Stripe customer', async () => {
      const { app } = createTestApp(true, 'free', null);
      const res = await app.request('/api/v1/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(400);
    });
  });
});
