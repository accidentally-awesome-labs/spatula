/**
 * `spatula list` — list crawl jobs with optional filters.
 */

import type { SpatulaApiClient } from '../api/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ListOptions {
  status?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

/**
 * Fetch jobs from the API, forwarding optional query parameters.
 */
export async function runListCommand(
  client: SpatulaApiClient,
  options: ListOptions,
): Promise<Record<string, unknown>[]> {
  const query: Record<string, unknown> = {};
  if (options.status) {
    query.status = options.status;
  }
  if (options.limit !== undefined) {
    query.limit = options.limit;
  }
  return client.listJobs(query);
}

// ---------------------------------------------------------------------------
// Deprecation
// ---------------------------------------------------------------------------

/**
 * Print a deprecation notice for `spatula list`.
 */
export function printListDeprecation(): void {
  console.warn(
    '\n  ⚠ `spatula list` is deprecated. Use `spatula remote jobs <name>` (coming in a future release).\n' +
      '  For local project status, use `spatula status`.\n',
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Render a list of jobs as a simple text table with ID | Name | Status columns.
 * Returns "No jobs found." when the list is empty.
 */
export function formatJobsTable(jobs: Record<string, unknown>[]): string {
  if (jobs.length === 0) {
    return 'No jobs found.';
  }

  const header = { id: 'ID', name: 'Name', status: 'Status' };

  const rows = jobs.map((job) => ({
    id: String(job.id ?? '-'),
    name: String(job.name ?? '-'),
    status: String(job.status ?? '-'),
  }));

  // Compute column widths
  const idWidth = Math.max(header.id.length, ...rows.map((r) => r.id.length));
  const nameWidth = Math.max(header.name.length, ...rows.map((r) => r.name.length));
  const statusWidth = Math.max(header.status.length, ...rows.map((r) => r.status.length));

  const pad = (s: string, w: number) => s.padEnd(w);
  const line = (id: string, name: string, status: string) =>
    `${pad(id, idWidth)}  ${pad(name, nameWidth)}  ${pad(status, statusWidth)}`.trimEnd();

  const separator =
    `${'-'.repeat(idWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(statusWidth)}`.trimEnd();

  const lines = [
    line(header.id, header.name, header.status),
    separator,
    ...rows.map((r) => line(r.id, r.name, r.status)),
  ];

  return lines.join('\n');
}
