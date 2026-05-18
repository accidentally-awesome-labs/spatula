/**
 * SQLite project-meta repository — local-only, no Postgres equivalent.
 *
 * Simple key-value store for project state (project_id, schema_version,
 * name, created_at, remote job links, pull cursors).
 *
 * This is a local-only repository: constructor takes only (db) with
 * no projectId.
 */
import { eq, like } from 'drizzle-orm';
import type { ProjectDatabase } from '../connection.js';
import { projectMeta } from '../../schema-sqlite/project-meta.js';
import { wrapStorageError } from './utils.js';

export class ProjectMetaRepository {
  constructor(private readonly db: ProjectDatabase) {}

  async get(key: string): Promise<string | null> {
    const row = this.db.select().from(projectMeta).where(eq(projectMeta.key, key)).get();

    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    wrapStorageError(
      () =>
        this.db
          .insert(projectMeta)
          .values({ key, value })
          .onConflictDoUpdate({
            target: projectMeta.key,
            set: { value },
          })
          .run(),
      { operation: 'set', table: 'project_meta', key },
    );
  }

  async getAll(): Promise<Record<string, string>> {
    const rows = this.db.select().from(projectMeta).all();

    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async delete(key: string): Promise<void> {
    wrapStorageError(() => this.db.delete(projectMeta).where(eq(projectMeta.key, key)).run(), {
      operation: 'delete',
      table: 'project_meta',
      key,
    });
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    wrapStorageError(
      () =>
        this.db
          .delete(projectMeta)
          .where(like(projectMeta.key, `${prefix}%`))
          .run(),
      { operation: 'deleteByPrefix', table: 'project_meta', prefix },
    );
  }
}
