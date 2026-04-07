import { describe, it, expect, vi } from 'vitest';
import { QuotaEnforcer } from './quota-enforcer.js';

function createMockUsageRepo(usage: Record<string, number> = {}) {
  return {
    getCurrentUsage: vi.fn().mockImplementation((_tenantId: string, dimension: string) =>
      Promise.resolve(usage[dimension] ?? 0),
    ),
    record: vi.fn().mockResolvedValue(undefined),
    getUnreported: vi.fn(),
    markReported: vi.fn(),
    aggregateByTenant: vi.fn(),
  };
}

function createMockTenantRepo(plan = 'free') {
  return {
    getPlan: vi.fn().mockResolvedValue(plan),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    getQuotas: vi.fn(),
    incrementStorageBytes: vi.fn(),
    updatePlan: vi.fn(),
    findByStripeCustomerId: vi.fn(),
    setCache: vi.fn(),
  };
}

describe('QuotaEnforcer', () => {
  it('allows request when under limit', async () => {
    const enforcer = new QuotaEnforcer(
      createMockUsageRepo({ pages: 100 }) as any,
      createMockTenantRepo('free') as any,
    );
    await expect(enforcer.check('tenant-1', 'pages', 10)).resolves.toBeUndefined();
  });

  it('throws QuotaExceededError when usage + requested exceeds limit', async () => {
    const enforcer = new QuotaEnforcer(
      createMockUsageRepo({ pages: 990 }) as any,
      createMockTenantRepo('free') as any,
    );
    // Free tier: 1000 pages/month. 990 + 50 = 1040 > 1000
    await expect(enforcer.check('tenant-1', 'pages', 50)).rejects.toThrow('Quota exceeded');
  });

  it('allows request at exactly the limit boundary', async () => {
    const enforcer = new QuotaEnforcer(
      createMockUsageRepo({ pages: 990 }) as any,
      createMockTenantRepo('free') as any,
    );
    // Free tier: 1000 pages/month. 990 + 10 = 1000 — exactly at limit, should pass
    await expect(enforcer.check('tenant-1', 'pages', 10)).resolves.toBeUndefined();
  });

  it('allows enterprise tier without limit', async () => {
    const enforcer = new QuotaEnforcer(
      createMockUsageRepo({ pages: 999_999 }) as any,
      createMockTenantRepo('enterprise') as any,
    );
    await expect(enforcer.check('tenant-1', 'pages', 100)).resolves.toBeUndefined();
  });

  it('enforces jobs dimension against correct tier limit', async () => {
    const enforcer = new QuotaEnforcer(
      createMockUsageRepo({ jobs: 5 }) as any,
      createMockTenantRepo('free') as any,
    );
    // Free tier: 5 jobs/month. 5 + 1 = 6 > 5
    await expect(enforcer.check('tenant-1', 'jobs', 1)).rejects.toThrow('Quota exceeded');
  });

  it('checks export format against tier', () => {
    const enforcer = new QuotaEnforcer(
      createMockUsageRepo() as any,
      createMockTenantRepo('free') as any,
    );
    expect(enforcer.isExportFormatAllowed('free', 'json')).toBe(true);
    expect(enforcer.isExportFormatAllowed('free', 'csv')).toBe(true);
    expect(enforcer.isExportFormatAllowed('free', 'parquet')).toBe(false);
    expect(enforcer.isExportFormatAllowed('free', 'duckdb')).toBe(false);
    expect(enforcer.isExportFormatAllowed('free', 'sqlite')).toBe(false);
    expect(enforcer.isExportFormatAllowed('starter', 'parquet')).toBe(true);
    expect(enforcer.isExportFormatAllowed('pro', 'duckdb')).toBe(true);
  });

  it('checkAndRecord records usage after successful check', async () => {
    const usageRepo = createMockUsageRepo({ jobs: 0 });
    const enforcer = new QuotaEnforcer(usageRepo as any, createMockTenantRepo('free') as any);
    await enforcer.checkAndRecord('tenant-1', 'jobs', 1);
    expect(usageRepo.record).toHaveBeenCalledWith('tenant-1', 'jobs', 1);
  });

  it('checkAndRecord does not record when check fails', async () => {
    const usageRepo = createMockUsageRepo({ jobs: 5 });
    const enforcer = new QuotaEnforcer(usageRepo as any, createMockTenantRepo('free') as any);
    await expect(enforcer.checkAndRecord('tenant-1', 'jobs', 1)).rejects.toThrow();
    expect(usageRepo.record).not.toHaveBeenCalled();
  });

  it('falls back to free tier for unknown plan', async () => {
    const enforcer = new QuotaEnforcer(
      createMockUsageRepo({ pages: 999 }) as any,
      createMockTenantRepo('nonexistent-plan') as any,
    );
    // Falls back to free tier (1000 pages). 999 + 2 = 1001 > 1000
    await expect(enforcer.check('tenant-1', 'pages', 2)).rejects.toThrow('Quota exceeded');
  });
});
