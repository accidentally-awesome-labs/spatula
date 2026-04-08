import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { buildWsUrl } from '../../../src/hooks/useWebSocket.js';
import { getRemoteWatchConfig } from '../../../src/commands/remote-watch.js';
import type { GlobalConfig } from '@spatula/core';

let mockConfig: GlobalConfig | null = null;
vi.mock('@spatula/core', async () => {
  const actual = await vi.importActual<typeof import('@spatula/core')>('@spatula/core');
  return {
    ...actual,
    loadGlobalConfig: vi.fn(() => mockConfig),
  };
});

// Mock ink's render to avoid actually rendering React/Ink trees.
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    render: vi.fn(() => ({
      unmount: vi.fn(),
      waitUntilExit: vi.fn().mockResolvedValue(undefined),
      rerender: vi.fn(),
      clear: vi.fn(),
      cleanup: vi.fn(),
    })),
  };
});

// Mock the store module (dynamically imported by runRemoteWatchCommand)
const mockSetActiveJobId = vi.fn();
const mockStore = {
  getState: () => ({ setActiveJobId: mockSetActiveJobId }),
};

vi.mock('../../../src/store/index.js', () => ({
  createCliStore: vi.fn(() => mockStore),
}));

// Mock DashboardView (dynamically imported by runRemoteWatchCommand)
vi.mock('../../../src/components/dashboard/index.js', () => ({
  DashboardView: vi.fn().mockReturnValue(null),
}));

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

// ---------------------------------------------------------------------------
// runRemoteWatchCommand
// ---------------------------------------------------------------------------

describe('runRemoteWatchCommand', () => {
  beforeEach(async () => {
    mockConfig = {
      version: 1,
      remotes: { prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' } },
    };
    // Re-establish mock implementations that vi.restoreAllMocks() in earlier
    // describe blocks may have cleared.
    const ink = await import('ink');
    (ink.render as ReturnType<typeof vi.fn>).mockReturnValue({
      unmount: vi.fn(),
      waitUntilExit: vi.fn().mockResolvedValue(undefined),
      rerender: vi.fn(),
      clear: vi.fn(),
      cleanup: vi.fn(),
    });
    const storeModule = await import('../../../src/store/index.js');
    (storeModule.createCliStore as ReturnType<typeof vi.fn>).mockReturnValue(mockStore);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('obtains WS token, creates store, sets activeJobId, and renders dashboard', async () => {
    // Mock fetch for SpatulaApiClient.getWsToken() — the client unwraps .data
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { token: 'ws_tok_abc', expiresIn: 60 } }),
      }),
    );

    const metaGet = vi.fn().mockResolvedValue('job-remote-1');

    const { runRemoteWatchCommand } = await import(
      '../../../src/commands/remote-watch.js'
    );
    await runRemoteWatchCommand('prod', metaGet);

    // Verify WS token was fetched via POST /api/v1/ws-token
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    expect(fetchCalls[0][0]).toContain('/api/v1/ws-token');
    expect(fetchCalls[0][1]).toMatchObject({ method: 'POST' });

    // Verify store was created with 'remote' tenantId
    const { createCliStore } = await import('../../../src/store/index.js');
    expect(createCliStore).toHaveBeenCalledWith('remote');

    // Verify activeJobId was set on the store
    expect(mockSetActiveJobId).toHaveBeenCalledWith('job-remote-1');

    // Verify ink render was called
    const { render } = await import('ink');
    expect(render).toHaveBeenCalledTimes(1);
  });
});
