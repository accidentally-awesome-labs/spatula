import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpatulaApiClient } from '../../../src/api/client.js';
import {
  runStatusCommand,
  formatJobDetail,
} from '../../../src/commands/status.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchOk(data: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data }),
    }),
  );
}

function lastFetchCall(): { url: string; init: RequestInit } {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  const last = calls[calls.length - 1];
  return { url: last[0] as string, init: last[1] as RequestInit };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const BASE_URL = 'http://localhost:3000';
const TENANT_ID = 'tenant-status-test';

describe('runStatusCommand', () => {
  let client: SpatulaApiClient;

  beforeEach(() => {
    client = new SpatulaApiClient(BASE_URL, TENANT_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches and returns job details', async () => {
    const job = {
      id: 'job-abc',
      name: 'Product Scraper',
      status: 'running',
      pagesDiscovered: 150,
      pagesCompleted: 42,
      entitiesExtracted: 20,
    };
    mockFetchOk(job);

    const result = await runStatusCommand(client, 'job-abc');

    expect(result).toEqual(job);

    const { url, init } = lastFetchCall();
    expect(url).toBe(`${BASE_URL}/api/v1/jobs/job-abc`);
    expect(init.method).toBe('GET');
  });
});

describe('formatJobDetail', () => {
  it('displays name, ID, status, and stats', () => {
    const job = {
      id: 'job-abc',
      name: 'Product Scraper',
      status: 'running',
      pagesDiscovered: 150,
      pagesCompleted: 42,
      entitiesExtracted: 20,
    };

    const result = formatJobDetail(job);

    expect(result).toContain('Product Scraper');
    expect(result).toContain('job-abc');
    expect(result).toContain('running');
    expect(result).toContain('150');
    expect(result).toContain('42');
    expect(result).toContain('20');
  });

  it('handles missing stats gracefully', () => {
    const job = {
      id: 'job-xyz',
      name: 'Simple Job',
      status: 'created',
    };

    const result = formatJobDetail(job);

    expect(result).toContain('Simple Job');
    expect(result).toContain('job-xyz');
    expect(result).toContain('created');
    // Should not throw for missing stats
  });
});
