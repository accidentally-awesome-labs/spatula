/**
 * SDK integration test: getEntities.
 *
 * Exercises cursor-paginated entity listing and provenance shape. Mocked by
 * default; live-mode via SPATULA_LIVE_LLM=1.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getEntities, SpatulaClient } from '../../src/index.js';

const LIVE = process.env.SPATULA_LIVE_LLM === '1';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('integration: getEntities', () => {
  it.skipIf(LIVE)('mocked: GET /api/v1/jobs/:jobId/entities returns cursor envelope', async () => {
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

      if (url.includes('/api/v1/jobs/job_abc/entities')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'ent_1',
                jobId: 'job_abc',
                tenantId: 'tnt_a',
                mergedData: { title: 'Demo Entity', price: 9.99 },
                categories: ['product'],
                qualityScore: 0.92,
                sourceCount: 3,
                createdAt: '2026-05-19T15:55:00.000Z',
              },
            ],
            nextCursor: undefined,
            hasMore: false,
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

    const result = await getEntities(client, 'job_abc');

    expect(result.data.length).toBe(1);
    const entity = result.data[0];
    expect(entity?.id).toBe('ent_1');
    expect(entity?.jobId).toBe('job_abc');
    expect(entity?.mergedData).toEqual({ title: 'Demo Entity', price: 9.99 });
    expect(entity?.categories).toContain('product');
    expect(entity?.qualityScore).toBeGreaterThan(0.9);
    expect(result.hasMore).toBe(false);
  });

  it.skipIf(!LIVE)(
    'live (SPATULA_LIVE_LLM=1): GET /api/v1/jobs/:jobId/entities returns cursor envelope',
    async () => {
      const baseUrl = process.env.SPATULA_BASE_URL ?? 'http://localhost:3000';
      const apiKey = process.env.SPATULA_API_KEY;
      const jobId = process.env.SPATULA_LIVE_JOB_ID;
      if (!apiKey || !jobId) {
        throw new Error('SPATULA_LIVE_LLM=1 requires SPATULA_API_KEY + SPATULA_LIVE_JOB_ID');
      }
      const client = new SpatulaClient({ baseUrl, apiKey });
      const result = await getEntities(client, jobId, { limit: 10 });
      expect(Array.isArray(result.data)).toBe(true);
    },
  );
});
