import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalDataSource } from '../../../src/pipeline/local-data-source.js';
import { PipelineEventEmitter } from '../../../src/pipeline/pipeline-events.js';
import type { ProjectAdapterLike } from '../../../src/pipeline/local-data-source.js';

// ---------------------------------------------------------------------------
// Helper to build a mock adapter
// ---------------------------------------------------------------------------

function buildMockAdapter(overrides: Partial<ProjectAdapterLike> = {}): ProjectAdapterLike {
  return {
    getProjectId: vi.fn().mockReturnValue('project-123'),
    entityRepo: {
      findByJob: vi.fn().mockResolvedValue([
        {
          id: 'e1',
          jobId: 'project-123',
          mergedData: { name: 'Acme' },
          categories: [],
          qualityScore: 0.9,
          createdAt: '2026-01-01T00:00:00Z',
          sourceCount: 1,
        },
      ]),
      findByJobWithProvenance: vi.fn().mockResolvedValue([
        {
          id: 'e1',
          jobId: 'project-123',
          mergedData: { name: 'Acme' },
          categories: [],
          qualityScore: 0.9,
          createdAt: '2026-01-01T00:00:00Z',
          sourceCount: 1,
          provenance: {},
        },
      ]),
      countByJob: vi.fn().mockResolvedValue(1),
    },
    schemaRepo: {
      findLatest: vi
        .fn()
        .mockResolvedValue({ id: 's1', version: 2, definition: { fields: { name: {}, url: {} } } }),
      findAllVersions: vi.fn().mockResolvedValue([
        {
          id: 's1',
          version: 2,
          definition: { fields: { name: {} } },
          parentId: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 's0',
          version: 1,
          definition: { fields: {} },
          parentId: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ]),
    },
    actionRepo: {
      findByJob: vi.fn().mockResolvedValue([
        {
          id: 'a1',
          type: 'add_field',
          status: 'pending_review',
          payload: {},
          source: 'llm',
          confidence: 0.85,
          reasoning: 'needed',
          reviewedBy: null,
          createdAt: '2026-01-01T00:00:00Z',
          appliedAt: null,
        },
      ]),
      updateStatus: vi.fn().mockResolvedValue({}),
    },
    taskRepo: {
      getJobStats: vi
        .fn()
        .mockResolvedValue({ pending: 2, inProgress: 0, completed: 10, failed: 1, skipped: 0 }),
    },
    runRepo: {
      findLatestByStatus: vi
        .fn()
        .mockResolvedValue({ id: 'run-1', status: 'completed', startedAt: '2026-01-01T00:00:00Z' }),
    },
    exportRepo: {
      create: vi.fn().mockResolvedValue({ id: 'exp-1' }),
      findById: vi.fn().mockResolvedValue({
        id: 'exp-1',
        filePath: '/tmp/export.json',
        format: 'json',
        status: 'completed',
      }),
    },
    metaRepo: {
      getAll: vi.fn().mockResolvedValue({ project_id: 'project-123', name: 'Test Project' }),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocalDataSource', () => {
  let adapter: ProjectAdapterLike;
  let ds: LocalDataSource;

  beforeEach(() => {
    adapter = buildMockAdapter();
    ds = new LocalDataSource(adapter);
  });

  it('getEntities delegates to adapter with pagination params', async () => {
    const result = await ds.getEntities({ limit: 10, offset: 20 });

    expect(adapter.entityRepo.findByJob).toHaveBeenCalledWith('project-123', 'project-123', {
      limit: 10,
      offset: 20,
    });
    expect(adapter.entityRepo.countByJob).toHaveBeenCalledWith('project-123', 'project-123');
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('getEntities uses default pagination when no query is provided', async () => {
    await ds.getEntities({});
    expect(adapter.entityRepo.findByJob).toHaveBeenCalledWith('project-123', 'project-123', {
      limit: 50,
      offset: 0,
    });
  });

  it('getEntity returns entity by ID', async () => {
    const entity = await ds.getEntity('e1');
    expect(entity).not.toBeNull();
    expect(entity!.id).toBe('e1');
    expect(adapter.entityRepo.findByJobWithProvenance).toHaveBeenCalledWith(
      'project-123',
      'project-123',
    );
  });

  it('getEntity returns null for unknown ID', async () => {
    const entity = await ds.getEntity('nonexistent');
    expect(entity).toBeNull();
  });

  it('searchEntities filters entities by mergedData content', async () => {
    const results = await ds.searchEntities('acme');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('e1');

    const noMatch = await ds.searchEntities('zzznomatch');
    expect(noMatch).toHaveLength(0);
  });

  it('getSchema returns latest schema', async () => {
    const schema = await ds.getSchema();
    expect(schema).toMatchObject({ id: 's1', version: 2 });
    expect(adapter.schemaRepo.findLatest).toHaveBeenCalledWith('project-123', 'project-123');
  });

  it('getSchemaVersions returns all schema versions', async () => {
    const versions = await ds.getSchemaVersions();
    expect(versions).toHaveLength(2);
    expect(adapter.schemaRepo.findAllVersions).toHaveBeenCalledWith('project-123');
  });

  it('getActions delegates with status filter', async () => {
    const actions = await ds.getActions('pending_review');
    expect(adapter.actionRepo.findByJob).toHaveBeenCalledWith('project-123', {
      status: 'pending_review',
    });
    expect(actions).toHaveLength(1);
  });

  it('getActions with no status passes undefined filter', async () => {
    await ds.getActions();
    expect(adapter.actionRepo.findByJob).toHaveBeenCalledWith('project-123', { status: undefined });
  });

  it('approveAction delegates to adapter', async () => {
    await ds.approveAction('a1', 'user@example.com');
    expect(adapter.actionRepo.updateStatus).toHaveBeenCalledWith(
      'a1',
      'project-123',
      'approved',
      'user@example.com',
    );
  });

  it('rejectAction delegates to adapter', async () => {
    await ds.rejectAction('a1');
    expect(adapter.actionRepo.updateStatus).toHaveBeenCalledWith(
      'a1',
      'project-123',
      'rejected',
      undefined,
    );
  });

  it('getStatus returns project status summary', async () => {
    const status = await ds.getStatus();

    expect(status.totalEntities).toBe(1);
    expect(status.totalPages).toBe(11); // completed(10) + failed(1) + skipped(0)
    expect(status.pendingActions).toBe(1);
    expect(status.schemaFields).toBe(2); // 'name' and 'url' fields
    expect(status.lastRun).toBeDefined();
    expect(status.lastRun!.id).toBe('run-1');
    expect(status.lastRun!.status).toBe('completed');
  });

  it('getStatus handles missing schema and run gracefully', async () => {
    const noRunAdapter = buildMockAdapter({
      schemaRepo: {
        findLatest: vi.fn().mockResolvedValue(null),
        findAllVersions: vi.fn().mockResolvedValue([]),
      },
      runRepo: {
        findLatestByStatus: vi.fn().mockResolvedValue(null),
      },
    });
    const noRunDs = new LocalDataSource(noRunAdapter);
    const status = await noRunDs.getStatus();

    expect(status.schemaFields).toBe(0);
    expect(status.lastRun).toBeUndefined();
  });

  it('createExport delegates to adapter', async () => {
    const result = await ds.createExport({ format: 'json', includeProvenance: true });
    expect(adapter.exportRepo.create).toHaveBeenCalledWith({
      format: 'json',
      filePath: '',
      includeProvenance: true,
    });
    expect(result).toMatchObject({ id: 'exp-1' });
  });

  it('getExport delegates to adapter', async () => {
    const record = await ds.getExport('exp-1');
    expect(adapter.exportRepo.findById).toHaveBeenCalledWith('exp-1');
    expect(record).toMatchObject({ id: 'exp-1' });
  });

  it('downloadExport returns file path', async () => {
    const path = await ds.downloadExport('exp-1');
    expect(path).toBe('/tmp/export.json');
  });

  it('downloadExport throws for unknown export ID', async () => {
    const badAdapter = buildMockAdapter({
      exportRepo: {
        create: vi.fn().mockResolvedValue({ id: 'exp-1' }),
        findById: vi.fn().mockResolvedValue(null),
      },
    });
    const badDs = new LocalDataSource(badAdapter);
    await expect(badDs.downloadExport('missing')).rejects.toThrow('Export not found: missing');
  });

  it('getDocumentation returns all meta entries', async () => {
    const doc = await ds.getDocumentation();
    expect(doc).toMatchObject({ project_id: 'project-123', name: 'Test Project' });
  });

  it('subscribe forwards events and returns unsubscribe function', async () => {
    const emitter = new PipelineEventEmitter();
    const dsWithEmitter = new LocalDataSource(adapter, emitter);
    const received: Array<{ type: string; data: unknown }> = [];

    const unsubscribe = dsWithEmitter.subscribe((event) => received.push(event));

    emitter.emit('entity:created', { id: 'e2', jobId: 'project-123' });
    emitter.emit('task:completed', { id: 't1', url: 'https://example.com', status: 'completed' });
    emitter.emit('progress', { pagesProcessed: 5, totalPages: 10, entitiesCreated: 3, errors: 0 });

    expect(received).toHaveLength(3);
    expect(received[0]).toEqual({
      type: 'entity:created',
      data: { id: 'e2', jobId: 'project-123' },
    });
    expect(received[1]).toEqual({
      type: 'task:completed',
      data: { id: 't1', url: 'https://example.com', status: 'completed' },
    });
    expect(received[2].type).toBe('progress');

    // Unsubscribe and verify no more events received
    unsubscribe();
    emitter.emit('entity:created', { id: 'e3', jobId: 'project-123' });
    expect(received).toHaveLength(3); // still 3 — no new events after unsubscribe
  });

  it('subscribe returns a no-op unsubscribe when no emitter is provided', () => {
    const unsubscribe = ds.subscribe(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });
});
