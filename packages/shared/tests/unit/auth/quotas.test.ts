import { describe, it, expect } from 'vitest';
import { QuotaExceededError, DEFAULT_TENANT_QUOTAS } from '../../../src/auth/quotas.js';
import { DEFAULT_RATE_LIMIT } from '../../../src/auth/rate-limit-tiers.js';
import { SpatulaError } from '../../../src/errors.js';

describe('quotas', () => {
  describe('DEFAULT_TENANT_QUOTAS', () => {
    it('has all required fields with sensible defaults', () => {
      expect(DEFAULT_TENANT_QUOTAS.maxConcurrentJobs).toBe(2);
      expect(DEFAULT_TENANT_QUOTAS.maxPagesPerJob).toBe(5000);
      expect(DEFAULT_TENANT_QUOTAS.maxEntitiesPerExport).toBe(50000);
      expect(DEFAULT_TENANT_QUOTAS.maxStorageMb).toBe(1000);
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
  it('DEFAULT_RATE_LIMIT has expected requestsPerMinute and maxConcurrentJobs', () => {
    expect(DEFAULT_RATE_LIMIT.requestsPerMinute).toBe(300);
    expect(DEFAULT_RATE_LIMIT.maxConcurrentJobs).toBe(10);
  });
});
