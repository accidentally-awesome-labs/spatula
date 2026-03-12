import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpatulaApiClient } from '../../../src/api/client.js';
import { runListCommand, formatJobsTable } from '../../../src/commands/list.js';

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
const TENANT_ID = 'tenant-list-test';

describe('runListCommand', () => {
  let client: SpatulaApiClient;

  beforeEach(() => {
    client = new SpatulaApiClient(BASE_URL, TENANT_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls API and returns jobs', async () => {
    const jobs = [
      { id: 'job-1', name: 'Scrape A', status: 'running' },
      { id: 'job-2', name: 'Scrape B', status: 'completed' },
    ];
    mockFetchOk(jobs);

    const result = await runListCommand(client, {});

    expect(result).toEqual(jobs);

    const { url, init } = lastFetchCall();
    expect(url).toBe(`${BASE_URL}/api/v1/jobs`);
    expect(init.method).toBe('GET');
  });

  it('passes status filter in query string', async () => {
    mockFetchOk([]);

    await runListCommand(client, { status: 'running' });

    const { url } = lastFetchCall();
    expect(url).toContain('status=running');
  });

  it('passes limit in query string', async () => {
    mockFetchOk([]);

    await runListCommand(client, { limit: 5 });

    const { url } = lastFetchCall();
    expect(url).toContain('limit=5');
  });

  it('passes both status and limit', async () => {
    mockFetchOk([]);

    await runListCommand(client, { status: 'completed', limit: 10 });

    const { url } = lastFetchCall();
    expect(url).toContain('status=completed');
    expect(url).toContain('limit=10');
  });
});

describe('formatJobsTable', () => {
  it('returns "No jobs found." for empty list', () => {
    const result = formatJobsTable([]);
    expect(result).toBe('No jobs found.');
  });

  it('formats jobs into a text table with ID, Name, Status columns', () => {
    const jobs = [
      { id: 'job-1', name: 'Scrape Products', status: 'running' },
      { id: 'job-2', name: 'Scrape Reviews', status: 'completed' },
    ];
    const result = formatJobsTable(jobs);

    // Should contain headers
    expect(result).toContain('ID');
    expect(result).toContain('Name');
    expect(result).toContain('Status');

    // Should contain job data
    expect(result).toContain('job-1');
    expect(result).toContain('Scrape Products');
    expect(result).toContain('running');
    expect(result).toContain('job-2');
    expect(result).toContain('Scrape Reviews');
    expect(result).toContain('completed');
  });

  it('handles missing fields gracefully', () => {
    const jobs = [{ id: 'job-1' }];
    const result = formatJobsTable(jobs);

    expect(result).toContain('job-1');
    // Should not throw — missing name and status are rendered as empty or dash
  });
});
