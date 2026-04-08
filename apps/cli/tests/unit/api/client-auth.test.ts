// apps/cli/tests/unit/api/client-auth.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
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
