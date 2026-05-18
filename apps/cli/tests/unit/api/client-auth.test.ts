// apps/cli/tests/unit/api/client-auth.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { SpatulaApiClient } from '../../../src/api/client.js';

function mockFetchOk(data: unknown = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data }),
    }),
  );
}

function lastFetchHeaders(): Record<string, string> {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  return (calls[calls.length - 1][1] as RequestInit).headers as Record<string, string>;
}

afterEach(() => vi.restoreAllMocks());

describe('SpatulaApiClient auth', () => {
  it('does NOT send Authorization header when no apiKey', async () => {
    mockFetchOk([]);
    const client = new SpatulaApiClient('http://localhost:3000', 'tenant-1');
    await client.listJobs();
    const headers = lastFetchHeaders();
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers['x-tenant-id']).toBe('tenant-1');
  });

  it('sends Authorization header when apiKey is provided', async () => {
    mockFetchOk([]);
    const client = new SpatulaApiClient('http://localhost:3000', 'tenant-1', {
      apiKey: 'sk_test_abc123',
    });
    await client.listJobs();
    const headers = lastFetchHeaders();
    expect(headers.Authorization).toBe('Bearer sk_test_abc123');
    expect(headers['x-tenant-id']).toBe('tenant-1');
  });
});

describe('SpatulaApiClient new methods', () => {
  let client: SpatulaApiClient;

  beforeEach(() => {
    client = new SpatulaApiClient('http://localhost:3000', 'tenant-1', {
      apiKey: 'sk_test_key',
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('getAuthMe calls GET /api/v1/auth/me and returns raw body (no data unwrap)', async () => {
    const me = {
      tenantId: 'tenant-1',
      scopes: ['jobs:read', 'jobs:write'],
      subject: 'user-1',
      authenticated: true,
    };
    // /api/v1/auth/me returns the fields at the top level (not wrapped in { data })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(me),
      }),
    );
    const result = await client.getAuthMe();
    expect(result).toEqual(me);
    expect(result.tenantId).toBe('tenant-1');
    expect(Array.isArray(result.scopes)).toBe(true);
    expect(result.authenticated).toBe(true);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain('/api/v1/auth/me');
    expect((calls[0][1] as RequestInit).method).toBe('GET');
  });

  it('getEntitiesStream calls entities endpoint with cursor/since params', async () => {
    mockFetchOk({ data: [], cursor: null });
    await client.getEntitiesStream('job-1', { cursor: 'abc', since: '2026-01-01', limit: 200 });
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const url = calls[0][0] as string;
    expect(url).toContain('/api/v1/jobs/job-1/entities');
    expect(url).toContain('cursor=abc');
    expect(url).toContain('since=2026-01-01');
    expect(url).toContain('limit=200');
  });

  it('getWsToken calls POST /api/v1/ws-token', async () => {
    mockFetchOk({ token: 'tok_abc', expiresIn: 60 });
    const result = await client.getWsToken();
    expect(result).toEqual({ token: 'tok_abc', expiresIn: 60 });
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain('/api/v1/ws-token');
    expect((calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('getHealth calls GET /health', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 'ok' }),
      }),
    );
    const result = await client.getHealth();
    expect(result).toEqual({ status: 'ok' });
  });
});
