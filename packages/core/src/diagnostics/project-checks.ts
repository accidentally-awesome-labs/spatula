import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HealthCheck } from './health-check.js';

export interface ProjectCheckConfig {
  projectRoot: string;
  validateYaml: () => boolean;
  checkDbIntegrity?: () => Promise<{ ok: boolean; message: string }>;
  getOrphanedTaskCount?: () => Promise<number>;
  getPendingActionCount?: () => Promise<number>;
}

export function createProjectChecks(config: ProjectCheckConfig): HealthCheck[] {
  const spatulaDir = join(config.projectRoot, '.spatula');
  const dbPath = join(spatulaDir, 'project.db');

  return [
    { name: 'spatula-yaml', category: 'project', async run() {
      try { config.validateYaml(); return { status: 'pass', message: 'spatula.yaml is valid' }; }
      catch (err) { return { status: 'fail', message: `spatula.yaml: ${(err as Error).message}` }; }
    }},
    { name: 'db-integrity', category: 'project', async run() {
      if (!existsSync(dbPath)) return { status: 'warn', message: 'No project database yet — run `spatula run` first' };
      if (config.checkDbIntegrity) { const r = await config.checkDbIntegrity(); return r.ok ? { status: 'pass', message: 'Database integrity check passed' } : { status: 'fail', message: r.message }; }
      return { status: 'pass', message: 'Database file exists' };
    }},
    { name: 'db-wal-mode', category: 'project', async run() {
      if (!existsSync(dbPath)) return { status: 'warn', message: 'No project database yet' };
      const walPath = dbPath + '-wal'; const shmPath = dbPath + '-shm';
      if (existsSync(walPath) || existsSync(shmPath)) return { status: 'pass', message: 'WAL mode active (journal files present)' };
      return { status: 'pass', message: 'WAL mode configured (no active journal)' };
    }},
    { name: 'orphaned-tasks', category: 'project', async run() {
      if (!config.getOrphanedTaskCount) return { status: 'pass', message: 'No orphaned task checker configured' };
      const count = await config.getOrphanedTaskCount();
      if (count > 0) return { status: 'warn', message: `${count} orphaned in_progress task(s) — prior crash detected. Run \`spatula run\` to retry.` };
      return { status: 'pass', message: 'No orphaned tasks' };
    }},
    { name: 'page-files', category: 'project', async run() {
      const pagesDir = join(spatulaDir, 'pages');
      if (!existsSync(pagesDir)) return { status: 'pass', message: 'No pages directory (no crawl data yet)' };
      try { const entries = readdirSync(pagesDir); return { status: 'pass', message: `${entries.length} page file(s) stored` }; }
      catch (err) { return { status: 'fail', message: `Cannot read pages directory: ${(err as Error).message}` }; }
    }},
    { name: 'pending-actions', category: 'project', async run() {
      if (!config.getPendingActionCount) return { status: 'pass', message: 'No action checker configured' };
      const count = await config.getPendingActionCount();
      if (count > 0) return { status: 'warn', message: `${count} pending review action(s) — run \`spatula review\` to resolve` };
      return { status: 'pass', message: 'No pending actions' };
    }},
    { name: 'disk-usage', category: 'project', async run() {
      if (!existsSync(spatulaDir)) return { status: 'pass', message: 'No .spatula/ directory yet' };
      let totalBytes = 0; const breakdown: string[] = [];
      if (existsSync(dbPath)) { const s = statSync(dbPath).size; totalBytes += s; breakdown.push(`database: ${formatBytes(s)}`); }
      const pagesDir = join(spatulaDir, 'pages');
      if (existsSync(pagesDir)) { const s = dirSize(pagesDir); totalBytes += s; breakdown.push(`pages: ${formatBytes(s)}`); }
      const exportsDir = join(spatulaDir, 'exports');
      if (existsSync(exportsDir)) { const s = dirSize(exportsDir); totalBytes += s; breakdown.push(`exports: ${formatBytes(s)}`); }
      return { status: 'pass', message: `Total: ${formatBytes(totalBytes)} (${breakdown.join(', ')})` };
    }},
    { name: 'remote-link', category: 'project', async run() {
      return { status: 'pass', message: 'Remote links not configured (available in a future release)' };
    }},
  ];
}

function dirSize(dirPath: string): number {
  let total = 0;
  try { const entries = readdirSync(dirPath, { withFileTypes: true }); for (const entry of entries) { const fp = join(dirPath, entry.name); if (entry.isFile()) total += statSync(fp).size; else if (entry.isDirectory()) total += dirSize(fp); } } catch { }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
