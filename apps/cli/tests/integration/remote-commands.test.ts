/**
 * Integration tests for CLI remote commands.
 *
 * Uses a REAL SQLite database for meta operations — no mocks for the
 * project DB layer. Global config and fetch are mocked because remote
 * commands talk to external servers.
 *
 * Commands tested:
 *   1. runRemoteAdd     — health check, auth check, save to global config
 *   2. runRemoteList    — list remotes with optional live job metadata
 *   3. runRemoteRemove  — delete from config + clean meta entries in DB
 *   4. runRemoteStatus  — fetch job status via linked job in meta
 *   5. runRemoteJobAction — pause/resume/cancel call correct endpoints
 */

import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createProjectDb, initializeProjectDb, ProjectAdapter } from '@spatula/db';
import { slugifyPath } from '../../src/local-project.js';
import type { GlobalConfig } from '@spatula/core';

// ---------------------------------------------------------------------------
// Mock: @spatula/core — loadGlobalConfig / saveGlobalConfig
// ---------------------------------------------------------------------------

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
} from '../../src/commands/remote.js';

// ---------------------------------------------------------------------------
// Shared fixture — real SQLite + temp project
// ---------------------------------------------------------------------------

let projectDir: string;
let PROJECT_ID: string;
let adapter: InstanceType<typeof ProjectAdapter>;
let closeDb: () => void;

/**
 * Stubs globalThis.fetch with a sequence of canned responses.
 * Each entry in `responses` is consumed in order.
 */
function mockFetchSequence(
  responses: Array<{ ok: boolean; data?: unknown; status?: number }>,
): void {
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

beforeAll(async () => {
  // 1. Create temp project directory
  projectDir = mkdtempSync(join(tmpdir(), 'spatula-remote-cmds-'));
  PROJECT_ID = slugifyPath(projectDir);

  // 2. Write spatula.yaml
  writeFileSync(
    join(projectDir, 'spatula.yaml'),
    `name: Remote Commands Test
description: Integration testing for remote operations
seeds:
  - https://example.com
depth: 1
limit: 50
`,
  );

  // 3. Create and initialize database
  const dbDir = join(projectDir, '.spatula');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'project.db');
  const { db, close } = createProjectDb(dbPath);
  initializeProjectDb(db, { projectId: PROJECT_ID, name: 'Remote Commands Test' });

  adapter = new ProjectAdapter(db, PROJECT_ID);
  closeDb = close;
});

afterAll(() => {
  closeDb();
  rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. remote add
// ---------------------------------------------------------------------------

describe('remote add (integration)', () => {
  beforeEach(() => {
    mockConfig = { version: 1 };
    mockSaveGlobalConfig.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('saves URL and API key to global config after successful health and auth checks', async () => {
    mockFetchSequence([
      // health check
      { ok: true, data: { status: 'ok' } },
      // subscription/auth check
      { ok: true, data: { data: { plan: 'pro', usage: {} } } },
    ]);

    const result = await runRemoteAdd({
      name: 'prod',
      url: 'https://api.spatula.dev',
      apiKey: 'sk_live_test123',
    });

    expect(result.success).toBe(true);
    expect(result.plan).toBe('pro');
    expect(mockSaveGlobalConfig).toHaveBeenCalledTimes(1);

    const savedConfig = mockSaveGlobalConfig.mock.calls[0][0] as GlobalConfig;
    expect(savedConfig.remotes?.prod).toEqual({
      url: 'https://api.spatula.dev',
      apiKey: 'sk_live_test123',
    });
  });

  it('fails when health check fails (server unreachable)', async () => {
    mockFetchSequence([
      { ok: false, status: 503 },
    ]);

    const result = await runRemoteAdd({
      name: 'down',
      url: 'https://down.example.com',
      apiKey: 'sk_test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('health');
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
  });

  it('fails when auth check fails (401)', async () => {
    mockFetchSequence([
      // health passes
      { ok: true, data: { status: 'ok' } },
      // auth fails
      { ok: false, status: 401 },
    ]);

    const result = await runRemoteAdd({
      name: 'noauth',
      url: 'https://api.spatula.dev',
      apiKey: 'sk_invalid_key',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('auth');
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. remote list
// ---------------------------------------------------------------------------

describe('remote list (integration)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows configured remotes from global config', async () => {
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

  it('includes linked job status from real metaRepo when job is linked', async () => {
    mockConfig = {
      version: 1,
      remotes: {
        prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' },
      },
    };

    // Seed a job link in the real SQLite meta store
    await adapter.metaRepo.set('remote:prod:job_id', 'job-abc-123');

    mockFetchSequence([
      { ok: true, data: { data: { id: 'job-abc-123', status: 'running' } } },
    ]);

    const metaGet = (key: string) => adapter.metaRepo.get(key);
    const result = await runRemoteList(metaGet);

    expect(result.remotes).toHaveLength(1);
    expect(result.remotes[0].jobId).toBe('job-abc-123');
    expect(result.remotes[0].jobStatus).toBe('running');

    // Clean up the meta key
    await adapter.metaRepo.delete('remote:prod:job_id');
  });
});

// ---------------------------------------------------------------------------
// 3. remote remove
// ---------------------------------------------------------------------------

describe('remote remove (integration)', () => {
  beforeEach(() => {
    mockSaveGlobalConfig.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('deletes remote from config and cleans meta entries from real DB', async () => {
    mockConfig = {
      version: 1,
      remotes: {
        staging: { url: 'https://staging.spatula.dev', apiKey: 'sk_staging' },
      },
    };

    // Seed multiple meta keys for this remote in real SQLite
    await adapter.metaRepo.set('remote:staging:job_id', 'job-staging-1');
    await adapter.metaRepo.set('remote:staging:push_hash', 'abc123');
    await adapter.metaRepo.set('remote:staging:last_sync', '2026-03-30T10:00:00Z');

    // Verify they exist before removal
    expect(await adapter.metaRepo.get('remote:staging:job_id')).toBe('job-staging-1');
    expect(await adapter.metaRepo.get('remote:staging:push_hash')).toBe('abc123');

    const metaDeleteByPrefix = (prefix: string) => adapter.metaRepo.deleteByPrefix(prefix);
    const result = await runRemoteRemove('staging', metaDeleteByPrefix);

    expect(result.success).toBe(true);

    // Verify saveGlobalConfig was called with the remote removed
    expect(mockSaveGlobalConfig).toHaveBeenCalledTimes(1);
    const savedConfig = mockSaveGlobalConfig.mock.calls[0][0] as GlobalConfig;
    expect(savedConfig.remotes).toBeUndefined();

    // Verify all meta keys with prefix remote:staging: were cleaned from real DB
    expect(await adapter.metaRepo.get('remote:staging:job_id')).toBeNull();
    expect(await adapter.metaRepo.get('remote:staging:push_hash')).toBeNull();
    expect(await adapter.metaRepo.get('remote:staging:last_sync')).toBeNull();
  });

  it('returns error for non-existent remote', async () => {
    mockConfig = { version: 1 };

    const result = await runRemoteRemove('nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. remote status
// ---------------------------------------------------------------------------

describe('remote status (integration)', () => {
  beforeEach(() => {
    mockConfig = {
      version: 1,
      remotes: {
        prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' },
      },
    };
  });
  afterEach(() => vi.restoreAllMocks());

  it('fetches and returns job status from linked job in real meta DB', async () => {
    // Seed the job link in real SQLite
    await adapter.metaRepo.set('remote:prod:job_id', 'job-status-test');

    mockFetchSequence([
      {
        ok: true,
        data: {
          data: {
            id: 'job-status-test',
            status: 'running',
            pagesCompleted: 42,
            entitiesExtracted: 128,
          },
        },
      },
    ]);

    const metaGet = (key: string) => adapter.metaRepo.get(key);
    const result = await runRemoteStatus('prod', metaGet);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      id: 'job-status-test',
      status: 'running',
      pagesCompleted: 42,
      entitiesExtracted: 128,
    });

    // Clean up
    await adapter.metaRepo.delete('remote:prod:job_id');
  });

  it('returns error when no linked job exists in meta', async () => {
    const metaGet = (key: string) => adapter.metaRepo.get(key);
    const result = await runRemoteStatus('prod', metaGet);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No linked job');
  });
});

// ---------------------------------------------------------------------------
// 5. remote pause/resume/cancel
// ---------------------------------------------------------------------------

describe('remote job actions (integration)', () => {
  beforeEach(async () => {
    mockConfig = {
      version: 1,
      remotes: {
        prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' },
      },
    };
    // Seed a linked job for all action tests
    await adapter.metaRepo.set('remote:prod:job_id', 'job-action-test');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await adapter.metaRepo.delete('remote:prod:job_id');
  });

  it('pause calls the correct API endpoint and succeeds', async () => {
    mockFetchSequence([
      { ok: true, data: { data: { id: 'job-action-test', status: 'paused' } } },
    ]);

    const metaGet = (key: string) => adapter.metaRepo.get(key);
    const result = await runRemoteJobAction('prod', 'pause', metaGet);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ id: 'job-action-test', status: 'paused' });

    // Verify fetch was called with the pause endpoint
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/api/v1/jobs/job-action-test/pause');
  });

  it('resume calls the correct API endpoint and succeeds', async () => {
    mockFetchSequence([
      { ok: true, data: { data: { id: 'job-action-test', status: 'running' } } },
    ]);

    const metaGet = (key: string) => adapter.metaRepo.get(key);
    const result = await runRemoteJobAction('prod', 'resume', metaGet);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ id: 'job-action-test', status: 'running' });

    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/api/v1/jobs/job-action-test/resume');
  });

  it('cancel calls the correct API endpoint and succeeds', async () => {
    mockFetchSequence([
      { ok: true, data: { data: { id: 'job-action-test', status: 'cancelled' } } },
    ]);

    const metaGet = (key: string) => adapter.metaRepo.get(key);
    const result = await runRemoteJobAction('prod', 'cancel', metaGet);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ id: 'job-action-test', status: 'cancelled' });

    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/api/v1/jobs/job-action-test/cancel');
  });
});
