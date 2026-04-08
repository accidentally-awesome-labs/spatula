import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { buildWsUrl } from '../../../src/hooks/useWebSocket.js';
import { getRemoteWatchConfig } from '../../../src/commands/remote-watch.js';
import type { GlobalConfig } from '@spatula/core';

let mockConfig: GlobalConfig | null;
vi.mock('@spatula/core', async () => {
  const actual = await vi.importActual<typeof import('@spatula/core')>('@spatula/core');
  return {
    ...actual,
    loadGlobalConfig: vi.fn(() => mockConfig),
  };
});

describe('buildWsUrl', () => {
  it('builds local WS URL with tenantId query param', () => {
    const url = buildWsUrl('http://localhost:3000', 'tenant-1', 'job-1');
    expect(url).toBe('ws://localhost:3000/ws/jobs/job-1/progress?tenantId=tenant-1');
  });

  it('builds authenticated WS URL with token query param', () => {
    const url = buildWsUrl('https://api.spatula.dev', 'tenant-1', 'job-1', 'tok_abc');
    expect(url).toBe('wss://api.spatula.dev/ws/jobs/job-1/progress?token=tok_abc');
  });

  it('converts https to wss', () => {
    const url = buildWsUrl('https://api.example.com', '', 'j1', 'tok');
    expect(url).toMatch(/^wss:\/\//);
  });
});

describe('getRemoteWatchConfig', () => {
  beforeEach(() => {
    mockConfig = {
      version: 1,
      remotes: { prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' } },
    };
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns remote URL, API key, and job ID', async () => {
    const metaGet = vi.fn().mockResolvedValue('job-abc');
    const config = await getRemoteWatchConfig('prod', metaGet);
    expect(config).toEqual({
      baseUrl: 'https://api.spatula.dev',
      apiKey: 'sk_live',
      jobId: 'job-abc',
    });
  });

  it('throws when no linked job', async () => {
    const metaGet = vi.fn().mockResolvedValue(null);
    await expect(getRemoteWatchConfig('prod', metaGet)).rejects.toThrow('No linked job');
  });

  it('throws when remote not configured', async () => {
    mockConfig = { version: 1 };
    const metaGet = vi.fn().mockResolvedValue('job-1');
    await expect(getRemoteWatchConfig('missing', metaGet)).rejects.toThrow('not found');
  });
});
