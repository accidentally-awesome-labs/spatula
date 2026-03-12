/**
 * `spatula status <jobId>` — show details for a specific crawl job.
 */

import type { SpatulaApiClient } from '../api/client.js';

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

/**
 * Fetch a single job by ID from the API.
 */
export async function runStatusCommand(
  client: SpatulaApiClient,
  jobId: string,
): Promise<Record<string, unknown>> {
  return client.getJob(jobId);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Stat keys to display and their human-readable labels. */
const STAT_LABELS: [string, string][] = [
  ['pagesDiscovered', 'Pages Discovered'],
  ['pagesCompleted', 'Pages Completed'],
  ['pagesFailed', 'Pages Failed'],
  ['entitiesExtracted', 'Entities Extracted'],
  ['entitiesReconciled', 'Entities Reconciled'],
];

/**
 * Render a job's details as a human-readable block.
 */
export function formatJobDetail(job: Record<string, unknown>): string {
  const lines: string[] = [];

  lines.push(`Name:   ${String(job.name ?? '-')}`);
  lines.push(`ID:     ${String(job.id ?? '-')}`);
  lines.push(`Status: ${String(job.status ?? '-')}`);

  // Optional stats
  const hasStats = STAT_LABELS.some(([key]) => job[key] !== undefined);
  if (hasStats) {
    lines.push('');
    lines.push('Stats:');
    for (const [key, label] of STAT_LABELS) {
      if (job[key] !== undefined) {
        lines.push(`  ${label}: ${String(job[key])}`);
      }
    }
  }

  return lines.join('\n');
}
