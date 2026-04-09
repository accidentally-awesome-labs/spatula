/**
 * `spatula reset` — wipe `.spatula/` working state for the current project.
 *
 * Finds the project root (spatula.yaml), then removes the contents of the
 * `.spatula/` directory and recreates the standard directory structure.
 *
 * Flags:
 *   --keep-exports   Preserve the exports/ subdirectory
 *   --keep-entities  Preserve the project.db SQLite database
 *   --keep-remote    Preserve remote job links and pulled data (implies --keep-entities)
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPATULA_DIR = '.spatula';

/** Subdirectories that `spatula init` creates — recreated after a reset. */
const SUBDIRS = ['pages', 'exports', 'cache/robots', 'logs'] as const;

const PROJECT_FILE = 'spatula.yaml';

/** The SQLite database file kept by `--keep-entities`. */
const DB_FILE = 'project.db';

/** The exports subdirectory kept by `--keep-exports`. */
const EXPORTS_DIR = 'exports';

// ---------------------------------------------------------------------------
// Internal: project root detection (mirrors packages/core/src/config/project-detection.ts)
// ---------------------------------------------------------------------------

function findProjectRoot(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, PROJECT_FILE))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ResetOptions {
  /** Preserve the exports/ subdirectory and its contents. */
  keepExports?: boolean;
  /** Preserve the project.db SQLite database. */
  keepEntities?: boolean;
  /** Preserve remote job links and pulled data from remote servers. */
  keepRemote?: boolean;
  /** Working directory to search from (defaults to process.cwd()). */
  cwd?: string;
}

export interface ResetResult {
  projectRoot: string;
  spatulaDir: string;
  removedItems: string[];
  keptItems: string[];
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

export async function runResetCommand(options: ResetOptions = {}): Promise<ResetResult> {
  // --keep-remote implies --keep-entities (remote state lives in SQLite DB)
  if (options.keepRemote) {
    options.keepEntities = true;
  }

  const cwd = options.cwd ?? process.cwd();

  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) {
    const err = new Error(
      'No spatula.yaml found. Run `spatula init` to create a project here.',
    );
    (err as any).code = 'ENOPROJECT';
    throw err;
  }

  const spatulaDir = join(projectRoot, SPATULA_DIR);

  if (!existsSync(spatulaDir)) {
    // Nothing to reset — recreate the directory structure and return.
    await recreateSubdirs(spatulaDir);
    return {
      projectRoot,
      spatulaDir,
      removedItems: [],
      keptItems: [],
    };
  }

  const removedItems: string[] = [];
  const keptItems: string[] = [];

  // Enumerate top-level entries in .spatula/
  const entries = readdirSync(spatulaDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(spatulaDir, entry.name);

    // Decide whether to keep this entry
    if (options.keepExports && entry.name === EXPORTS_DIR) {
      keptItems.push(entry.name);
      continue;
    }

    if (options.keepEntities && entry.name === DB_FILE) {
      keptItems.push(entry.name);
      continue;
    }

    rmSync(entryPath, { recursive: true, force: true });
    removedItems.push(entry.name);
  }

  // Recreate the standard directory structure (skips dirs that still exist)
  await recreateSubdirs(spatulaDir);

  // Selective DB cleanup for --keep-remote
  if (options.keepRemote) {
    const dbPath = join(spatulaDir, DB_FILE);
    if (existsSync(dbPath)) {
      // Use raw better-sqlite3 handle for bulk deletes
      const Database = (await import('better-sqlite3')).default;
      const sqlite = new Database(dbPath);
      sqlite.pragma('foreign_keys = ON');
      try {
        // Delete local entities (runId null = pre-pull local, non-remote prefix = local runs)
        sqlite.prepare(`DELETE FROM entities WHERE run_id IS NULL OR run_id NOT LIKE 'remote:%'`).run();
        sqlite.prepare(`DELETE FROM extractions WHERE run_id IS NULL OR run_id NOT LIKE 'remote:%'`).run();
        sqlite.prepare(`DELETE FROM actions WHERE run_id IS NULL OR run_id NOT LIKE 'remote:%'`).run();
        // crawl_tasks and pages are always local
        sqlite.prepare('DELETE FROM crawl_tasks').run();
        sqlite.prepare('DELETE FROM pages').run();
        // Delete local runs
        sqlite.prepare(`DELETE FROM runs WHERE source = 'local'`).run();
        // Preserve remote:* keys and core metadata
        sqlite.prepare(`DELETE FROM project_meta WHERE key NOT LIKE 'remote:%' AND key NOT IN ('schema_version','project_id','project_name','created_at')`).run();
      } finally {
        sqlite.close();
      }
    }
  }

  return {
    projectRoot,
    spatulaDir,
    removedItems,
    keptItems,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function recreateSubdirs(spatulaDir: string): Promise<void> {
  for (const subdir of SUBDIRS) {
    await mkdir(join(spatulaDir, subdir), { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Formatted output
// ---------------------------------------------------------------------------

export function formatResetResult(result: ResetResult): string {
  const lines: string[] = [];
  lines.push(`Spatula project reset.`);
  lines.push('');
  lines.push(`  Project root : ${result.projectRoot}`);
  lines.push(`  Working dir  : ${result.spatulaDir}/`);

  if (result.removedItems.length > 0) {
    lines.push('');
    lines.push('  Removed:');
    for (const item of result.removedItems) {
      lines.push(`    ${item}`);
    }
  }

  if (result.keptItems.length > 0) {
    lines.push('');
    lines.push('  Preserved:');
    for (const item of result.keptItems) {
      lines.push(`    ${item}`);
    }
  }

  lines.push('');
  lines.push('Directory structure recreated. Run `spatula run` to start a fresh crawl.');
  return lines.join('\n');
}
