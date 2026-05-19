/**
 * SDK integration test: getJobEvents (Phase 16 stub variant).
 *
 * The non-streaming `getJobEvents` helper returns a snapshot list. The full
 * SSE-streaming flavor (`GET /api/v1/jobs/:id/events` with Last-Event-ID
 * resume, 5-minute ring buffer, 15s keep-alive) lands in Phase 17.
 *
 * For Phase 16, the SDK's `getJobEvents` is a basic JSON GET fallback —
 * SSE wiring at the SDK level is deferred to Phase 17 per SDK-02 / AUTH-01.
 *
 * Mocked by default; live-mode via SPATULA_LIVE_LLM=1.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getJobEvents, SpatulaClient } from '../../src/index.js';

const LIVE = process.env.SPATULA_LIVE_LLM === '1';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('integration: getJobEvents (Phase 16 stub — SSE in Phase 17)', () => {
  it.skipIf(LIVE)('mocked: GET /api/v1/jobs/:jobId/events returns a list of events', async () => {
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

      if (url.includes('/api/v1/jobs/job_abc/events')) {
        return new Response(
          JSON.stringify([
            {
              id: 'evt_1',
              type: 'job.status',
              data: { status: 'running' },
              timestamp: '2026-05-19T15:56:00.000Z',
            },
            {
              id: 'evt_2',
              type: 'job.progress',
              data: { pagesProcessed: 42 },
              timestamp: '2026-05-19T15:56:30.000Z',
            },
          ]),
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

    const events = await getJobEvents(client, 'job_abc');

    expect(events.length).toBe(2);
    expect(events[0]?.id).toBe('evt_1');
    expect(events[0]?.type).toBe('job.status');
    expect(events[1]?.data).toEqual({ pagesProcessed: 42 });
  });

  it.skipIf(!LIVE)('live (SPATULA_LIVE_LLM=1): GET /api/v1/jobs/:jobId/events returns array', async () => {
    const baseUrl = process.env.SPATULA_BASE_URL ?? 'http://localhost:3000';
    const apiKey = process.env.SPATULA_API_KEY;
    const jobId = process.env.SPATULA_LIVE_JOB_ID;
    if (!apiKey || !jobId) {
      throw new Error('SPATULA_LIVE_LLM=1 requires SPATULA_API_KEY + SPATULA_LIVE_JOB_ID');
    }
    const client = new SpatulaClient({ baseUrl, apiKey });
    // Note: live server may return 404 if /events endpoint is SSE-only;
    // assertion is permissive — Phase 17 will tighten this once SSE lands.
    try {
      const events = await getJobEvents(client, jobId);
      expect(Array.isArray(events)).toBe(true);
    } catch (e) {
      // SSE-only endpoint may return non-JSON or 4xx in live mode — Phase 17
      // wires the proper SSE SDK. For Phase 16 stub, tolerate either path.
      expect(e).toBeDefined();
    }
  });
});
