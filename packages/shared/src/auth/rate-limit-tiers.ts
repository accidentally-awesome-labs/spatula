// packages/shared/src/auth/rate-limit-tiers.ts
// Per-route rate limits are configured via config/rate-limits.yaml in Phase 16.
// Until then, a single default limit applies to all authenticated routes.

export interface RateLimitConfig {
  requestsPerMinute: number;
  maxConcurrentJobs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  requestsPerMinute: 300,
  maxConcurrentJobs: 10,
};
