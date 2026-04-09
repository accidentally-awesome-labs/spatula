import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiDataSource } from '../../../src/data-sources/api-data-source.js';
import { SpatulaApiClient } from '../../../src/api/client.js';

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

function mockFetchPaginated(data: unknown[], total: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data, total }),
    }),
  );
}

describe('ApiDataSource', () => {
  let client: SpatulaApiClient;
  let ds: ApiDataSource;

  beforeEach(() => {
    client = new SpatulaApiClient('http://localhost:3000', 'tenant-1', {
      apiKey: 'sk_test',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('getEntities calls listEntitiesPaginated and returns PaginatedResult', async () => {
    const entities = [{ id: 'e1', name: 'Test' }];
    mockFetchPaginated(entities, 1);
    ds = new ApiDataSource(client, 'job-1');
    const result = await ds.getEntities({ limit: 10, offset: 0 });
    expect(result.data).toEqual(entities);
    expect(result.total).toBe(1);
  });

  it('getEntity calls client.getEntity', async () => {
    mockFetchOk({ id: 'e1', name: 'Entity 1' });
    ds = new ApiDataSource(client, 'job-1');
    const result = await ds.getEntity('e1');
    expect(result).toEqual({ id: 'e1', name: 'Entity 1' });
  });

  it('getSchema calls client.getSchema', async () => {
    mockFetchOk({ version: 3, fields: [] });
    ds = new ApiDataSource(client, 'job-1');
    const result = await ds.getSchema();
    expect(result).toEqual({ version: 3, fields: [] });
  });

  it('getStatus calls client.getJob and transforms to ProjectStatus', async () => {
    mockFetchOk({
      id: 'job-1',
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
      pagesDiscovered: 100,
      pagesCompleted: 42,
      entitiesExtracted: 20,
    });
    ds = new ApiDataSource(client, 'job-1');
    const status = await ds.getStatus();
    expect(status.totalPages).toBe(100);
    expect(status.totalEntities).toBe(20);
    expect(status.lastRun?.status).toBe('running');
  });

  it('reads pendingActions and schemaFields from job stats', async () => {
    mockFetchOk({
      id: 'j1',
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
      pagesDiscovered: 0,
      pagesCompleted: 0,
      entitiesExtracted: 0,
      stats: { pendingActionsCount: 5, schemaFieldCount: 12, storageBytesUsed: 1024 },
    });
    ds = new ApiDataSource(client, 'j1');
    const status = await ds.getStatus();
    expect(status.pendingActions).toBe(5);
    expect(status.schemaFields).toBe(12);
    expect(status.storageBytes.pages).toBe(1024);
    expect(status.storageBytes.database).toBe(0);
    expect(status.storageBytes.exports).toBe(0);
  });

  it('defaults stats fields to 0 when job.stats is missing', async () => {
    mockFetchOk({
      id: 'j2',
      status: 'pending',
      pagesDiscovered: 0,
      pagesCompleted: 0,
      entitiesExtracted: 0,
    });
    ds = new ApiDataSource(client, 'j2');
    const status = await ds.getStatus();
    expect(status.pendingActions).toBe(0);
    expect(status.schemaFields).toBe(0);
    expect(status.storageBytes.pages).toBe(0);
  });

  it('approveAction calls client.approveAction', async () => {
    mockFetchOk({});
    ds = new ApiDataSource(client, 'job-1');
    await ds.approveAction('action-1', 'user-1');
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain('/actions/action-1/approve');
  });

  it('createExport calls client.createExport', async () => {
    mockFetchOk({ id: 'exp-1', format: 'json', status: 'pending' });
    ds = new ApiDataSource(client, 'job-1');
    const result = await ds.createExport({ format: 'json' });
    expect(result).toEqual({ id: 'exp-1', format: 'json', status: 'pending' });
  });
});
