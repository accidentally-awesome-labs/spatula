import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runPushCommand } from '../../../src/commands/push.js';
import type { GlobalConfig } from '@spatula/core';

vi.mock('@spatula/core', async () => {
  const actual = await vi.importActual<typeof import('@spatula/core')>('@spatula/core');
  return {
    ...actual,
    loadGlobalConfig: vi.fn(() => ({
      version: 1,
      remotes: {
        prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live_abc' },
      },
    } as GlobalConfig)),
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

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ data: { id: 'old-job-done', status: 'completed' } }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
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
