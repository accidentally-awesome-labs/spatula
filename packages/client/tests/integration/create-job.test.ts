/**
 * SDK integration test: createJob.
 *
 * Hits the createJob path via the SDK; mocked by default; live mode opt-in via
 * SPATULA_LIVE_LLM=1.
 *
 * In MOCKED mode (default), the test installs a fetch mock that returns the
 * envelope-shaped success/error responses the server emits. This exercises:
 *   - createJob(client, input) → request shape (method, path, body)
 *   - version-probe behavior (the probe fires before request, so the mock
 *     must serve /.well-known/spatula-version too)
 *   - response parsing (the SDK returns a JS object matching CreateJobResult)
 *
 * In LIVE mode (SPATULA_LIVE_LLM=1), the test points at SPATULA_BASE_URL +
 * SPATULA_API_KEY and exercises the real path. Skipped in CI by default;
 * runs only on explicit live-LLM jobs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createJob, SpatulaClient } from '../../src/index.js';

const LIVE = process.env.SPATULA_LIVE_LLM === '1';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('integration: createJob', () => {
  it.skipIf(LIVE)('mocked: POST /api/v1/jobs returns the parsed job envelope', async () => {
    const seenRequests: { url: string; method: string; body: unknown }[] = [];

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: unknown = null;
      if (init?.body && typeof init.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      seenRequests.push({ url, method, body });

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

      if (url.endsWith('/api/v1/jobs') && method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'job_abc',
            tenantId: 'tnt_xyz',
            name: 'integration-test',
            status: 'pending',
            createdAt: '2026-05-19T15:50:00.000Z',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }

      return new Response('Not Found', { status: 404 });
    });

    const client = new SpatulaClient({
      baseUrl: 'http://localhost:0',
      apiKey: 'sk_test_mock',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await createJob(client, {
      name: 'integration-test',
      seedUrls: ['https://example.com'],
    });

    expect(result.id).toBe('job_abc');
    expect(result.tenantId).toBe('tnt_xyz');
    expect(result.name).toBe('integration-test');
    expect(result.status).toBe('pending');
    expect(typeof result.createdAt).toBe('string');

    // Version probe + actual POST both fired
    expect(seenRequests.length).toBe(2);
    expect(seenRequests[0]?.url).toContain('/.well-known/spatula-version');
    expect(seenRequests[1]?.method).toBe('POST');
    expect(seenRequests[1]?.url).toContain('/api/v1/jobs');
    expect((seenRequests[1]?.body as { name: string }).name).toBe('integration-test');
  });

  it.skipIf(!LIVE)(
    'live (SPATULA_LIVE_LLM=1): POST /api/v1/jobs against a real server',
    async () => {
      const baseUrl = process.env.SPATULA_BASE_URL ?? 'http://localhost:3000';
      const apiKey = process.env.SPATULA_API_KEY;
      if (!apiKey) {
        throw new Error('SPATULA_LIVE_LLM=1 requires SPATULA_API_KEY in the env');
      }
      const client = new SpatulaClient({ baseUrl, apiKey });
      const result = await createJob(client, {
        name: `live-integration-${Date.now()}`,
        seedUrls: ['https://example.com'],
      });
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);
    },
  );
});
