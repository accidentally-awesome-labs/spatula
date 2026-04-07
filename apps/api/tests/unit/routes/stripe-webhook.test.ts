import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { stripeWebhookRoutes } from '../../../src/routes/stripe-webhook.js';

function createMockDeps(overrides: Record<string, any> = {}) {
  return {
    stripeClient: {
      isConfigured: () => true,
      verifyWebhook: vi.fn().mockReturnValue({
        type: 'customer.subscription.updated',
        id: 'evt_1',
        data: {
          object: {
            customer: 'cus_1',
            status: 'active',
            metadata: { plan: 'pro' },
          },
        },
      }),
      ...overrides.stripeClient,
    },
    tenantRepo: {
      findById: vi.fn().mockResolvedValue({ id: 'tenant-1', plan: 'free', stripeCustomerId: 'cus_1' }),
      findByStripeCustomerId: vi.fn().mockResolvedValue({ id: 'tenant-1', plan: 'free', stripeCustomerId: 'cus_1' }),
      updatePlan: vi.fn().mockResolvedValue(undefined),
      ...overrides.tenantRepo,
    },
    auditLogger: {
      log: vi.fn(),
      ...overrides.auditLogger,
    },
  };
}

function createTestApp(deps: any) {
  const app = new Hono();
  // No auth middleware — webhook routes are unauthenticated
  app.use('*', async (c, next) => {
    (c as any).set('deps', deps);
    return next();
  });
  app.route('/api/v1/webhooks/stripe', stripeWebhookRoutes());
  return app;
}

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, STRIPE_WEBHOOK_SECRET: 'whsec_test' };
});

describe('Stripe webhook handler', () => {
  it('handles customer.subscription.updated — updates tenant plan', async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);
    const res = await app.request('/api/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'test-sig', 'content-type': 'application/json' },
      body: '{"test":"body"}',
    });
    expect(res.status).toBe(200);
    expect(deps.stripeClient.verifyWebhook).toHaveBeenCalled();
    expect(deps.tenantRepo.updatePlan).toHaveBeenCalledWith('tenant-1', 'pro');
  });

  it('handles customer.subscription.deleted — downgrades to free', async () => {
    const deps = createMockDeps({
      stripeClient: {
        isConfigured: () => true,
        verifyWebhook: vi.fn().mockReturnValue({
          type: 'customer.subscription.deleted',
          id: 'evt_2',
          data: { object: { customer: 'cus_1' } },
        }),
      },
    });
    const app = createTestApp(deps);
    const res = await app.request('/api/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'test-sig', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(deps.tenantRepo.updatePlan).toHaveBeenCalledWith('tenant-1', 'free');
  });

  it('handles unknown Stripe customer gracefully', async () => {
    const deps = createMockDeps({
      stripeClient: {
        isConfigured: () => true,
        verifyWebhook: vi.fn().mockReturnValue({
          type: 'customer.subscription.updated',
          id: 'evt_3',
          data: { object: { customer: 'cus_unknown', status: 'active', metadata: { plan: 'pro' } } },
        }),
      },
      tenantRepo: {
        findById: vi.fn().mockResolvedValue(null),
        findByStripeCustomerId: vi.fn().mockResolvedValue(null),
        updatePlan: vi.fn(),
      },
    });
    const app = createTestApp(deps);
    const res = await app.request('/api/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'test-sig', 'content-type': 'application/json' },
      body: '{}',
    });
    // Should return 200 (ack to Stripe) even if tenant not found
    expect(res.status).toBe(200);
    expect(deps.tenantRepo.updatePlan).not.toHaveBeenCalled();
  });

  it('returns 400 when signature verification fails', async () => {
    const deps = createMockDeps({
      stripeClient: {
        isConfigured: () => true,
        verifyWebhook: vi.fn().mockImplementation(() => { throw new Error('Invalid signature'); }),
      },
    });
    const app = createTestApp(deps);
    const res = await app.request('/api/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'bad-sig', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('returns 400 when stripe-signature header is missing', async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);
    const res = await app.request('/api/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('returns 503 when Stripe not configured', async () => {
    const deps = createMockDeps({ stripeClient: { isConfigured: () => false } });
    const app = createTestApp(deps);
    const res = await app.request('/api/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'test', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(503);
  });

  it('logs audit event on plan change', async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);
    await app.request('/api/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'test-sig', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.plan_changed',
        tenantId: 'tenant-1',
      }),
    );
  });
});
