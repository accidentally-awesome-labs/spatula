import { describe, it, expect } from 'vitest';

// Test the backoff strategy independently (extracted from createWebhookWorker)
const BACKOFF_DELAYS = [60_000, 300_000, 1_800_000];

function backoffStrategy(attemptsMade: number): number {
  return BACKOFF_DELAYS[Math.min(attemptsMade, BACKOFF_DELAYS.length - 1)];
}

describe('Webhook Worker', () => {
  describe('backoff strategy', () => {
    it('returns 60s for first retry (attempt 0)', () => {
      expect(backoffStrategy(0)).toBe(60_000);
    });

    it('returns 5min for second retry (attempt 1)', () => {
      expect(backoffStrategy(1)).toBe(300_000);
    });

    it('returns 30min for third retry (attempt 2)', () => {
      expect(backoffStrategy(2)).toBe(1_800_000);
    });

    it('caps at 30min for attempts beyond 3', () => {
      expect(backoffStrategy(5)).toBe(1_800_000);
      expect(backoffStrategy(10)).toBe(1_800_000);
    });
  });
});
