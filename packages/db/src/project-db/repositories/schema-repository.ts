/**
 * SQLite schema repository — local project mode.
 *
 * Implements SchemaRepo from @spatula/core/pipeline/types.ts.
 *
 * Per spec 5.7: constructor takes (db, projectId). The jobId/tenantId
 * parameters on interface methods are accepted but ignored — the
 * pre-bound projectId is always used.
 */
import { eq, desc } from 'drizzle-orm';
import type { SchemaDefinition } from '@spatula/core';
import type { SchemaRepo } from '@spatula/core/pipeline/types.js';
import type { ProjectDatabase } from '../connection.js';
import { schemasTable } from '../../schema-sqlite/schemas.js';
import { wrapStorageError } from './utils.js';

export class SqliteSchemaRepository implements SchemaRepo {
  constructor(
    private readonly db: ProjectDatabase,
    private readonly projectId: string,
  ) {}

  async findLatest(
    _jobId: string,
    _tenantId?: string,
  ): Promise<{ id: string; version: number; definition: SchemaDefinition } | null> {
    const row = this.db
      .select()
      .from(schemasTable)
      .where(eq(schemasTable.jobId, this.projectId))
      .orderBy(desc(schemasTable.version))
      .limit(1)
      .get();

    return row ?? null;
  }

  async create(data: {
    jobId: string;
    tenantId: string;
    version: number;
    definition: SchemaDefinition;
    parentId?: string;
  }): Promise<unknown> {
    const id = crypto.randomUUID();
    wrapStorageError(
      () => {
        this.db
          .insert(schemasTable)
          .values({
            id,
            jobId: this.projectId,
            version: data.version,
            definition: data.definition,
            parentId: data.parentId ?? null,
            createdAt: new Date().toISOString(),
          })
          .run();
      },
      { method: 'create', table: 'schemas' },
    );
    return { id };
  }

  /**
   * List all schema versions ordered by version descending.
   * Not part of the pipeline interface — used by CLI for schema history.
   */
  async findAllVersions(_jobId: string): Promise<
    Array<{
      id: string;
      version: number;
      definition: SchemaDefinition;
      parentId: string | null;
      createdAt: string;
    }>
  > {
    return this.db
      .select()
      .from(schemasTable)
      .where(eq(schemasTable.jobId, this.projectId))
      .orderBy(desc(schemasTable.version))
      .all();
  }
}
