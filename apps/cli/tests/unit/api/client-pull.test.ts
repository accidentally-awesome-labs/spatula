import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpatulaApiClient, ApiError } from '../../../src/api/client.js';

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

    it('network error throws ApiError with status 0 and NETWORK_ERROR code', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

      await expect(client.getEntitiesStreamPaginated('job-1', {})).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(0);
        expect(apiErr.code).toBe('NETWORK_ERROR');
        expect(apiErr.message).toBe('Failed to fetch');
        return true;
      });
    });

    it('HTTP 401 throws ApiError with status 401', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);

      await expect(client.getEntitiesStreamPaginated('job-1', {})).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(401);
        return true;
      });
    });

    it('HTTP 500 with empty body throws ApiError with generic message', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new SyntaxError('Unexpected end of JSON')),
      }));

      await expect(client.getEntitiesStreamPaginated('job-1', {})).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(500);
        expect(apiErr.message).toBe('HTTP 500');
        return true;
      });
    });

    it('no pagination key in response does not crash', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({ data: [{ id: 'e1' }] });

      const result = await client.getEntitiesStreamPaginated('job-1', {});
      expect(result.data).toHaveLength(1);
      expect(result.pagination).toBeUndefined();
    });
  });

  describe('getExtractionsStreamPaginated', () => {
    it('returns data with pagination envelope', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({
        data: [{ id: 'ext1', url: 'https://example.com' }],
        pagination: { nextCursor: undefined, hasMore: false, total: 1 },
      });

      const result = await client.getExtractionsStreamPaginated('job1');
      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.hasMore).toBe(false);
    });

    it('hits the extractions endpoint', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({ data: [], pagination: { hasMore: false, total: 0 } });

      await client.getExtractionsStreamPaginated('job1', { cursor: 'c1', limit: 50 });

      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('/jobs/job1/extractions');
      expect(url).toContain('cursor=c1');
      expect(url).toContain('limit=50');
    });

    it('network error throws ApiError with NETWORK_ERROR code', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

      await expect(client.getExtractionsStreamPaginated('job1')).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(0);
        expect(apiErr.code).toBe('NETWORK_ERROR');
        return true;
      });
    });
  });

  describe('getActionsStreamPaginated', () => {
    it('returns data with pagination envelope', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({
        data: [{ id: 'act1', type: 'add_field' }],
        pagination: { nextCursor: 'next1', hasMore: true, total: 10 },
      });

      const result = await client.getActionsStreamPaginated('job1');
      expect(result.data).toHaveLength(1);
      expect(result.pagination.nextCursor).toBe('next1');
      expect(result.pagination.hasMore).toBe(true);
    });

    it('hits the actions endpoint', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({ data: [], pagination: { hasMore: false, total: 0 } });

      await client.getActionsStreamPaginated('job1', { since: '2026-04-01T00:00:00Z', limit: 100 });

      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('/jobs/job1/actions');
      expect(url).toContain('since=');
      expect(url).toContain('limit=100');
    });

    it('HTTP 403 throws ApiError with status 403', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);

      await expect(client.getActionsStreamPaginated('job1')).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(403);
        expect(apiErr.code).toBe('FORBIDDEN');
        return true;
      });
    });
  });

  describe('getEntitySourcesStreamPaginated', () => {
    it('returns data with pagination envelope', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({
        data: [{ entityId: 'e1', url: 'https://example.com/page' }],
        pagination: { hasMore: false, total: 1 },
      });

      const result = await client.getEntitySourcesStreamPaginated('job1');
      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
    });

    it('hits the entity-sources endpoint', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({ data: [], pagination: { hasMore: false, total: 0 } });

      await client.getEntitySourcesStreamPaginated('job1', { cursor: 'cur-x' });

      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('/jobs/job1/entity-sources');
      expect(url).toContain('cursor=cur-x');
    });

    it('HTTP 500 with empty body throws ApiError with generic message', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new SyntaxError('Unexpected end of JSON')),
      }));

      await expect(client.getEntitySourcesStreamPaginated('job1')).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(500);
        expect(apiErr.message).toBe('HTTP 500');
        return true;
      });
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

    it('HTTP error throws ApiError', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({ error: { code: 'INTERNAL_ERROR', message: 'Server error' } }, 500);

      await expect(client.getUsage()).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(500);
        return true;
      });
    });
  });
});
