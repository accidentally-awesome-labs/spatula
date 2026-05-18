import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GlobalConfig } from '@spatula/core';

const { mockLoadGlobalConfig, mockSaveGlobalConfig } = vi.hoisted(() => {
  return {
    mockLoadGlobalConfig: vi.fn(),
    mockSaveGlobalConfig: vi.fn(),
  };
});

let mockConfig: GlobalConfig | null = null;

vi.mock('@spatula/core', async () => {
  const actual = await vi.importActual<typeof import('@spatula/core')>('@spatula/core');
  return {
    ...actual,
    loadGlobalConfig: (...args: unknown[]) => {
      mockLoadGlobalConfig(...args);
      return mockConfig;
    },
    saveGlobalConfig: mockSaveGlobalConfig,
  };
});

// Import after mock setup
import {
  runRemoteAdd,
  runRemoteList,
  runRemoteRemove,
  runRemoteStatus,
  runRemoteJobAction,
} from '../../../src/commands/remote.js';

function mockFetchSequence(
  responses: Array<{ ok: boolean; data?: unknown; status?: number }>,
): void {
  const mockFn = vi.fn();
  for (const r of responses) {
    mockFn.mockResolvedValueOnce({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: () =>
        Promise.resolve(r.ok ? (r.data ?? { status: 'ok' }) : { error: { message: 'fail' } }),
    });
  }
  vi.stubGlobal('fetch', mockFn);
}

describe('runRemoteAdd', () => {
  beforeEach(() => {
    mockConfig = { version: 1 };
    mockSaveGlobalConfig.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('saves remote config after verifying health and auth', async () => {
    mockFetchSequence([
      { ok: true, data: { status: 'ok' } },
      // /api/v1/auth/me returns top-level fields (no { data } envelope)
      {
        ok: true,
        data: {
          tenantId: 'tenant-prod',
          scopes: ['jobs:read', 'jobs:write'],
          subject: 'user-1',
          authenticated: true,
        },
      },
    ]);
    const result = await runRemoteAdd({
      name: 'prod',
      url: 'https://api.spatula.dev',
      apiKey: 'sk_live_abc',
    });
    expect(result.success).toBe(true);
    expect(result.tenantId).toBe('tenant-prod');
    expect(result.scopes).toEqual(['jobs:read', 'jobs:write']);
    expect(mockSaveGlobalConfig).toHaveBeenCalledTimes(1);
    const savedConfig = mockSaveGlobalConfig.mock.calls[0][0] as GlobalConfig;
    expect(savedConfig.remotes?.prod?.url).toBe('https://api.spatula.dev');
    expect(savedConfig.remotes?.prod?.apiKey).toBe('sk_live_abc');
  });

  it('returns error when health check fails', async () => {
    mockFetchSequence([{ ok: false, status: 500 }]);
    const result = await runRemoteAdd({
      name: 'bad',
      url: 'https://bad.example.com',
      apiKey: 'sk_bad',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('health');
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
  });

  it('returns error when auth check fails', async () => {
    mockFetchSequence([
      { ok: true, data: { status: 'ok' } },
      { ok: false, status: 401 },
    ]);
    const result = await runRemoteAdd({
      name: 'noauth',
      url: 'https://api.spatula.dev',
      apiKey: 'sk_invalid',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('auth');
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
  });
});

describe('runRemoteList', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns empty array when no remotes configured', async () => {
    mockConfig = { version: 1 };
    const result = await runRemoteList();
    expect(result.remotes).toEqual([]);
  });

  it('lists all configured remotes without project context', async () => {
    mockConfig = {
      version: 1,
      remotes: {
        prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' },
        staging: { url: 'https://staging.spatula.dev' },
      },
    };
    const result = await runRemoteList();
    expect(result.remotes).toHaveLength(2);
    expect(result.remotes[0]).toMatchObject({
      name: 'prod',
      url: 'https://api.spatula.dev',
      hasApiKey: true,
    });
    expect(result.remotes[1]).toMatchObject({
      name: 'staging',
      url: 'https://staging.spatula.dev',
      hasApiKey: false,
    });
  });

  it('includes live job status when metaGet is provided', async () => {
    mockConfig = {
      version: 1,
      remotes: {
        prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' },
      },
    };
    mockFetchSequence([{ ok: true, data: { data: { id: 'job-1', status: 'running' } } }]);
    const metaGet = vi.fn().mockResolvedValue('job-1');
    const result = await runRemoteList(metaGet);
    expect(result.remotes[0].jobId).toBe('job-1');
    expect(result.remotes[0].jobStatus).toBe('running');
  });
});

describe('runRemoteRemove', () => {
  beforeEach(() => {
    mockConfig = {
      version: 1,
      remotes: {
        prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' },
      },
    };
    mockSaveGlobalConfig.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('removes an existing remote from global config', async () => {
    const result = await runRemoteRemove('prod');
    expect(result.success).toBe(true);
    expect(mockSaveGlobalConfig).toHaveBeenCalledTimes(1);
    const saved = mockSaveGlobalConfig.mock.calls[0][0] as GlobalConfig;
    expect(saved.remotes).toBeUndefined();
  });

  it('cleans up project_meta when metaDeleteByPrefix is provided', async () => {
    const mockDeleteByPrefix = vi.fn().mockResolvedValue(undefined);
    const result = await runRemoteRemove('prod', mockDeleteByPrefix);
    expect(result.success).toBe(true);
    expect(mockDeleteByPrefix).toHaveBeenCalledWith('remote:prod:');
  });

  it('returns error for non-existent remote', async () => {
    const result = await runRemoteRemove('nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('runRemoteStatus', () => {
  beforeEach(() => {
    mockConfig = {
      version: 1,
      remotes: { prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' } },
    };
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns job data for linked remote', async () => {
    mockFetchSequence([{ ok: true, data: { data: { id: 'job-1', status: 'running' } } }]);
    const metaGet = vi.fn().mockResolvedValue('job-1');
    const result = await runRemoteStatus('prod', metaGet);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ id: 'job-1', status: 'running' });
    expect(metaGet).toHaveBeenCalledWith('remote:prod:job_id');
  });

  it('returns error when no linked job', async () => {
    const metaGet = vi.fn().mockResolvedValue(null);
    const result = await runRemoteStatus('prod', metaGet);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No linked job');
  });
});

describe('runRemoteJobAction', () => {
  beforeEach(() => {
    mockConfig = {
      version: 1,
      remotes: { prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' } },
    };
  });
  afterEach(() => vi.restoreAllMocks());

  it('pauses a remote job', async () => {
    mockFetchSequence([{ ok: true, data: { data: { id: 'job-1', status: 'paused' } } }]);
    const metaGet = vi.fn().mockResolvedValue('job-1');
    const result = await runRemoteJobAction('prod', 'pause', metaGet);
    expect(result.success).toBe(true);
  });

  it('resumes a remote job', async () => {
    mockFetchSequence([{ ok: true, data: { data: { id: 'job-1', status: 'running' } } }]);
    const metaGet = vi.fn().mockResolvedValue('job-1');
    const result = await runRemoteJobAction('prod', 'resume', metaGet);
    expect(result.success).toBe(true);
  });

  it('cancels a remote job', async () => {
    mockFetchSequence([{ ok: true, data: { data: { id: 'job-1', status: 'cancelled' } } }]);
    const metaGet = vi.fn().mockResolvedValue('job-1');
    const result = await runRemoteJobAction('prod', 'cancel', metaGet);
    expect(result.success).toBe(true);
  });

  it('returns error when remote not configured', async () => {
    mockConfig = { version: 1 };
    const metaGet = vi.fn().mockResolvedValue('job-1');
    await expect(runRemoteJobAction('missing', 'pause', metaGet)).rejects.toThrow('not found');
  });
});
