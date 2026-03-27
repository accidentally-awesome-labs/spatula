import { SpatulaError } from '../errors.js';
import type { SpatulaErrorOptions } from '../errors.js';

export interface TenantQuotas {
  maxConcurrentJobs: number;
  maxPagesPerJob: number;
  maxEntitiesPerExport: number;
  maxStorageMb: number;
  rateLimitTier: string;
}

export const DEFAULT_TENANT_QUOTAS: TenantQuotas = {
  maxConcurrentJobs: 2,
  maxPagesPerJob: 5000,
  maxEntitiesPerExport: 50000,
  maxStorageMb: 1000,
  rateLimitTier: 'free',
};

export class QuotaExceededError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'QUOTA_EXCEEDED', options);
    this.name = 'QuotaExceededError';
  }
}
