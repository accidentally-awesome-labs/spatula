/**
 * `spatula status [jobId]` — show details for a specific crawl job,
 * or for the local project found in the current directory.
 */

import { join } from 'node:path';
import type { SpatulaApiClient } from '../api/client.js';

// ---------------------------------------------------------------------------
// Command runner — API mode
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
// Command runner — local mode
// ---------------------------------------------------------------------------

/**
 * Show status for the local project found at or above `cwd`.
 * Returns true if a project was found and status was printed; false otherwise.
 */
export async function runLocalStatusCommand(cwd: string): Promise<boolean> {
  const { findProjectRoot } = await import('@spatula/core');
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) {
    return false;
  }

  const dbPath = join(projectRoot, '.spatula', 'project.db');
  const { createProjectDb, ProjectAdapter } = await import('@spatula/db');
  const { LocalDataSource } = await import('@spatula/core');

  // Derive the same projectId slug that `spatula run` uses when it creates the DB.
  const projectId = slugifyPath(projectRoot);

  const { db, close } = createProjectDb(dbPath);
  try {
    const adapter = new ProjectAdapter(db, projectId);
    const dataSource = new LocalDataSource(adapter);
    const status = await dataSource.getStatus();
    console.log(formatLocalStatus(status, projectRoot));
  } finally {
    close();
  }

  return true;
}

// ---------------------------------------------------------------------------
// Formatting — API mode
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mirror the slugify logic from `spatula run` so the projectId matches
 * what was used when the DB was first created.
 */
function slugifyPath(absPath: string): string {
  const parts = absPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts
    .slice(-2)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
}

// ---------------------------------------------------------------------------
// Formatting — local mode
// ---------------------------------------------------------------------------

interface LocalStatus {
  totalPages: number;
  totalEntities: number;
  pendingActions: number;
  schemaFields: number;
  lastRun?: {
    id: string;
    status: string;
    startedAt: string;
    pagesProcessed: number;
    entitiesCreated: number;
  };
  storageBytes: { pages: number; database: number; exports: number };
}

/**
 * Render local project status as a human-readable block.
 */
export function formatLocalStatus(status: LocalStatus, projectRoot: string): string {
  const lines: string[] = [];

  lines.push(`Project: ${projectRoot}`);
  lines.push('');
  lines.push('Local project status:');
  lines.push(`  Pages processed : ${status.totalPages}`);
  lines.push(`  Entities        : ${status.totalEntities}`);
  lines.push(`  Schema fields   : ${status.schemaFields}`);
  lines.push(`  Pending actions : ${status.pendingActions}`);

  if (status.lastRun) {
    lines.push('');
    lines.push('Last run:');
    lines.push(`  ID              : ${status.lastRun.id}`);
    lines.push(`  Status          : ${status.lastRun.status}`);
    lines.push(`  Started at      : ${status.lastRun.startedAt}`);
    lines.push(`  Pages processed : ${status.lastRun.pagesProcessed}`);
    lines.push(`  Entities created: ${status.lastRun.entitiesCreated}`);
  } else {
    lines.push('');
    lines.push('No runs recorded yet.');
  }

  return lines.join('\n');
}
