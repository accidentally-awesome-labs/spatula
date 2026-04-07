export interface RateLimitTier {
  name: string;
  requestsPerMinute: number;
  maxConcurrentJobs: number;
}

export const RATE_LIMIT_TIERS: Record<string, RateLimitTier> = {
  free: { name: 'free', requestsPerMinute: 60, maxConcurrentJobs: 2 },
  starter: { name: 'starter', requestsPerMinute: 300, maxConcurrentJobs: 10 },
  pro: { name: 'pro', requestsPerMinute: 1500, maxConcurrentJobs: 50 },
  enterprise: { name: 'enterprise', requestsPerMinute: Infinity, maxConcurrentJobs: Infinity },
};
