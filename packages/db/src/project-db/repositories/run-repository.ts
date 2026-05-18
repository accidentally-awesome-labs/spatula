/**
 * SQLite run repository — local-only, no Postgres equivalent.
 *
 * Tracks each invocation of `spatula run`. This is a local-only
 * repository: constructor takes only (db) with no projectId.
 */
import { eq, desc, inArray, like } from 'drizzle-orm';
import type { ProjectDatabase } from '../connection.js';
import { runs } from '../../schema-sqlite/runs.js';
import { wrapStorageError } from './utils.js';

export class RunRepository {
  constructor(private readonly db: ProjectDatabase) {}

  async create(data: {
    status: string;
    source: string;
    configSnapshot: Record<string, unknown>;
    startedAt: string;
  }): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    wrapStorageError(
      () =>
        this.db
          .insert(runs)
          .values({
            id,
            status: data.status,
            source: data.source,
            configSnapshot: data.configSnapshot,
            startedAt: data.startedAt,
          })
          .run(),
      { operation: 'create', table: 'runs' },
    );
    return { id };
  }

  async findLatestByStatus(statuses: string[]): Promise<{
    id: string;
    status: string;
    source: string;
    configSnapshot: Record<string, unknown>;
    startedAt: string;
    completedAt: string | null;
  } | null> {
    if (statuses.length === 0) return null;

    const row = this.db
      .select()
      .from(runs)
      .where(inArray(runs.status, statuses))
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .get();

    return row ?? null;
  }

  async findById(id: string): Promise<{
    id: string;
    status: string;
    source: string;
    configSnapshot: Record<string, unknown>;
    startedAt: string;
    completedAt: string | null;
    pagesCrawled: number | null;
    pagesReextracted: number | null;
    entitiesCreated: number | null;
    llmTokensUsed: number | null;
    llmCostUsd: number | null;
    errorMessage: string | null;
  } | null> {
    const row = this.db.select().from(runs).where(eq(runs.id, id)).get();

    return row ?? null;
  }

  async updateStatus(id: string, status: string, completedAt?: string): Promise<void> {
    wrapStorageError(
      () =>
        this.db
          .update(runs)
          .set({
            status,
            ...(completedAt ? { completedAt } : {}),
          })
          .where(eq(runs.id, id))
          .run(),
      { operation: 'updateStatus', table: 'runs', id },
    );
  }

  async updateStats(
    id: string,
    stats: {
      pagesCrawled?: number;
      pagesReextracted?: number;
      entitiesCreated?: number;
      llmTokensUsed?: number;
      llmCostUsd?: number;
      errorMessage?: string;
    },
  ): Promise<void> {
    wrapStorageError(() => this.db.update(runs).set(stats).where(eq(runs.id, id)).run(), {
      operation: 'updateStats',
      table: 'runs',
      id,
    });
  }

  async findIdsBySourcePrefix(prefix: string): Promise<string[]> {
    const rows = this.db
      .select({ id: runs.id })
      .from(runs)
      .where(like(runs.source, `${prefix}%`))
      .all();
    return rows.map((r) => r.id);
  }
}
