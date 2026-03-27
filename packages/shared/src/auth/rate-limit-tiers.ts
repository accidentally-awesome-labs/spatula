export interface RateLimitTier {
  name: string;
  requestsPerMinute: number;
  maxConcurrentJobs: number;
}

export const RATE_LIMIT_TIERS: Record<string, RateLimitTier> = {
  free: { name: 'free', requestsPerMinute: 60, maxConcurrentJobs: 2 },
  standard: { name: 'standard', requestsPerMinute: 300, maxConcurrentJobs: 10 },
  enterprise: { name: 'enterprise', requestsPerMinute: 1500, maxConcurrentJobs: 50 },
  unlimited: { name: 'unlimited', requestsPerMinute: Infinity, maxConcurrentJobs: Infinity },
};
