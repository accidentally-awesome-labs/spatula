// packages/shared/src/auth/rate-limit-tiers.ts
// Per-route rate limits are configured via config/rate-limits.yaml.
// A single default limit applies to unmatched authenticated routes.

export interface RateLimitConfig {
  requestsPerMinute: number;
  maxConcurrentJobs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  requestsPerMinute: 300,
  maxConcurrentJobs: 10,
};
