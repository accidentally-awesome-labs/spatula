import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runPushCommand } from '../../../src/commands/push.js';
import type { GlobalConfig } from '@accidentally-awesome-labs/spatula-core';

vi.mock('@accidentally-awesome-labs/spatula-core', async () => {
  const actual = await vi.importActual<typeof import('@accidentally-awesome-labs/spatula-core')>(
    '@accidentally-awesome-labs/spatula-core',
  );
  return {
    ...actual,
    loadGlobalConfig: vi.fn(
      () =>
        ({
          version: 1,
          remotes: {
            prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live_abc' },
          },
        }) as GlobalConfig,
    ),
    parseProjectYamlFile: vi.fn(() => ({
      name: 'test-crawl',
      seeds: ['https://example.com'],
      depth: 2,
      limit: 100,
    })),
    yamlToJobConfig: vi.fn(() => ({
      tenantId: 'tenant-1',
      name: 'test-crawl',
      seedUrls: ['https://example.com'],
      crawl: { maxDepth: 2, maxPages: 100, concurrency: 5, crawlerType: 'playwright' },
      schema: { mode: 'discovery' },
      llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    })),
    findProjectRoot: vi.fn(() => '/tmp/test-project'),
  };
});

const mockMetaGet = vi.fn();
const mockMetaSet = vi.fn();

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

describe('runPushCommand', () => {
  beforeEach(() => {
    mockMetaGet.mockReset();
    mockMetaSet.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('creates a job on the remote server and stores link in meta', async () => {
    mockMetaGet.mockResolvedValue(null);
    mockFetchOk({ id: 'remote-job-123', status: 'pending' });

    const result = await runPushCommand({
      remoteName: 'prod',
      projectRoot: '/tmp/test-project',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      autoStart: false,
    });

    expect(result.success).toBe(true);
    expect(result.jobId).toBe('remote-job-123');
    expect(mockMetaSet).toHaveBeenCalledWith('remote:prod:job_id', 'remote-job-123');
    expect(mockMetaSet).toHaveBeenCalledWith('remote:prod:pushed_at', expect.any(String));
  });

  it('returns existing job conflict when linked job is still running', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'old-job-999';
      return null;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { id: 'old-job-999', status: 'running' } }),
      }),
    );

    const result = await runPushCommand({
      remoteName: 'prod',
      projectRoot: '/tmp/test-project',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      autoStart: false,
    });

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.existingJobId).toBe('old-job-999');
    expect(result.existingJobStatus).toBe('running');
  });

  it('proceeds when existing linked job is completed', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'old-job-done';
      return null;
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { id: 'old-job-done', status: 'completed' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { id: 'new-job-456', status: 'pending' } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runPushCommand({
      remoteName: 'prod',
      projectRoot: '/tmp/test-project',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      autoStart: false,
    });

    expect(result.success).toBe(true);
    expect(result.jobId).toBe('new-job-456');
  });
});

describe('runPushCommand — auto-start and edge cases', () => {
  beforeEach(() => {
    mockMetaGet.mockReset();
    mockMetaSet.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('starts the job after creation when autoStart is true', async () => {
    mockMetaGet.mockResolvedValue(null);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { id: 'job-auto', status: 'pending' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { id: 'job-auto', status: 'running' } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runPushCommand({
      remoteName: 'prod',
      projectRoot: '/tmp/test-project',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      autoStart: true,
    });

    expect(result.success).toBe(true);
    expect(result.started).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = fetchMock.mock.calls[1][0] as string;
    expect(secondUrl).toContain('/start');
  });

  it('stores config hash in project_meta', async () => {
    mockMetaGet.mockResolvedValue(null);
    mockFetchOk({ id: 'job-hash', status: 'pending' });

    await runPushCommand({
      remoteName: 'prod',
      projectRoot: '/tmp/test-project',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      autoStart: false,
    });

    const hashCall = mockMetaSet.mock.calls.find(
      (c: string[]) => c[0] === 'remote:prod:config_hash',
    );
    expect(hashCall).toBeDefined();
    expect(hashCall![1]).toMatch(/^[a-f0-9]{12}$/);
  });

  it('skips conflict check when forceNew is true', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'old-job-running';
      return null;
    });

    mockFetchOk({ id: 'forced-job', status: 'pending' });

    const result = await runPushCommand({
      remoteName: 'prod',
      projectRoot: '/tmp/test-project',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      autoStart: false,
      forceNew: true,
    });

    expect(result.success).toBe(true);
    expect(result.jobId).toBe('forced-job');
  });

  it('returns error when createJob fails', async () => {
    mockMetaGet.mockResolvedValue(null);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: { message: 'Internal server error' } }),
      }),
    );

    const result = await runPushCommand({
      remoteName: 'prod',
      projectRoot: '/tmp/test-project',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      autoStart: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to create remote job');
    expect(mockMetaSet).not.toHaveBeenCalled();
  });
});
