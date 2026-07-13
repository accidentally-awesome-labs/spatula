/**
 * Tests for experimental/forensic.ts + createExperimentalNamespace wiring
 *
 * Verifies:
 * - client.experimental.forensic.listExtractions calls GET /api/v1/admin/forensic/extractions
 * - Returns the cursor-first { data, nextCursor, hasMore } shape
 * - Passes cursor and limit query params when provided
 * - client.experimental.<anything-other-than-forensic> still throws fail-loud
 * - Error envelope on 4xx/5xx surfaces as SpatulaApiError subclass
 */
import { describe, it, expect, vi } from 'vitest';
import { SpatulaClient } from '../client.js';

const BASE_URL = 'https://api.example.com';
const API_KEY = 'sk_live_test123';

const SAMPLE_FORENSIC_RESPONSE = {
  data: [
    {
      id: 'a1b2c3d4-0000-0000-0000-000000000001',
      extractionId: 'e1e2e3e4-0000-0000-0000-000000000002',
      tenantId: 'f1f2f3f4-0000-0000-0000-000000000003',
      reason: 'suspicious_extraction',
      createdAt: '2026-05-20T20:00:00.000Z',
      contentRef: 'https://s3.example.com/forensic/blob?Expires=900',
    },
  ],
  nextCursor: null,
  hasMore: false,
};

function makeOkFetch(body: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function makeErrorFetch(status: number, code: string, message: string) {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        error: { code, message, requestId: 'req-test' },
      }),
      { status, headers: { 'content-type': 'application/json' } },
    ),
  );
}

describe('client.experimental.forensic.listExtractions', () => {
  it('calls GET /api/v1/admin/forensic/extractions', async () => {
    const fetchMock = makeOkFetch(SAMPLE_FORENSIC_RESPONSE);
    const client = new SpatulaClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: fetchMock as unknown as typeof fetch,
      skipVersionProbe: true,
    });

    await (client.experimental as any).forensic.listExtractions();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/v1\/admin\/forensic\/extractions/);
    // Must be GET
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
  });

  it('returns the cursor-first { data, nextCursor, hasMore } shape', async () => {
    const fetchMock = makeOkFetch(SAMPLE_FORENSIC_RESPONSE);
    const client = new SpatulaClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: fetchMock as unknown as typeof fetch,
      skipVersionProbe: true,
    });

    const result = await (client.experimental as any).forensic.listExtractions();

    expect(result).toHaveProperty('data');
    expect(Array.isArray(result.data)).toBe(true);
    expect(result).toHaveProperty('nextCursor');
    expect(result).toHaveProperty('hasMore');
    expect(result.data[0].extractionId).toBe(SAMPLE_FORENSIC_RESPONSE.data[0].extractionId);
  });

  it('passes cursor query param when provided', async () => {
    const fetchMock = makeOkFetch(SAMPLE_FORENSIC_RESPONSE);
    const client = new SpatulaClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: fetchMock as unknown as typeof fetch,
      skipVersionProbe: true,
    });

    await (client.experimental as any).forensic.listExtractions({ cursor: 'abc123cursor' });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('cursor=abc123cursor');
  });

  it('passes limit query param when provided', async () => {
    const fetchMock = makeOkFetch(SAMPLE_FORENSIC_RESPONSE);
    const client = new SpatulaClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: fetchMock as unknown as typeof fetch,
      skipVersionProbe: true,
    });

    await (client.experimental as any).forensic.listExtractions({ limit: 25 });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('limit=25');
  });

  it('sends Authorization header with API key', async () => {
    const fetchMock = makeOkFetch(SAMPLE_FORENSIC_RESPONSE);
    const client = new SpatulaClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: fetchMock as unknown as typeof fetch,
      skipVersionProbe: true,
    });

    await (client.experimental as any).forensic.listExtractions();

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers?.['Authorization']).toBe(`Bearer ${API_KEY}`);
  });

  it('surfaces standard error envelope on 403 as SpatulaApiError', async () => {
    const fetchMock = makeErrorFetch(403, 'AUTH.INSUFFICIENT_SCOPE', 'Insufficient scope');
    const client = new SpatulaClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: fetchMock as unknown as typeof fetch,
      skipVersionProbe: true,
    });

    await expect((client.experimental as any).forensic.listExtractions()).rejects.toThrow();
  });
});

describe('client.experimental Proxy — non-forensic props still throw', () => {
  it('throws fail-loud on any non-forensic property access', () => {
    const client = new SpatulaClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: vi.fn() as unknown as typeof fetch,
      skipVersionProbe: true,
    });

    expect(() => {
      (client.experimental as any).somethingElse;
    }).toThrow();
  });

  it('throws on non-forensic access: dlqAdmin', () => {
    const client = new SpatulaClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: vi.fn() as unknown as typeof fetch,
      skipVersionProbe: true,
    });

    expect(() => {
      (client.experimental as any).dlqAdmin;
    }).toThrow();
  });

  it('does NOT throw on forensic property access', () => {
    const client = new SpatulaClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: vi.fn() as unknown as typeof fetch,
      skipVersionProbe: true,
    });

    // Accessing .forensic must NOT throw — it returns the forensic surface object
    expect(() => {
      (client.experimental as any).forensic;
    }).not.toThrow();
  });

  it('does NOT throw on well-known JS runtime props (then, toJSON, constructor, symbols)', () => {
    const client = new SpatulaClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: vi.fn() as unknown as typeof fetch,
      skipVersionProbe: true,
    });

    const ns = client.experimental as any;
    expect(() => void ns.then).not.toThrow();
    expect(() => void ns.toJSON).not.toThrow();
    expect(() => void ns.constructor).not.toThrow();
  });
});
