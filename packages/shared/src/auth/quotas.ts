import { SpatulaError } from '../errors.js';
import type { SpatulaErrorOptions } from '../errors.js';
import { ErrorCode } from '../error-codes.js';

export interface TenantQuotas {
  maxConcurrentJobs: number;
  maxPagesPerJob: number;
  maxEntitiesPerExport: number;
  maxStorageMb: number;
}

export const DEFAULT_TENANT_QUOTAS: TenantQuotas = {
  maxConcurrentJobs: 2,
  maxPagesPerJob: 5000,
  maxEntitiesPerExport: 50000,
  maxStorageMb: 1000,
};

/**
 * Quota-exceeded error. As of Phase 16 plan 16-1, this class uses the new
 * `ErrorCode.QUOTA_EXCEEDED` ("QUOTA.EXCEEDED") value rather than the legacy
 * flat string. Constructor signature accepts the same options as the v1
 * domain subclasses so call sites can attach `{ limit, remaining, resetAt }`
 * context that flows into the JSON envelope's `details` payload.
 */
export class QuotaExceededError extends SpatulaError {
  constructor(
    message: string,
    options?: SpatulaErrorOptions & { limit?: number; remaining?: number; resetAt?: number },
  ) {
    const { limit, remaining, resetAt, context, ...rest } = options ?? {};
    super(message, ErrorCode.QUOTA_EXCEEDED, {
      ...rest,
      retryable: rest.retryable ?? true,
      context: {
        ...(limit !== undefined && { limit }),
        ...(remaining !== undefined && { remaining }),
        ...(resetAt !== undefined && { resetAt }),
        ...context,
      },
    });
    this.name = 'QuotaExceededError';
  }
}
