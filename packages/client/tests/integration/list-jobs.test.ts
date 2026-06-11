/**
 * SDK integration test: listJobs.
 *
 * Exercises cursor-paginated listing per API-04. Mocked by default; live-mode
 * via SPATULA_LIVE_LLM=1.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listJobs, SpatulaClient } from '../../src/index.js';

const LIVE = process.env.SPATULA_LIVE_LLM === '1';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('integration: listJobs', () => {
  it.skipIf(LIVE)('mocked: GET /api/v1/jobs returns cursor envelope', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/.well-known/spatula-version')) {
        return new Response(
          JSON.stringify({
            version: '0.0.0-dev',
            gitSha: 'unknown',
            buildAt: new Date().toISOString(),
            supportMatrix: { minClientMajor: 0, deprecatedClientMajors: [] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.includes('/api/v1/jobs')) {
        // Confirm query-string handling
        const u = new URL(url);
        expect(u.searchParams.get('limit')).toBe('25');
        expect(u.searchParams.get('cursor')).toBe('cur_seed');
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'job_1',
                tenantId: 'tnt_a',
                name: 'a',
                status: 'completed',
                createdAt: '2026-05-19T15:50:00.000Z',
              },
              {
                id: 'job_2',
                tenantId: 'tnt_a',
                name: 'b',
                status: 'running',
                createdAt: '2026-05-19T15:51:00.000Z',
              },
            ],
            nextCursor: 'cur_next',
            hasMore: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      return new Response('Not Found', { status: 404 });
    });

    const client = new SpatulaClient({
      baseUrl: 'http://localhost:0',
      apiKey: 'sk_test_mock',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await listJobs(client, { cursor: 'cur_seed', limit: 25 });

    expect(result.data.length).toBe(2);
    expect(result.data[0]?.id).toBe('job_1');
    expect(result.nextCursor).toBe('cur_next');
    expect(result.hasMore).toBe(true);
  });

  it.skipIf(!LIVE)('live (SPATULA_LIVE_LLM=1): GET /api/v1/jobs returns a list', async () => {
    const baseUrl = process.env.SPATULA_BASE_URL ?? 'http://localhost:3000';
    const apiKey = process.env.SPATULA_API_KEY;
    if (!apiKey) {
      throw new Error('SPATULA_LIVE_LLM=1 requires SPATULA_API_KEY in the env');
    }
    const client = new SpatulaClient({ baseUrl, apiKey });
    const result = await listJobs(client, { limit: 5 });
    expect(Array.isArray(result.data)).toBe(true);
    expect(typeof result.hasMore).toBe('boolean');
  });
});
