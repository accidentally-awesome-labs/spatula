/**
 * SDK integration test: version-probe end-to-end.
 *
 * Exercises the lazy `/.well-known/spatula-version` probe flow:
 *   - First request fires the probe + the actual request (2 fetches)
 *   - Second request fires ONLY the actual request (probe verdict cached)
 *   - skipVersionProbe option suppresses the probe entirely
 *
 * Mocked by default; live-mode via SPATULA_LIVE_LLM=1.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listJobs, SpatulaClient, VersionProbe } from '../../src/index.js';

const LIVE = process.env.SPATULA_LIVE_LLM === '1';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('integration: version-probe', () => {
  it.skipIf(LIVE)('mocked: probe fires once then is cached for subsequent requests', async () => {
    const calls: string[] = [];

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);

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
        return new Response(
          JSON.stringify({ data: [], hasMore: false }),
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

    await listJobs(client);
    await listJobs(client);
    await listJobs(client);

    // 1 probe + 3 list calls
    expect(calls.length).toBe(4);
    expect(calls[0]).toContain('/.well-known/spatula-version');
    expect(calls.filter((c) => c.includes('/.well-known/')).length).toBe(1);
    expect(calls.filter((c) => c.includes('/api/v1/jobs')).length).toBe(3);
  });

  it.skipIf(LIVE)('mocked: skipVersionProbe=true suppresses the probe entirely', async () => {
    const calls: string[] = [];

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      return new Response(
        JSON.stringify({ data: [], hasMore: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = new SpatulaClient({
      baseUrl: 'http://localhost:0',
      apiKey: 'sk_test_mock',
      fetch: fetchMock as unknown as typeof fetch,
      skipVersionProbe: true,
    });

    await listJobs(client);
    await listJobs(client);

    expect(calls.length).toBe(2);
    expect(calls.filter((c) => c.includes('/.well-known/')).length).toBe(0);
  });

  it.skipIf(LIVE)('mocked: 404 from /.well-known degrades gracefully (no throw)', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/.well-known/spatula-version')) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response(
        JSON.stringify({ data: [], hasMore: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const probe = new VersionProbe({
      baseUrl: 'http://localhost:0',
      fetcher: fetchMock as unknown as typeof fetch,
      sdkMajor: 0,
    });

    // Should NOT throw — non-Spatula servers and older releases that don't
    // expose /.well-known degrade gracefully.
    await expect(probe.ensure()).resolves.toBeUndefined();
  });

  it.skipIf(!LIVE)('live (SPATULA_LIVE_LLM=1): probe completes against a real /.well-known endpoint', async () => {
    const baseUrl = process.env.SPATULA_BASE_URL ?? 'http://localhost:3000';
    const probe = new VersionProbe({
      baseUrl,
      fetcher: globalThis.fetch,
      sdkMajor: 0,
    });
    // Doesn't throw against a live server with /.well-known/spatula-version
    await expect(probe.ensure()).resolves.toBeUndefined();
  });
});
