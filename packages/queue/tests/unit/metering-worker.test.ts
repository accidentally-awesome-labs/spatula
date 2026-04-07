import { describe, it, expect, vi } from 'vitest';
import { processMeteringJob } from '../../src/metering-worker.js';
import type { MeteringDeps } from '../../src/metering-worker.js';

function createMockDeps(records: Array<{ id: string; tenantId: string; dimension: string; quantity: number }> = []): MeteringDeps {
  return {
    usageRecordRepo: {
      getUnreported: vi.fn().mockResolvedValue(records),
      markReported: vi.fn().mockResolvedValue(undefined),
    },
    stripeClient: {
      isConfigured: () => true,
      reportUsage: vi.fn().mockResolvedValue(undefined),
    },
    tenantRepo: {
      findById: vi.fn().mockResolvedValue({ id: 'tenant-1', stripeCustomerId: 'cus_1', plan: 'starter' }),
    },
  };
}

describe('processMeteringJob', () => {
  it('reports usage to Stripe and marks records as reported', async () => {
    const records = [
      { id: 'r1', tenantId: 'tenant-1', dimension: 'pages', quantity: 100 },
      { id: 'r2', tenantId: 'tenant-1', dimension: 'pages', quantity: 200 },
    ];
    const deps = createMockDeps(records);
    await processMeteringJob(deps);
    expect(deps.usageRecordRepo.getUnreported).toHaveBeenCalledWith(1000);
    expect(deps.stripeClient.reportUsage).toHaveBeenCalledWith(
      'cus_1', 'spatula_pages', 300, expect.any(String),
    );
    expect(deps.usageRecordRepo.markReported).toHaveBeenCalledWith(['r1', 'r2']);
  });

  it('aggregates multiple dimensions separately', async () => {
    const records = [
      { id: 'r1', tenantId: 'tenant-1', dimension: 'pages', quantity: 100 },
      { id: 'r2', tenantId: 'tenant-1', dimension: 'llm_tokens', quantity: 5000 },
    ];
    const deps = createMockDeps(records);
    await processMeteringJob(deps);
    expect(deps.stripeClient.reportUsage).toHaveBeenCalledTimes(2);
    expect(deps.stripeClient.reportUsage).toHaveBeenCalledWith(
      'cus_1', 'spatula_pages', 100, expect.any(String),
    );
    expect(deps.stripeClient.reportUsage).toHaveBeenCalledWith(
      'cus_1', 'spatula_llm_tokens', 5000, expect.any(String),
    );
  });

  it('skips when Stripe is not configured', async () => {
    const deps = createMockDeps([]);
    deps.stripeClient.isConfigured = () => false;
    await processMeteringJob(deps);
    expect(deps.usageRecordRepo.getUnreported).not.toHaveBeenCalled();
  });

  it('handles empty unreported records', async () => {
    const deps = createMockDeps([]);
    await processMeteringJob(deps);
    expect(deps.usageRecordRepo.getUnreported).toHaveBeenCalled();
    expect(deps.usageRecordRepo.markReported).not.toHaveBeenCalled();
  });

  it('skips tenants without Stripe customer ID (still marks as reported)', async () => {
    const records = [
      { id: 'r1', tenantId: 'tenant-no-stripe', dimension: 'pages', quantity: 100 },
    ];
    const deps = createMockDeps(records);
    (deps.tenantRepo.findById as any).mockResolvedValue({ id: 'tenant-no-stripe', stripeCustomerId: null, plan: 'free' });
    await processMeteringJob(deps);
    expect(deps.stripeClient.reportUsage).not.toHaveBeenCalled();
    expect(deps.usageRecordRepo.markReported).toHaveBeenCalledWith(['r1']);
  });

  it('does not mark records as reported when Stripe call fails', async () => {
    const records = [
      { id: 'r1', tenantId: 'tenant-1', dimension: 'pages', quantity: 100 },
    ];
    const deps = createMockDeps(records);
    (deps.stripeClient.reportUsage as any).mockRejectedValue(new Error('Stripe API error'));
    await processMeteringJob(deps);
    expect(deps.usageRecordRepo.markReported).not.toHaveBeenCalled();
  });
});
