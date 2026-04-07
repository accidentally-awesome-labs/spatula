import { describe, it, expect, vi } from 'vitest';
import { SpatulaStripeClient } from '../../../src/billing/stripe-client.js';

function createMockStripe() {
  return {
    customers: {
      create: vi.fn().mockResolvedValue({ id: 'cus_test123' }),
    },
    billingPortal: {
      sessions: {
        create: vi.fn().mockResolvedValue({ url: 'https://billing.stripe.com/session/test' }),
      },
    },
    subscriptions: {
      list: vi.fn().mockResolvedValue({ data: [{ id: 'sub_1', status: 'active', items: { data: [{ id: 'si_1' }] } }] }),
    },
    invoices: {
      list: vi.fn().mockResolvedValue({ data: [{ id: 'inv_1', amount_due: 1000, status: 'paid' }] }),
    },
    billing: {
      meterEvents: {
        create: vi.fn().mockResolvedValue({ object: 'billing.meter_event', event_name: 'spatula_pages' }),
      },
    },
    webhooks: {
      constructEvent: vi.fn().mockReturnValue({ type: 'customer.subscription.updated', data: { object: {} } }),
    },
  };
}

describe('SpatulaStripeClient', () => {
  it('createCustomer returns Stripe customer ID', async () => {
    const stripe = createMockStripe();
    const client = new SpatulaStripeClient(stripe as any);
    const customerId = await client.createCustomer('tenant-1', 'user@example.com');
    expect(customerId).toBe('cus_test123');
    expect(stripe.customers.create).toHaveBeenCalledWith({
      email: 'user@example.com',
      metadata: { tenantId: 'tenant-1' },
    });
  });

  it('createPortalSession returns portal URL', async () => {
    const stripe = createMockStripe();
    const client = new SpatulaStripeClient(stripe as any);
    const url = await client.createPortalSession('cus_test123', 'https://app.spatula.dev/billing');
    expect(url).toBe('https://billing.stripe.com/session/test');
  });

  it('getSubscription returns active subscription', async () => {
    const stripe = createMockStripe();
    const client = new SpatulaStripeClient(stripe as any);
    const sub = await client.getSubscription('cus_test123');
    expect(sub).toBeDefined();
    expect(sub!.id).toBe('sub_1');
  });

  it('getSubscription returns null when no active subscription', async () => {
    const stripe = createMockStripe();
    stripe.subscriptions.list.mockResolvedValue({ data: [] });
    const client = new SpatulaStripeClient(stripe as any);
    const sub = await client.getSubscription('cus_test123');
    expect(sub).toBeNull();
  });

  it('getInvoices returns invoice list', async () => {
    const stripe = createMockStripe();
    const client = new SpatulaStripeClient(stripe as any);
    const invoices = await client.getInvoices('cus_test123', 10);
    expect(invoices).toHaveLength(1);
  });

  it('reportUsage calls billing.meterEvents.create', async () => {
    const stripe = createMockStripe();
    const client = new SpatulaStripeClient(stripe as any);
    await client.reportUsage('cus_test123', 'spatula_pages', 500);
    expect(stripe.billing.meterEvents.create).toHaveBeenCalledWith({
      event_name: 'spatula_pages',
      payload: { stripe_customer_id: 'cus_test123', value: '500' },
    });
  });

  it('reportUsage includes idempotency key when provided', async () => {
    const stripe = createMockStripe();
    const client = new SpatulaStripeClient(stripe as any);
    await client.reportUsage('cus_test123', 'spatula_pages', 500, 'dedup-key-1');
    expect(stripe.billing.meterEvents.create).toHaveBeenCalledWith({
      event_name: 'spatula_pages',
      payload: { stripe_customer_id: 'cus_test123', value: '500' },
      identifier: 'dedup-key-1',
    });
  });

  it('verifyWebhook calls constructEvent', () => {
    const stripe = createMockStripe();
    const client = new SpatulaStripeClient(stripe as any);
    const event = client.verifyWebhook('raw-body', 'sig', 'whsec_test');
    expect(event.type).toBe('customer.subscription.updated');
  });

  it('isConfigured() returns false when no Stripe instance', () => {
    const client = new SpatulaStripeClient(null);
    expect(client.isConfigured()).toBe(false);
  });

  it('throws when calling methods without Stripe configured', async () => {
    const client = new SpatulaStripeClient(null);
    await expect(client.createCustomer('t', 'e')).rejects.toThrow('Stripe not configured');
    await expect(client.getSubscription('c')).rejects.toThrow('Stripe not configured');
    await expect(client.getInvoices('c', 10)).rejects.toThrow('Stripe not configured');
    await expect(client.reportUsage('c', 'evt', 1)).rejects.toThrow('Stripe not configured');
    expect(() => client.verifyWebhook('b', 's', 'w')).toThrow('Stripe not configured');
  });
});
