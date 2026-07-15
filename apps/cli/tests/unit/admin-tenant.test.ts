/**
 * Unit tests for `spatula admin tenant delete | export | import` commands.
 *
 * All HTTP transport is mocked — no real server required.
 * Tests verify: delete polls to completion + exits non-zero on job failure;
 * export writes a file to disk; import POSTs the dump and prints counts.
 */

import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi, type MockedFunction } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: node:readline (for the confirmation prompt in delete)
// ---------------------------------------------------------------------------
vi.mock('node:readline', () => {
  return {
    createInterface: vi.fn(() => ({
      question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('yes')),
      close: vi.fn(),
    })),
  };
});

// ---------------------------------------------------------------------------
// Mock: @accidentally-awesome-labs/spatula-core — loadGlobalConfig
// ---------------------------------------------------------------------------
const mockGlobalConfig = {
  version: 1,
  remotes: {
    default: { url: 'http://localhost:3000', apiKey: 'sk_live_test' },
  },
};

vi.mock('@accidentally-awesome-labs/spatula-core', async () => {
  const actual = await vi.importActual<typeof import('@accidentally-awesome-labs/spatula-core')>(
    '@accidentally-awesome-labs/spatula-core',
  );
  return {
    ...actual,
    loadGlobalConfig: () => mockGlobalConfig,
    saveGlobalConfig: vi.fn(),
  };
});

// Import AFTER mocks
import {
  runAdminTenantDelete,
  runAdminTenantExport,
  runAdminTenantImport,
  type AdminTenantDeleteOptions,
  type AdminTenantExportOptions,
  type AdminTenantImportOptions,
} from '../../src/commands/admin-tenant.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a series of fetch mock responses consumed in order.
 */
function mockFetchSequence(
  responses: Array<{ ok: boolean; data?: unknown; status?: number; text?: string }>,
): void {
  const mockFn = vi.fn();
  for (const r of responses) {
    mockFn.mockResolvedValueOnce({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      text: () => Promise.resolve(r.text ?? ''),
      json: () =>
        Promise.resolve(
          r.ok
            ? { data: r.data ?? { status: 'ok' } }
            : { error: { code: 'INTERNAL_ERROR', message: 'fail' } },
        ),
    });
  }
  vi.stubGlobal('fetch', mockFn);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'spatula-admin-tenant-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('runAdminTenantDelete', () => {
  const TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const JOB_ID = 'job-abc123';

  it('enqueues deletion, polls to completion, returns success', async () => {
    mockFetchSequence([
      // DELETE /api/v1/admin/tenants/:id — 202 + jobId
      { ok: true, status: 202, data: { status: 'pending', jobId: JOB_ID } },
      // poll 1 — still active
      { ok: true, data: { id: JOB_ID, status: 'active', progress: 50 } },
      // poll 2 — completed
      { ok: true, data: { id: JOB_ID, status: 'completed' } },
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const opts: AdminTenantDeleteOptions = {
      tenant: TENANT_ID,
      yes: true, // skip confirmation prompt
      remote: 'default',
      pollIntervalMs: 1, // fast polling in tests
    };

    await expect(runAdminTenantDelete(opts)).resolves.not.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('complete'));
  });

  it('exits non-zero if the deletion job fails', async () => {
    mockFetchSequence([
      // DELETE — 202 + jobId
      { ok: true, status: 202, data: { status: 'pending', jobId: JOB_ID } },
      // poll — failed
      { ok: true, data: { id: JOB_ID, status: 'failed', failedReason: 'cascade error' } },
    ]);

    vi.spyOn(console, 'error').mockImplementation(() => {});

    const opts: AdminTenantDeleteOptions = {
      tenant: TENANT_ID,
      yes: true,
      remote: 'default',
      pollIntervalMs: 1,
    };

    // Should throw an error indicating failure (caller should exit(1))
    await expect(runAdminTenantDelete(opts)).rejects.toThrow(/failed|cascade error/i);
  });

  it('prompts for confirmation when --yes is not passed', async () => {
    mockFetchSequence([
      { ok: true, status: 202, data: { status: 'pending', jobId: JOB_ID } },
      { ok: true, data: { id: JOB_ID, status: 'completed' } },
    ]);

    vi.spyOn(console, 'log').mockImplementation(() => {});

    // readline mock auto-answers 'yes' so this should succeed
    const opts: AdminTenantDeleteOptions = {
      tenant: TENANT_ID,
      yes: false, // trigger confirmation
      remote: 'default',
      pollIntervalMs: 1,
    };

    await expect(runAdminTenantDelete(opts)).resolves.not.toThrow();
  });

  it('aborts if the user declines confirmation', async () => {
    // Override readline mock to return 'no'
    const readline = await import('node:readline');
    (
      readline.createInterface as MockedFunction<typeof readline.createInterface>
    ).mockReturnValueOnce({
      question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('no')),
      close: vi.fn(),
    } as unknown as ReturnType<typeof readline.createInterface>);

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const opts: AdminTenantDeleteOptions = {
      tenant: TENANT_ID,
      yes: false,
      remote: 'default',
      pollIntervalMs: 1,
    };

    await expect(runAdminTenantDelete(opts)).rejects.toThrow(/aborted|cancelled/i);
  });
});

describe('runAdminTenantExport', () => {
  const TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('fetches the tenant dump and writes a jsonl file to disk', async () => {
    const dumpContent =
      '{"table":"api_keys","rows":[{"id":"key-1","tenantId":"t1"}]}\n' +
      '{"table":"jobs","rows":[]}\n';

    mockFetchSequence([
      {
        ok: true,
        text: dumpContent,
        data: undefined,
      },
    ]);

    // Override fetch text() for this test (dump is raw text, not JSON)
    const mockFetchFn = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(dumpContent),
      json: () => Promise.reject(new Error('should not call json')),
    });
    vi.stubGlobal('fetch', mockFetchFn);

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const outPath = join(tmpDir, 'dump.jsonl');
    const opts: AdminTenantExportOptions = {
      tenant: TENANT_ID,
      format: 'jsonl',
      out: outPath,
      remote: 'default',
    };

    await runAdminTenantExport(opts);

    expect(existsSync(outPath)).toBe(true);
    const written = readFileSync(outPath, 'utf-8');
    expect(written).toContain('api_keys');
  });

  it('uses a default timestamped path when --out is not specified', async () => {
    const dumpContent = '{"table":"api_keys","rows":[]}\n';
    const mockFetchFn = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(dumpContent),
      json: () => Promise.reject(new Error('should not call json')),
    });
    vi.stubGlobal('fetch', mockFetchFn);

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const opts: AdminTenantExportOptions = {
      tenant: TENANT_ID,
      format: 'jsonl',
      out: undefined, // use default path
      remote: 'default',
    };

    // Should not throw — file is written somewhere
    await expect(runAdminTenantExport(opts)).resolves.not.toThrow();
  });
});

describe('runAdminTenantImport', () => {
  const TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('reads a dump file and POSTs it, printing per-table counts', async () => {
    // Create a temp dump file
    const dumpPath = join(tmpDir, 'import.jsonl');
    const dumpContent = '{"table":"api_keys","rows":[{"id":"key-1"},{"id":"key-2"}]}\n';
    writeFileSync(dumpPath, dumpContent, 'utf-8');

    mockFetchSequence([
      {
        ok: true,
        data: { imported: { api_keys: 2 } },
      },
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const opts: AdminTenantImportOptions = {
      tenant: TENANT_ID,
      in: dumpPath,
      remote: 'default',
    };

    await runAdminTenantImport(opts);

    // Should print the import counts
    const allOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toMatch(/api_keys.*2|2.*api_keys/);
  });

  it('throws if the input file does not exist', async () => {
    const opts: AdminTenantImportOptions = {
      tenant: TENANT_ID,
      in: join(tmpDir, 'nonexistent.jsonl'),
      remote: 'default',
    };

    await expect(runAdminTenantImport(opts)).rejects.toThrow(/not found|ENOENT|does not exist/i);
  });
});
