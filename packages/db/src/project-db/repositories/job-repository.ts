/**
 * SQLite synthetic job repository — local project mode.
 *
 * There is NO jobs table in the SQLite schema. The "job" IS the project.
 * This repository composes a synthetic job row from `project_meta` + the
 * latest `run`, satisfying the JobRepo interface from @accidentally-awesome-labs/spatula-core so
 * that all four orchestrators work unchanged in local mode.
 *
 * Per spec 5.7: constructor takes (db, projectId). The jobId/tenantId
 * parameters on interface methods are accepted but ignored — the
 * pre-bound projectId is always used.
 */
import { eq, desc } from 'drizzle-orm';
import { createLogger } from '@accidentally-awesome-labs/spatula-shared';
import type { JobRepo } from '@accidentally-awesome-labs/spatula-core/pipeline/types.js';
import type { ProjectDatabase } from '../connection.js';
import { runs } from '../../schema-sqlite/runs.js';
import { wrapStorageError } from './utils.js';

const logger = createLogger('sqlite:job-repo');

export class SqliteJobRepository implements JobRepo {
  constructor(
    private readonly db: ProjectDatabase,
    private readonly projectId: string,
  ) {}

  async findById(
    _jobId: string,
    _tenantId: string,
  ): Promise<{ id: string; config: unknown; status?: string } | null> {
    const latestRun = this.db.select().from(runs).orderBy(desc(runs.startedAt)).limit(1).get();

    // If no runs exist yet, return null (orchestrators handle null from findById)
    if (!latestRun) {
      logger.debug({ projectId: this.projectId }, 'findById returned null — no runs exist');
      return null;
    }

    return {
      id: this.projectId,
      config: latestRun.configSnapshot,
      status: latestRun.status,
    };
  }

  async updateStatus(_jobId: string, _tenantId: string, status: string): Promise<unknown> {
    const latestRun = this.db.select().from(runs).orderBy(desc(runs.startedAt)).limit(1).get();

    if (latestRun) {
      wrapStorageError(
        () => this.db.update(runs).set({ status }).where(eq(runs.id, latestRun.id)).run(),
        { operation: 'updateStatus', projectId: this.projectId },
      );
    }

    return {};
  }
}
