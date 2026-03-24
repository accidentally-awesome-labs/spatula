/**
 * SQLite project database connection factory.
 *
 * Creates and initializes per-project SQLite databases with Drizzle ORM,
 * WAL mode, and automatic migration application.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../schema-sqlite/index.js';
import { projectMeta } from '../schema-sqlite/project-meta.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Drizzle ORM instance typed with the SQLite schema. */
export type ProjectDatabase = ReturnType<typeof drizzle<typeof schema>>;

/** Return value from createProjectDb — includes both Drizzle and raw sqlite handles. */
export interface ProjectDbResult {
  /** Drizzle ORM instance for type-safe queries. */
  db: ProjectDatabase;
  /** Raw better-sqlite3 instance for shutdown (sqlite.close()) and pragmas. */
  sqlite: Database.Database;
}

/**
 * Create a configured SQLite database connection.
 *
 * Sets pragmas for performance and correctness:
 * - WAL mode for concurrent reads
 * - Foreign keys enforced
 * - Busy timeout 5s (for concurrent access from CLI + watcher)
 * - Synchronous NORMAL (safe with WAL)
 */
export function createProjectDb(dbPath: string): ProjectDbResult {
  const sqlite = new Database(dbPath);

  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');

  const db = drizzle(sqlite, { schema });

  return { db, sqlite };
}

/**
 * Apply migrations and seed initial project metadata.
 *
 * - Migrations are applied synchronously via drizzle-orm/better-sqlite3/migrator.
 * - Seeding uses INSERT OR IGNORE (onConflictDoNothing) so repeated calls are safe.
 */
export function initializeProjectDb(
  db: ProjectDatabase,
  meta: { projectId: string; name: string },
): void {
  // Apply migrations (synchronous for better-sqlite3)
  try {
    migrate(db, {
      migrationsFolder: resolve(__dirname, '../../drizzle-sqlite'),
    });
  } catch (err) {
    throw new Error(
      `Failed to initialize project database: ${err instanceof Error ? err.message : String(err)}. ` +
        `Ensure migration files exist at ${resolve(__dirname, '../../drizzle-sqlite')}`,
      { cause: err as Error },
    );
  }

  // Seed project metadata (idempotent)
  const now = new Date().toISOString();

  db.insert(projectMeta)
    .values({ key: 'schema_version', value: '1' })
    .onConflictDoNothing()
    .run();

  db.insert(projectMeta)
    .values({ key: 'project_id', value: meta.projectId })
    .onConflictDoNothing()
    .run();

  db.insert(projectMeta)
    .values({ key: 'project_name', value: meta.name })
    .onConflictDoNothing()
    .run();

  db.insert(projectMeta)
    .values({ key: 'created_at', value: now })
    .onConflictDoNothing()
    .run();
}
