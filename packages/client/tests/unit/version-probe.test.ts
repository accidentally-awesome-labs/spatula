/**
 * Phase 16 plan 16-3 Task 3 — tests for the lazy version probe (D-12).
 *
 * Test cases cover (per <behavior>):
 *   1. probe.ensure() does NOT throw when server version's major matches the SDK major.
 *   2. probe.ensure() throws SpatulaVersionMismatchError when server major !== SDK major.
 *   3. Two sequential SpatulaClient.request() calls trigger ONE probe fetch (caching).
 *   4. On version-mismatch (verdict), the rejected promise is cached — the
 *      second .ensure() re-throws WITHOUT making another fetch.
 *   5. On transient transport error, probePromise is reset — the second .ensure()
 *      retries (issues a second fetch).
 *   6. 404 from /.well-known is treated as "unknown server" — does NOT throw.
 *   7. Constructor with skipVersionProbe: true does NOT call fetcher on request().
 *   8. SpatulaClient constructor performs ZERO I/O (Anti-Pattern protection).
 *   9. request() awaits probe.ensure() BEFORE the actual API fetch (call order).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VersionProbe } from '../../src/version-probe.js';
import { SpatulaClient } from '../../src/client.js';
import { SpatulaVersionMismatchError } from '../../src/errors/base.js';

function mkProbeResponse(version: string) {
  return new Response(
    JSON.stringify({
      version,
      gitSha: 'abcd1234',
      buildAt: '2026-05-19T14:32:00.000Z',
      supportMatrix: { minClientMajor: 0, deprecatedClientMajors: [] },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('Phase 16 plan 16-3 Task 3: VersionProbe (D-12 — lazy version probe)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('does NOT throw when server major matches SDK major', async () => {
    fetchMock.mockImplementation(() => mkProbeResponse('0.4.2'));
    const probe = new VersionProbe({
      baseUrl: 'https://api.example.com',
      fetcher: fetchMock as unknown as typeof fetch,
      sdkMajor: 0,
    });
    await expect(probe.ensure()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.example.com/.well-known/spatula-version',
    );
  });

  it('throws SpatulaVersionMismatchError when server major !== SDK major', async () => {
    fetchMock.mockImplementation(() => mkProbeResponse('1.0.0'));
    const probe = new VersionProbe({
      baseUrl: 'https://api.example.com',
      fetcher: fetchMock as unknown as typeof fetch,
      sdkMajor: 0,
    });
    await expect(probe.ensure()).rejects.toBeInstanceOf(SpatulaVersionMismatchError);
  });

  it('caches the verdict — two .ensure() calls when mismatched throw the SAME error and only ONE fetch fires', async () => {
    fetchMock.mockImplementation(() => mkProbeResponse('1.0.0'));
    const probe = new VersionProbe({
      baseUrl: 'https://api.example.com',
      fetcher: fetchMock as unknown as typeof fetch,
      sdkMajor: 0,
    });

    const err1 = await probe.ensure().catch((e) => e);
    const err2 = await probe.ensure().catch((e) => e);

    expect(err1).toBeInstanceOf(SpatulaVersionMismatchError);
    expect(err2).toBeInstanceOf(SpatulaVersionMismatchError);
    expect(fetchMock.mock.calls.length).toBe(1); // verdict cached
  });

  it('on transient transport error, probePromise is reset — second .ensure() retries (2 fetches)', async () => {
    // First call: fetcher rejects (transport error).
    // Second call: succeeds with matching major.
    fetchMock
      .mockImplementationOnce(() => {
        throw new TypeError('network blip');
      })
      .mockImplementationOnce(() => mkProbeResponse('0.5.0'));

    const probe = new VersionProbe({
      baseUrl: 'https://api.example.com',
      fetcher: fetchMock as unknown as typeof fetch,
      sdkMajor: 0,
    });

    await expect(probe.ensure()).rejects.toBeInstanceOf(TypeError);
    await expect(probe.ensure()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.length).toBe(2); // retry actually happened
  });

  it('treats 404 from /.well-known as "unknown server" — does NOT throw', async () => {
    fetchMock.mockImplementation(
      () => new Response('not found', { status: 404 }),
    );
    const probe = new VersionProbe({
      baseUrl: 'https://api.example.com',
      fetcher: fetchMock as unknown as typeof fetch,
      sdkMajor: 0,
    });
    await expect(probe.ensure()).resolves.toBeUndefined();
  });

  it('treats unparseable body as "unknown server" — does NOT throw', async () => {
    fetchMock.mockImplementation(
      () =>
        new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const probe = new VersionProbe({
      baseUrl: 'https://api.example.com',
      fetcher: fetchMock as unknown as typeof fetch,
      sdkMajor: 0,
    });
    await expect(probe.ensure()).resolves.toBeUndefined();
  });

  it('treats malformed version string (non-semver) as "unknown server" — does NOT throw', async () => {
    fetchMock.mockImplementation(
      () =>
        new Response(JSON.stringify({ version: 'not-a-version' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const probe = new VersionProbe({
      baseUrl: 'https://api.example.com',
      fetcher: fetchMock as unknown as typeof fetch,
      sdkMajor: 0,
    });
    await expect(probe.ensure()).resolves.toBeUndefined();
  });
});

describe('Phase 16 plan 16-3 Task 3: SpatulaClient wired to VersionProbe', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('constructor performs ZERO I/O (Anti-Pattern Constructor I/O protection — D-12)', () => {
    const _client = new SpatulaClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    // No fetches before any request() call.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('request() awaits probe.ensure() BEFORE the actual API fetch (call order)', async () => {
    // First call to fetcher = probe; second = actual request.
    fetchMock
      .mockImplementationOnce(() => mkProbeResponse('0.1.0'))
      .mockImplementationOnce(
        () =>
          new Response(JSON.stringify({ id: 'job-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );

    const client = new SpatulaClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.request<{ id: string }>('GET', '/api/v1/jobs/job-1');

    expect(result).toEqual({ id: 'job-1' });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.example.com/.well-known/spatula-version',
    );
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/api/v1/jobs/job-1');
  });

  it('two sequential request() calls trigger the probe ONLY ONCE (probe cache)', async () => {
    // probe once + 2 API requests
    fetchMock
      .mockImplementationOnce(() => mkProbeResponse('0.1.0'))
      .mockImplementation(
        () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );

    const client = new SpatulaClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.request('GET', '/api/v1/jobs');
    await client.request('GET', '/api/v1/jobs');

    // probe fetched once, then 2 API fetches.
    expect(fetchMock.mock.calls.length).toBe(3);
    expect(fetchMock.mock.calls[0][0]).toContain('/.well-known/');
    expect(fetchMock.mock.calls[1][0]).not.toContain('/.well-known/');
    expect(fetchMock.mock.calls[2][0]).not.toContain('/.well-known/');
  });

  it('skipVersionProbe: true bypasses the probe entirely', async () => {
    fetchMock.mockImplementation(
      () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const client = new SpatulaClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
      skipVersionProbe: true,
    });
    await client.request('GET', '/api/v1/jobs');
    await client.request('GET', '/api/v1/jobs');

    // No /.well-known/ in any call.
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).not.toContain('/.well-known/');
    }
    // Only 2 fetches (the requests) — no probe.
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('major mismatch is surfaced from request() — never reaches the API endpoint', async () => {
    // First call = probe response with mismatched major.
    fetchMock.mockImplementationOnce(() => mkProbeResponse('1.0.0'));

    const client = new SpatulaClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.request('GET', '/api/v1/jobs')).rejects.toBeInstanceOf(
      SpatulaVersionMismatchError,
    );
    // Only the probe was fetched. The API call never fired.
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/.well-known/spatula-version');
  });

  it('verdict is sticky — second request() after a mismatch still throws with only one probe fetch', async () => {
    fetchMock.mockImplementationOnce(() => mkProbeResponse('1.0.0'));

    const client = new SpatulaClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.request('GET', '/api/v1/a')).rejects.toBeInstanceOf(
      SpatulaVersionMismatchError,
    );
    await expect(client.request('GET', '/api/v1/b')).rejects.toBeInstanceOf(
      SpatulaVersionMismatchError,
    );

    // Probe fetched exactly once across two mismatched requests.
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});
