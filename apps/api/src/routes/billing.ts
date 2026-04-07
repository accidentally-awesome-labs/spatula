import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { BILLING_TIERS } from '@spatula/shared';
import type { BillingTierName } from '@spatula/shared';

export function billingRoutes() {
  const app = new Hono<AppEnv>();

  // GET /subscription — current plan, usage vs limits, Stripe subscription
  app.get('/subscription', async (c) => {
    const deps = c.get('deps');
    if (!deps.stripeClient?.isConfigured()) {
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Billing not configured' } }, 503);
    }
    const tenantId = c.get('tenantId');
    const tenant = await deps.tenantRepo!.findById(tenantId);
    if (!tenant) return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404);

    const plan = ((tenant as any).plan ?? 'free') as BillingTierName;
    const tier = BILLING_TIERS[plan] ?? BILLING_TIERS.free;

    // Fetch current period usage
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const usage = deps.usageRecordRepo
      ? await deps.usageRecordRepo.aggregateByTenant(tenantId, periodStart, periodEnd)
      : [];

    const usageMap: Record<string, number> = {};
    for (const u of usage) {
      usageMap[u.dimension] = u.total;
    }

    // Convert Infinity to -1 for JSON serialization (JSON doesn't support Infinity)
    const serializableLimits = Object.fromEntries(
      Object.entries(tier.limits).map(([k, v]) => [k, v === Infinity ? -1 : v]),
    );

    // Fetch Stripe subscription if customer exists
    let subscription = null;
    if ((tenant as any).stripeCustomerId) {
      subscription = await deps.stripeClient.getSubscription((tenant as any).stripeCustomerId);
    }

    return c.json({
      data: {
        plan,
        limits: serializableLimits,
        usage: usageMap,
        period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
        stripeSubscription: subscription ? { id: subscription.id, status: subscription.status } : null,
      },
    });
  });

  // GET /invoices — past invoices from Stripe
  app.get('/invoices', async (c) => {
    const deps = c.get('deps');
    if (!deps.stripeClient?.isConfigured()) {
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Billing not configured' } }, 503);
    }
    const tenantId = c.get('tenantId');
    const tenant = await deps.tenantRepo!.findById(tenantId);
    if (!(tenant as any)?.stripeCustomerId) {
      return c.json({ data: [] });
    }

    const limit = Math.min(parseInt(c.req.query('limit') ?? '10', 10) || 10, 100);
    const invoices = await deps.stripeClient.getInvoices((tenant as any).stripeCustomerId, limit);

    return c.json({
      data: invoices.map((inv) => ({
        id: inv.id,
        amountDue: inv.amount_due,
        amountPaid: inv.amount_paid,
        status: inv.status,
        created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
        hostedInvoiceUrl: inv.hosted_invoice_url,
      })),
    });
  });

  // POST /portal — create Stripe Customer Portal session
  app.post('/portal', async (c) => {
    const deps = c.get('deps');
    if (!deps.stripeClient?.isConfigured()) {
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Billing not configured' } }, 503);
    }
    const tenantId = c.get('tenantId');
    const tenant = await deps.tenantRepo!.findById(tenantId);
    if (!(tenant as any)?.stripeCustomerId) {
      return c.json({ error: { code: 'NO_CUSTOMER', message: 'No Stripe customer. Subscribe to a plan first.' } }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const returnUrl = body.returnUrl ?? 'https://app.spatula.dev/billing';
    const url = await deps.stripeClient.createPortalSession((tenant as any).stripeCustomerId, returnUrl);

    return c.json({ data: { url } });
  });

  return app;
}
