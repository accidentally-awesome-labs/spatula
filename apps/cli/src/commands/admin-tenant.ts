/**
 * `spatula admin tenant` — DSR admin commands for tenant data management.
 *
 * Subcommands:
 *   delete  Enqueue an async tenant deletion and poll to completion (D-07, SEC-09)
 *   export  Fetch a re-importable tenant data dump and write it to disk
 *   import  Re-import a tenant data dump via the admin import route (D-10, SEC-09)
 *
 * All three commands talk to the remote admin API the same way `remote.ts` does —
 * they read the base URL + API key from the global config for the named remote.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';

import { loadGlobalConfig } from '@spatula/core';

import { ApiError } from '../api/client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_REMOTE_NAME = 'default';
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DONE_STATUSES = new Set(['completed', 'done', 'succeeded', 'success']);
const FAIL_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRemoteBaseUrl(remoteName: string): { baseUrl: string; apiKey: string } {
  const config = loadGlobalConfig();
  const remote = config?.remotes?.[remoteName];
  if (!remote?.url || !remote?.apiKey) {
    throw new Error(
      `Remote "${remoteName}" not configured. Run \`spatula remote add ${remoteName}\` first.`,
    );
  }
  return { baseUrl: remote.url.replace(/\/+$/, ''), apiKey: remote.apiKey };
}

async function adminFetch(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, 'NETWORK_ERROR', (err as Error).message);
  }

  if (!response.ok) {
    let code: string | undefined;
    let message = `HTTP ${response.status}`;
    try {
      const errorBody = (await response.clone().json()) as Record<string, unknown>;
      const e = errorBody?.error as Record<string, unknown> | undefined;
      if (e) {
        code = e.code as string | undefined;
        message = (e.message as string) ?? message;
      }
    } catch {
      // Non-JSON error body
    }
    throw new ApiError(response.status, code, message);
  }

  return response;
}

/**
 * Prompt the user for confirmation on a destructive action.
 * Resolves true if the user confirms, false otherwise.
 */
function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim() === 'yes' || answer.toLowerCase().trim() === 'y');
    });
  });
}

/**
 * Sleep for `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve the output file path for an export.
 * If `provided` is given, use it. Otherwise generate a default timestamped path
 * in the current working directory's `.spatula/exports/` folder.
 */
function resolveExportPath(provided: string | undefined, format: string): string {
  if (provided) return resolve(provided);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return join(process.cwd(), '.spatula', 'tenant-exports', `${timestamp}.${format}`);
}

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

export interface AdminTenantDeleteOptions {
  tenant: string;
  /** Skip confirmation prompt */
  yes?: boolean;
  /** Named remote to use (defaults to 'default') */
  remote?: string;
  /** Poll interval in ms — override for tests */
  pollIntervalMs?: number;
}

export interface AdminTenantExportOptions {
  tenant: string;
  format: string;
  /** Output file path — generated if omitted */
  out?: string;
  remote?: string;
}

export interface AdminTenantImportOptions {
  tenant: string;
  /** Path to the dump file produced by `admin tenant export` */
  in: string;
  remote?: string;
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

/**
 * Enqueue an async tenant deletion and poll to completion (D-07).
 *
 * Calls DELETE /api/v1/admin/tenants/:id → receives 202 + jobId.
 * Then polls GET /api/v1/jobs/:jobId until the job is completed or failed.
 * Throws if the deletion job fails (caller should exit(1)).
 */
export async function runAdminTenantDelete(opts: AdminTenantDeleteOptions): Promise<void> {
  const remoteName = opts.remote ?? DEFAULT_REMOTE_NAME;
  const pollInterval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const { baseUrl, apiKey } = getRemoteBaseUrl(remoteName);

  // Confirmation (destructive action) — skip with --yes / --force
  if (!opts.yes) {
    const confirmed = await promptConfirm(
      `\n  WARNING: This will permanently delete ALL data for tenant ${opts.tenant}.\n  Type "yes" to confirm: `,
    );
    if (!confirmed) {
      throw new Error('Deletion aborted — not confirmed by user.');
    }
  }

  console.log(`\n  Enqueuing deletion for tenant ${opts.tenant}...`);

  // DELETE /api/v1/admin/tenants/:id
  const deleteResp = await adminFetch(baseUrl, apiKey, 'DELETE', `/api/v1/admin/tenants/${opts.tenant}`);
  const deleteBody = (await deleteResp.json()) as { data: { status: string; jobId: string } };
  const { jobId } = deleteBody.data;

  if (!jobId) {
    throw new Error('Server did not return a jobId in the 202 response.');
  }

  console.log(`  Deletion job enqueued: ${jobId}`);
  console.log(`  Polling for completion...`);

  // Poll until done or failed
  let attempt = 0;
  while (true) {
    await sleep(pollInterval);
    attempt++;

    const pollResp = await adminFetch(baseUrl, apiKey, 'GET', `/api/v1/jobs/${jobId}`);
    const pollBody = (await pollResp.json()) as {
      data: { id: string; status: string; failedReason?: string; progress?: number };
    };
    const job = pollBody.data;

    if (DONE_STATUSES.has(job.status)) {
      console.log(`  Deletion job ${jobId} complete.`);
      return;
    }

    if (FAIL_STATUSES.has(job.status)) {
      const reason = job.failedReason ?? 'unknown reason';
      throw new Error(`Deletion job ${jobId} failed: ${reason}`);
    }

    // Still in progress — print progress
    const progressStr = job.progress !== undefined ? ` (${job.progress}%)` : '';
    process.stdout.write(`\r  Status: ${job.status}${progressStr}  (attempt ${attempt})`);
  }
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

/**
 * Fetch a re-importable tenant data dump from the server and write it to disk.
 *
 * Calls GET /api/v1/admin/tenants/:id/export?format=jsonl.
 * The server returns the dump as a raw text/plain or application/jsonlines body.
 */
export async function runAdminTenantExport(opts: AdminTenantExportOptions): Promise<void> {
  const remoteName = opts.remote ?? DEFAULT_REMOTE_NAME;
  const { baseUrl, apiKey } = getRemoteBaseUrl(remoteName);

  const format = opts.format ?? 'jsonl';
  const outPath = resolveExportPath(opts.out, format);

  console.log(`\n  Exporting tenant ${opts.tenant} data...`);

  // GET /api/v1/admin/tenants/:id/export?format=<format>
  const resp = await adminFetch(
    baseUrl,
    apiKey,
    'GET',
    `/api/v1/admin/tenants/${opts.tenant}/export?format=${encodeURIComponent(format)}`,
  );

  const content = await resp.text();

  // Ensure output directory exists
  const outDir = dirname(outPath);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  writeFileSync(outPath, content, 'utf-8');

  console.log(`  Export complete.`);
  console.log(`  Format : ${format}`);
  console.log(`  File   : ${outPath}`);
  console.log(`  Size   : ${content.length} bytes`);
  console.log('');
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

/**
 * Re-import a tenant data dump from a file via the admin import route (D-10).
 *
 * Reads the dump file (jsonl format as produced by `admin tenant export`),
 * parses each line as a table record, and POSTs the assembled object to
 * POST /api/v1/admin/tenants/:id/import.
 * Prints the per-table imported counts from the server response.
 */
export async function runAdminTenantImport(opts: AdminTenantImportOptions): Promise<void> {
  const remoteName = opts.remote ?? DEFAULT_REMOTE_NAME;
  const { baseUrl, apiKey } = getRemoteBaseUrl(remoteName);

  if (!existsSync(opts.in)) {
    throw new Error(`Import file not found: ${opts.in}`);
  }

  const raw = readFileSync(opts.in, 'utf-8');

  // Parse the jsonl dump: each line is { table: string, rows: [...] }
  const dump: Record<string, Array<Record<string, unknown>>> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { table: string; rows: Array<Record<string, unknown>> };
      if (obj.table && Array.isArray(obj.rows)) {
        dump[obj.table] = obj.rows;
      }
    } catch {
      // Skip malformed lines
    }
  }

  console.log(`\n  Importing tenant ${opts.tenant} data from ${opts.in}...`);

  const resp = await adminFetch(
    baseUrl,
    apiKey,
    'POST',
    `/api/v1/admin/tenants/${opts.tenant}/import`,
    dump,
  );

  const body = (await resp.json()) as { data: { imported: Record<string, number> } };
  const { imported } = body.data;

  console.log(`  Import complete.`);
  console.log(`  Per-table counts:`);
  for (const [table, count] of Object.entries(imported)) {
    console.log(`    ${table}: ${count}`);
  }
  console.log('');
}
