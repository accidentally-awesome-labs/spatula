import { describe, it, expect } from 'vitest';
import { QuotaExceededError, DEFAULT_TENANT_QUOTAS } from '../../../src/auth/quotas.js';
import { RATE_LIMIT_TIERS } from '../../../src/auth/rate-limit-tiers.js';
import { SpatulaError } from '../../../src/errors.js';

describe('quotas', () => {
  describe('DEFAULT_TENANT_QUOTAS', () => {
    it('has all required fields with sensible defaults', () => {
      expect(DEFAULT_TENANT_QUOTAS.maxConcurrentJobs).toBe(2);
      expect(DEFAULT_TENANT_QUOTAS.maxPagesPerJob).toBe(5000);
      expect(DEFAULT_TENANT_QUOTAS.maxEntitiesPerExport).toBe(50000);
      expect(DEFAULT_TENANT_QUOTAS.maxStorageMb).toBe(1000);
      expect(DEFAULT_TENANT_QUOTAS.rateLimitTier).toBe('free');
    });

    it('references a valid rate limit tier', () => {
      expect(RATE_LIMIT_TIERS[DEFAULT_TENANT_QUOTAS.rateLimitTier]).toBeDefined();
    });
  });

  describe('QuotaExceededError', () => {
    it('extends SpatulaError with QUOTA_EXCEEDED code', () => {
      const error = new QuotaExceededError('Max concurrent jobs exceeded');
      expect(error).toBeInstanceOf(SpatulaError);
      expect(error.code).toBe('QUOTA_EXCEEDED');
      expect(error.name).toBe('QuotaExceededError');
      expect(error.message).toBe('Max concurrent jobs exceeded');
    });

    it('accepts optional context', () => {
      const error = new QuotaExceededError('limit reached', {
        context: { current: 2, max: 2 },
      });
      expect(error.code).toBe('QUOTA_EXCEEDED');
      expect(error.context).toEqual({ current: 2, max: 2 });
    });
  });
});

describe('rate-limit-tiers', () => {
  it('defines all expected tiers', () => {
    expect(Object.keys(RATE_LIMIT_TIERS).sort()).toEqual(
      ['enterprise', 'free', 'pro', 'starter'],
    );
  });

  it('free tier has lowest limits', () => {
    const free = RATE_LIMIT_TIERS.free;
    expect(free.requestsPerMinute).toBe(60);
    expect(free.maxConcurrentJobs).toBe(2);
  });

  it('tiers increase in request limits', () => {
    const { free, starter, pro } = RATE_LIMIT_TIERS;
    expect(starter.requestsPerMinute).toBeGreaterThan(free.requestsPerMinute);
    expect(pro.requestsPerMinute).toBeGreaterThan(starter.requestsPerMinute);
  });

  it('enterprise tier has Infinity limits', () => {
    const enterprise = RATE_LIMIT_TIERS.enterprise;
    expect(enterprise.requestsPerMinute).toBe(Infinity);
    expect(enterprise.maxConcurrentJobs).toBe(Infinity);
  });

  it('each tier has consistent name field', () => {
    for (const [key, tier] of Object.entries(RATE_LIMIT_TIERS)) {
      expect(tier.name).toBe(key);
    }
  });
});
