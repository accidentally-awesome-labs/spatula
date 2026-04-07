export interface BillingTierLimits {
  jobsPerMonth: number;
  pagesPerMonth: number;
  llmTokensPerMonth: number;
  storageMb: number;
  exportFormats: string[];
  rateLimitPerMin: number;
}

export interface BillingTier {
  name: 'free' | 'starter' | 'pro' | 'enterprise';
  limits: BillingTierLimits;
}

export type BillingTierName = BillingTier['name'];

export const BILLING_TIERS: Record<BillingTierName, BillingTier> = {
  free: {
    name: 'free',
    limits: {
      jobsPerMonth: 5,
      pagesPerMonth: 1_000,
      llmTokensPerMonth: 100_000,
      storageMb: 100,
      exportFormats: ['json', 'csv'],
      rateLimitPerMin: 60,
    },
  },
  starter: {
    name: 'starter',
    limits: {
      jobsPerMonth: 50,
      pagesPerMonth: 10_000,
      llmTokensPerMonth: 1_000_000,
      storageMb: 1_000,
      exportFormats: ['json', 'csv', 'sqlite', 'parquet', 'duckdb'],
      rateLimitPerMin: 300,
    },
  },
  pro: {
    name: 'pro',
    limits: {
      jobsPerMonth: 500,
      pagesPerMonth: 100_000,
      llmTokensPerMonth: 10_000_000,
      storageMb: 10_000,
      exportFormats: ['json', 'csv', 'sqlite', 'parquet', 'duckdb'],
      rateLimitPerMin: 1_500,
    },
  },
  enterprise: {
    name: 'enterprise',
    limits: {
      jobsPerMonth: Infinity,
      pagesPerMonth: Infinity,
      llmTokensPerMonth: Infinity,
      storageMb: Infinity,
      exportFormats: ['json', 'csv', 'sqlite', 'parquet', 'duckdb'],
      rateLimitPerMin: Infinity,
    },
  },
};

/** Billable dimension names matching usage_records.dimension column */
export type UsageDimension = 'jobs' | 'pages' | 'llm_tokens' | 'storage_bytes';

/** Map dimension to tier limit field */
export function getTierLimit(tier: BillingTierName, dimension: UsageDimension): number {
  const limits = BILLING_TIERS[tier]?.limits ?? BILLING_TIERS.free.limits;
  switch (dimension) {
    case 'jobs': return limits.jobsPerMonth;
    case 'pages': return limits.pagesPerMonth;
    case 'llm_tokens': return limits.llmTokensPerMonth;
    case 'storage_bytes': return limits.storageMb * 1_024 * 1_024;
    default: return Infinity;
  }
}
