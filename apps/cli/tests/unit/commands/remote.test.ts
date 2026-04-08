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
import { runRemoteAdd, runRemoteList, runRemoteRemove } from '../../../src/commands/remote.js';

function mockFetchSequence(responses: Array<{ ok: boolean; data?: unknown; status?: number }>): void {
  const mockFn = vi.fn();
  for (const r of responses) {
    mockFn.mockResolvedValueOnce({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: () =>
        Promise.resolve(
          r.ok ? (r.data ?? { status: 'ok' }) : { error: { message: 'fail' } },
        ),
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
      { ok: true, data: { data: { plan: 'starter', usage: {} } } },
    ]);
    const result = await runRemoteAdd({
      name: 'prod',
      url: 'https://api.spatula.dev',
      apiKey: 'sk_live_abc',
    });
    expect(result.success).toBe(true);
    expect(result.plan).toBe('starter');
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
