import Stripe from 'stripe';
import { createLogger } from '@spatula/shared';

const logger = createLogger('stripe-client');

export class SpatulaStripeClient {
  constructor(private readonly stripe: Stripe | null) {}

  isConfigured(): boolean {
    return this.stripe !== null;
  }

  async createCustomer(tenantId: string, email: string): Promise<string> {
    if (!this.stripe) throw new Error('Stripe not configured');
    const customer = await this.stripe.customers.create({
      email,
      metadata: { tenantId },
    });
    logger.info({ tenantId, customerId: customer.id }, 'Stripe customer created');
    return customer.id;
  }

  async createPortalSession(customerId: string, returnUrl: string): Promise<string> {
    if (!this.stripe) throw new Error('Stripe not configured');
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return session.url;
  }

  async getSubscription(customerId: string): Promise<Stripe.Subscription | null> {
    if (!this.stripe) throw new Error('Stripe not configured');
    const list = await this.stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
    });
    return list.data[0] ?? null;
  }

  async getInvoices(customerId: string, limit: number): Promise<Stripe.Invoice[]> {
    if (!this.stripe) throw new Error('Stripe not configured');
    const list = await this.stripe.invoices.list({
      customer: customerId,
      limit,
    });
    return list.data;
  }

  /**
   * Report usage to Stripe via Billing Meter Events (v2 API).
   * Meter event names must be pre-configured in the Stripe Dashboard.
   * The payload uses stripe_customer_id for customer mapping and value for quantity.
   */
  async reportUsage(customerId: string, eventName: string, value: number, idempotencyKey?: string): Promise<void> {
    if (!this.stripe) throw new Error('Stripe not configured');
    await this.stripe.billing.meterEvents.create({
      event_name: eventName,
      payload: {
        stripe_customer_id: customerId,
        value: String(value),
      },
      ...(idempotencyKey ? { identifier: idempotencyKey } : {}),
    });
  }

  verifyWebhook(rawBody: string, signature: string, webhookSecret: string): Stripe.Event {
    if (!this.stripe) throw new Error('Stripe not configured');
    return this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  }
}

/**
 * Create a SpatulaStripeClient. Returns a client with null Stripe instance
 * when STRIPE_SECRET_KEY is not set (self-hosted mode).
 */
export function createStripeClient(): SpatulaStripeClient {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    logger.info('Stripe not configured — billing features disabled');
    return new SpatulaStripeClient(null);
  }
  const stripe = new Stripe(secretKey);
  return new SpatulaStripeClient(stripe);
}
