import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpatulaClient, SpatulaApiError } from '../../src/client.js';
import { JobNotFoundError } from '../../src/errors/generated.js';

describe('SpatulaClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  describe('constructor (no I/O — Anti-Pattern protection per D-12)', () => {
    it('does NOT trigger any fetch on instantiation', () => {
      const _client = new SpatulaClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        fetch: fetchMock as unknown as typeof fetch,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('normalizes the baseUrl (trims trailing slashes)', () => {
      const client = new SpatulaClient({
        baseUrl: 'https://api.example.com///',
        apiKey: 'k',
        fetch: fetchMock as unknown as typeof fetch,
      });
      expect(client.baseUrl).toBe('https://api.example.com');
    });

    it('exposes the experimental namespace (Proxy)', () => {
      const client = new SpatulaClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        fetch: fetchMock as unknown as typeof fetch,
      });
      // Direct access throws — see experimental-namespace.test.ts.
      expect(client.experimental).toBeDefined();
    });
  });

  describe('request() — error decoding', () => {
    it('decodes a 404 JOB.NOT_FOUND envelope to JobNotFoundError', async () => {
      // Use mockImplementation so each call gets a fresh Response (Response.json
      // consumes the body — same Response can't be read twice).
      fetchMock.mockImplementation(
        () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'JOB.NOT_FOUND',
                message: 'Job abc not found',
                requestId: 'req-1',
              },
            }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          ),
      );

      const client = new SpatulaClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        fetch: fetchMock as unknown as typeof fetch,
        skipVersionProbe: true,
      });

      try {
        await client.request('GET', '/api/v1/jobs/abc');
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(JobNotFoundError);
        const apiErr = err as JobNotFoundError;
        expect(apiErr.code).toBe('JOB.NOT_FOUND');
        expect(apiErr.status).toBe(404);
        expect(apiErr.requestId).toBe('req-1');
      }
    });

    it('falls back to SpatulaApiError for unknown codes', async () => {
      fetchMock.mockImplementation(
        () =>
          new Response(
            JSON.stringify({
              error: { code: 'UNKNOWN.MYSTERY', message: 'huh', requestId: 'req-2' },
            }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          ),
      );
      const client = new SpatulaClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        fetch: fetchMock as unknown as typeof fetch,
        skipVersionProbe: true,
      });
      try {
        await client.request('GET', '/api/v1/anything');
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(SpatulaApiError);
        expect((err as SpatulaApiError).code).toBe('UNKNOWN.MYSTERY');
      }
    });

    it('returns parsed JSON on 2xx', async () => {
      fetchMock.mockImplementation(
        () =>
          new Response(JSON.stringify({ id: 'job-1', name: 'demo' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      // skipVersionProbe so the test exercises only the request path.
      const client = new SpatulaClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        fetch: fetchMock as unknown as typeof fetch,
        skipVersionProbe: true,
      });
      const result = await client.request<{ id: string; name: string }>(
        'GET',
        '/api/v1/jobs/job-1',
      );
      expect(result).toEqual({ id: 'job-1', name: 'demo' });
    });

    it('sets the Authorization header on every request', async () => {
      fetchMock.mockImplementation(() => new Response('{}', { status: 200 }));
      const client = new SpatulaClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'secret-key',
        fetch: fetchMock as unknown as typeof fetch,
        skipVersionProbe: true,
      });
      await client.request('GET', '/api/v1/jobs');
      const callArgs = fetchMock.mock.calls[0];
      expect(callArgs[0]).toBe('https://api.example.com/api/v1/jobs');
      const init = callArgs[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer secret-key');
    });
  });
});
