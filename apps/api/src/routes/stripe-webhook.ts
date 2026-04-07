import { Hono } from 'hono';
import { createLogger, BILLING_TIERS } from '@spatula/shared';
import type { BillingTierName } from '@spatula/shared';

const logger = createLogger('stripe-webhook');

/**
 * Stripe webhook handler. NOT behind auth middleware — authentication
 * is handled by Stripe webhook signature verification.
 *
 * Handled events:
 * - customer.subscription.updated → update tenant plan
 * - customer.subscription.deleted → downgrade to free
 * - invoice.payment_failed → log for alerting
 */
export function stripeWebhookRoutes() {
  const app = new Hono();

  app.post('/', async (c) => {
    const deps = (c as any).get('deps');
    const stripeClient = deps?.stripeClient;

    if (!stripeClient?.isConfigured()) {
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Stripe not configured' } }, 503);
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Webhook secret not configured' } }, 503);
    }

    const signature = c.req.header('stripe-signature');
    if (!signature) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing stripe-signature header' } }, 400);
    }

    const rawBody = await c.req.text();

    let event: any;
    try {
      event = stripeClient.verifyWebhook(rawBody, signature, webhookSecret);
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Webhook signature verification failed');
      return c.json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature' } }, 400);
    }

    logger.info({ eventType: event.type, eventId: event.id }, 'Stripe webhook received');

    try {
      switch (event.type) {
        case 'customer.subscription.updated': {
          const subscription = event.data.object;
          const customerId = subscription.customer as string;
          const rawPlan = subscription.metadata?.plan ?? 'free';
          const plan = BILLING_TIERS[rawPlan as BillingTierName] ? rawPlan : 'free';
          if (rawPlan !== plan) {
            logger.warn({ rawPlan, resolvedPlan: plan, customerId }, 'Invalid plan in Stripe metadata — defaulting to free');
          }
          await handleSubscriptionUpdate(deps, customerId, plan);
          break;
        }
        case 'customer.subscription.deleted': {
          const subscription = event.data.object;
          const customerId = subscription.customer as string;
          await handleSubscriptionDeleted(deps, customerId);
          break;
        }
        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const customerId = invoice.customer as string;
          logger.warn({ customerId }, 'Invoice payment failed');
          break;
        }
        default:
          logger.debug({ eventType: event.type }, 'Unhandled Stripe event type');
      }
    } catch (err) {
      logger.error({ eventType: event.type, error: (err as Error).message }, 'Error handling webhook event');
      // Return 200 anyway to prevent Stripe retries for business logic errors
    }

    return c.json({ received: true });
  });

  return app;
}

async function handleSubscriptionUpdate(deps: any, customerId: string, plan: string): Promise<void> {
  const tenant = await deps.tenantRepo.findByStripeCustomerId(customerId);
  if (!tenant) {
    logger.warn({ customerId }, 'No tenant found for Stripe customer');
    return;
  }

  await deps.tenantRepo.updatePlan(tenant.id, plan);

  if (deps.auditLogger) {
    deps.auditLogger.log({
      tenantId: tenant.id,
      actorId: 'stripe',
      actorType: 'system',
      action: 'billing.plan_changed',
      metadata: { oldPlan: tenant.plan, newPlan: plan, customerId },
    });
  }

  logger.info({ tenantId: tenant.id, plan }, 'Tenant plan updated via Stripe webhook');
}

async function handleSubscriptionDeleted(deps: any, customerId: string): Promise<void> {
  const tenant = await deps.tenantRepo.findByStripeCustomerId(customerId);
  if (!tenant) return;

  await deps.tenantRepo.updatePlan(tenant.id, 'free');

  if (deps.auditLogger) {
    deps.auditLogger.log({
      tenantId: tenant.id,
      actorId: 'stripe',
      actorType: 'system',
      action: 'billing.subscription_cancelled',
      metadata: { oldPlan: tenant.plan, customerId },
    });
  }

  logger.info({ tenantId: tenant.id }, 'Tenant downgraded to free (subscription deleted)');
}
