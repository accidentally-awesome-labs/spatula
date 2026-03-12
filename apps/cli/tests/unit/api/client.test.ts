import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpatulaApiClient, ApiError } from '../../../src/api/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchOk(data: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status,
      json: () => Promise.resolve({ data }),
    }),
  );
}

function mockFetchError(status: number, code: string, message: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: () => Promise.resolve({ error: { code, message } }),
    }),
  );
}

function mockFetchNetworkError(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new TypeError('fetch failed')),
  );
}

function lastFetchCall(): { url: string; init: RequestInit } {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  const last = calls[calls.length - 1];
  return { url: last[0] as string, init: last[1] as RequestInit };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const BASE_URL = 'http://localhost:3000';
const TENANT_ID = 'tenant-abc';

describe('SpatulaApiClient', () => {
  let client: SpatulaApiClient;

  beforeEach(() => {
    client = new SpatulaApiClient(BASE_URL, TENANT_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // createJob
  // -----------------------------------------------------------------------
  describe('createJob', () => {
    it('POSTs to /api/v1/jobs with correct headers and body', async () => {
      const jobData = { id: 'job-1', status: 'created' };
      mockFetchOk(jobData, 201);

      const body = { name: 'Test Job', seedUrls: ['https://example.com'] };
      const result = await client.createJob(body);

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs`);
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ID,
        }),
      );
      expect(JSON.parse(init.body as string)).toEqual(body);
      expect(result).toEqual(jobData);
    });
  });

  // -----------------------------------------------------------------------
  // listJobs
  // -----------------------------------------------------------------------
  describe('listJobs', () => {
    it('GETs /api/v1/jobs without query params', async () => {
      const jobs = [{ id: 'j1' }, { id: 'j2' }];
      mockFetchOk(jobs);

      const result = await client.listJobs();

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs`);
      expect(init.method).toBe('GET');
      expect(result).toEqual(jobs);
    });

    it('GETs /api/v1/jobs with query params, skipping undefined', async () => {
      mockFetchOk([]);

      await client.listJobs({ status: 'running', limit: 10 });

      const { url } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs?status=running&limit=10`);
    });

    it('skips null and undefined query values', async () => {
      mockFetchOk([]);

      await client.listJobs({ status: undefined, limit: 5 });

      const { url } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs?limit=5`);
    });
  });

  // -----------------------------------------------------------------------
  // getJob
  // -----------------------------------------------------------------------
  describe('getJob', () => {
    it('GETs /api/v1/jobs/:id', async () => {
      const job = { id: 'job-42', status: 'running' };
      mockFetchOk(job);

      const result = await client.getJob('job-42');

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs/job-42`);
      expect(init.method).toBe('GET');
      expect(result).toEqual(job);
    });
  });

  // -----------------------------------------------------------------------
  // Job control: startJob, pauseJob, resumeJob, cancelJob
  // -----------------------------------------------------------------------
  describe('startJob', () => {
    it('POSTs to /api/v1/jobs/:id/start', async () => {
      mockFetchOk({ id: 'j1', message: 'Job started' });

      const result = await client.startJob('j1');

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs/j1/start`);
      expect(init.method).toBe('POST');
      expect(result).toEqual({ id: 'j1', message: 'Job started' });
    });
  });

  describe('pauseJob', () => {
    it('POSTs to /api/v1/jobs/:id/pause', async () => {
      mockFetchOk({ id: 'j1', message: 'Job paused' });

      await client.pauseJob('j1');

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs/j1/pause`);
      expect(init.method).toBe('POST');
    });
  });

  describe('resumeJob', () => {
    it('POSTs to /api/v1/jobs/:id/resume', async () => {
      mockFetchOk({ id: 'j1', message: 'Job resumed' });

      await client.resumeJob('j1');

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs/j1/resume`);
      expect(init.method).toBe('POST');
    });
  });

  describe('cancelJob', () => {
    it('POSTs to /api/v1/jobs/:id/cancel', async () => {
      mockFetchOk({ id: 'j1', message: 'Job cancelled' });

      await client.cancelJob('j1');

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs/j1/cancel`);
      expect(init.method).toBe('POST');
    });
  });

  // -----------------------------------------------------------------------
  // triggerReconciliation
  // -----------------------------------------------------------------------
  describe('triggerReconciliation', () => {
    it('POSTs to /api/v1/jobs/:id/reconcile', async () => {
      mockFetchOk({ id: 'j1', message: 'Reconciliation triggered' });

      const result = await client.triggerReconciliation('j1');

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs/j1/reconcile`);
      expect(init.method).toBe('POST');
      expect(result).toEqual({ id: 'j1', message: 'Reconciliation triggered' });
    });
  });

  // -----------------------------------------------------------------------
  // Schema endpoints
  // -----------------------------------------------------------------------
  describe('getSchema', () => {
    it('GETs /api/v1/jobs/:jobId/schema', async () => {
      const schema = { version: 3, fields: [] };
      mockFetchOk(schema);

      const result = await client.getSchema('j1');

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs/j1/schema`);
      expect(init.method).toBe('GET');
      expect(result).toEqual(schema);
    });
  });

  describe('listSchemaVersions', () => {
    it('GETs /api/v1/jobs/:jobId/schema/versions', async () => {
      const versions = [{ version: 1 }, { version: 2 }];
      mockFetchOk(versions);

      const result = await client.listSchemaVersions('j1');

      const { url } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs/j1/schema/versions`);
      expect(result).toEqual(versions);
    });
  });

  // -----------------------------------------------------------------------
  // Extractions
  // -----------------------------------------------------------------------
  describe('listExtractions', () => {
    it('GETs /api/v1/jobs/:jobId/extractions with optional query', async () => {
      mockFetchOk([]);

      await client.listExtractions('j1', { schemaVersion: 2, limit: 25 });

      const { url } = lastFetchCall();
      expect(url).toBe(
        `${BASE_URL}/api/v1/jobs/j1/extractions?schemaVersion=2&limit=25`,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Entities
  // -----------------------------------------------------------------------
  describe('listEntities', () => {
    it('GETs /api/v1/jobs/:jobId/entities without query', async () => {
      const entities = [{ id: 'e1' }];
      mockFetchOk(entities);

      const result = await client.listEntities('j1');

      const { url } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs/j1/entities`);
      expect(result).toEqual(entities);
    });

    it('GETs /api/v1/jobs/:jobId/entities with pagination', async () => {
      mockFetchOk([]);

      await client.listEntities('j1', { limit: 20, offset: 40 });

      const { url } = lastFetchCall();
      expect(url).toBe(
        `${BASE_URL}/api/v1/jobs/j1/entities?limit=20&offset=40`,
      );
    });
  });

  describe('getEntity', () => {
    it('GETs /api/v1/jobs/:jobId/entities/:eid', async () => {
      const entity = { id: 'e5', name: 'Acme Inc' };
      mockFetchOk(entity);

      const result = await client.getEntity('j1', 'e5');

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs/j1/entities/e5`);
      expect(init.method).toBe('GET');
      expect(result).toEqual(entity);
    });
  });

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------
  describe('listActions', () => {
    it('GETs /api/v1/jobs/:jobId/actions with query params', async () => {
      mockFetchOk([]);

      await client.listActions('j1', {
        type: 'add_field',
        status: 'pending_review',
        limit: 10,
        offset: 0,
      });

      const { url } = lastFetchCall();
      expect(url).toBe(
        `${BASE_URL}/api/v1/jobs/j1/actions?type=add_field&status=pending_review&limit=10&offset=0`,
      );
    });
  });

  describe('approveAction', () => {
    it('POSTs to /api/v1/jobs/:jobId/actions/:aid/approve', async () => {
      const action = { id: 'a1', status: 'approved' };
      mockFetchOk(action);

      const result = await client.approveAction('j1', 'a1', 'user-1');

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs/j1/actions/a1/approve`);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ reviewedBy: 'user-1' });
      expect(result).toEqual(action);
    });

    it('sends empty body when reviewedBy is omitted', async () => {
      mockFetchOk({ id: 'a1', status: 'approved' });

      await client.approveAction('j1', 'a1');

      const { init } = lastFetchCall();
      expect(JSON.parse(init.body as string)).toEqual({});
    });
  });

  describe('rejectAction', () => {
    it('POSTs to /api/v1/jobs/:jobId/actions/:aid/reject', async () => {
      mockFetchOk({ id: 'a1', status: 'rejected' });

      await client.rejectAction('j1', 'a1', 'user-2');

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs/j1/actions/a1/reject`);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ reviewedBy: 'user-2' });
    });
  });

  describe('approveAllActions', () => {
    it('POSTs to /api/v1/jobs/:jobId/actions/approve-all', async () => {
      const approved = [{ id: 'a1' }, { id: 'a2' }];
      mockFetchOk(approved);

      const result = await client.approveAllActions('j1', 'user-3');

      const { url, init } = lastFetchCall();
      expect(url).toBe(`${BASE_URL}/api/v1/jobs/j1/actions/approve-all`);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ reviewedBy: 'user-3' });
      expect(result).toEqual(approved);
    });

    it('sends empty body when reviewedBy is omitted', async () => {
      mockFetchOk([]);

      await client.approveAllActions('j1');

      const { init } = lastFetchCall();
      expect(JSON.parse(init.body as string)).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  describe('error handling', () => {
    it('throws ApiError on non-ok response with parsed error body', async () => {
      mockFetchError(404, 'NOT_FOUND', 'Job not found');

      try {
        await client.getJob('missing');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(404);
        expect(apiErr.code).toBe('NOT_FOUND');
        expect(apiErr.message).toBe('Job not found');
      }
    });

    it('throws ApiError on non-ok response when error body parsing fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: () => Promise.reject(new Error('bad json')),
        }),
      );

      try {
        await client.getJob('bad');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(500);
        expect(apiErr.code).toBeUndefined();
        expect(apiErr.message).toBe('HTTP 500');
      }
    });

    it('throws ApiError with status 0 and NETWORK_ERROR on fetch failure', async () => {
      mockFetchNetworkError();

      try {
        await client.listJobs();
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(0);
        expect(apiErr.code).toBe('NETWORK_ERROR');
        expect(apiErr.message).toBe('fetch failed');
      }
    });
  });

  // -----------------------------------------------------------------------
  // ApiError
  // -----------------------------------------------------------------------
  describe('ApiError', () => {
    it('is an instance of Error', () => {
      const err = new ApiError(400, 'BAD_REQUEST', 'Invalid input');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ApiError');
      expect(err.status).toBe(400);
      expect(err.code).toBe('BAD_REQUEST');
      expect(err.message).toBe('Invalid input');
    });
  });
});
