import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpatulaApiClient } from '../../../src/api/client.js';

function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  );
}

describe('SpatulaApiClient pull methods', () => {
  afterEach(() => vi.restoreAllMocks());

  describe('getEntitiesStreamPaginated', () => {
    it('returns data and pagination from cursor endpoint', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({
        data: [{ id: 'e1', mergedData: { name: 'A' } }],
        pagination: { nextCursor: 'abc123', hasMore: true, total: 100 },
      });

      const result = await client.getEntitiesStreamPaginated('job-1', { limit: 500 });
      expect(result.data).toHaveLength(1);
      expect(result.pagination.nextCursor).toBe('abc123');
      expect(result.pagination.hasMore).toBe(true);
      expect(result.pagination.total).toBe(100);
    });

    it('passes cursor and since as query params', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({ data: [], pagination: { hasMore: false, total: 0 } });

      await client.getEntitiesStreamPaginated('job-1', {
        cursor: 'cur-1',
        since: '2026-04-01T00:00:00Z',
        limit: 100,
      });

      const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const url = fetchCall[0] as string;
      expect(url).toContain('cursor=cur-1');
      expect(url).toContain('since=');
      expect(url).toContain('limit=100');
    });
  });

  describe('getUsage', () => {
    it('fetches tenant usage summary', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1', { apiKey: 'sk_test' });
      mockFetch({
        data: {
          period: { start: '2026-03-01', end: '2026-04-01' },
          totalTokens: 50000,
          totalCostUsd: 1.5,
          byModel: {},
          byPurpose: {},
          byJob: [{ jobId: 'j1', tokens: 50000, costUsd: 1.5 }],
        },
      });

      const result = await client.getUsage({ period: '30d' });
      expect(result.totalTokens).toBe(50000);
      expect(result.byJob).toHaveLength(1);
    });

    it('defaults to 30d period', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({ data: { totalTokens: 0, totalCostUsd: 0, byModel: {}, byPurpose: {}, byJob: [], period: {} } });

      await client.getUsage();
      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('period=30d');
    });
  });
});
