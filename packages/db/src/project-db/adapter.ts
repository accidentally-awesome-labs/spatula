/**
 * ProjectAdapter — assembles all 12 SQLite repositories from a single DB
 * instance and pre-binds the synthetic project ID.
 *
 * Per spec section 5.7: mirrored repos receive (db, projectId) so that
 * jobId/tenantId parameters on interface methods are accepted but ignored —
 * the pre-bound projectId is always used internally. Local-only repos
 * (run, llm-usage, export, project-meta) receive only (db).
 */
import type { ProjectDatabase } from './connection.js';
import { SqliteJobRepository } from './repositories/job-repository.js';
import { SqlitePageRepository } from './repositories/page-repository.js';
import { SqliteExtractionRepository } from './repositories/extraction-repository.js';
import {
  SqliteEntityRepository,
  SqliteEntitySourceRepository,
} from './repositories/entity-repository.js';
import { SqliteSchemaRepository } from './repositories/schema-repository.js';
import { SqliteCrawlTaskRepository } from './repositories/crawl-task-repository.js';
import { SqliteActionRepository } from './repositories/action-repository.js';
import { SqliteSourceTrustRepository } from './repositories/source-trust-repository.js';
import { RunRepository } from './repositories/run-repository.js';
import { LlmUsageRepository } from './repositories/llm-usage-repository.js';
import { SqliteExportRepository } from './repositories/export-repository.js';
import { ProjectMetaRepository } from './repositories/project-meta-repository.js';

export class ProjectAdapter {
  // Mirrored repos — pre-bound to synthetic project ID
  readonly jobRepo: SqliteJobRepository;
  readonly pageRepo: SqlitePageRepository;
  readonly extractionRepo: SqliteExtractionRepository;
  readonly entityRepo: SqliteEntityRepository;
  readonly entitySourceRepo: SqliteEntitySourceRepository;
  readonly schemaRepo: SqliteSchemaRepository;
  readonly taskRepo: SqliteCrawlTaskRepository;
  readonly actionRepo: SqliteActionRepository;
  readonly sourceTrustRepo: SqliteSourceTrustRepository;

  // Local-only repos — no projectId needed
  readonly runRepo: RunRepository;
  readonly llmUsageRepo: LlmUsageRepository;
  readonly exportRepo: SqliteExportRepository;
  readonly metaRepo: ProjectMetaRepository;

  private readonly _projectId: string;

  constructor(db: ProjectDatabase, projectId: string) {
    this._projectId = projectId;

    // All mirrored repos receive (db, projectId) — pre-binds the synthetic
    // project ID per spec 5.7 so callers never need to pass jobId/tenantId
    this.jobRepo = new SqliteJobRepository(db, projectId);
    this.pageRepo = new SqlitePageRepository(db, projectId);
    this.extractionRepo = new SqliteExtractionRepository(db, projectId);
    this.entityRepo = new SqliteEntityRepository(db, projectId);
    this.entitySourceRepo = new SqliteEntitySourceRepository(db, projectId);
    this.schemaRepo = new SqliteSchemaRepository(db, projectId);
    this.taskRepo = new SqliteCrawlTaskRepository(db, projectId);
    this.actionRepo = new SqliteActionRepository(db, projectId);
    this.sourceTrustRepo = new SqliteSourceTrustRepository(db, projectId);

    // Local-only repos don't have jobId columns — db only
    this.runRepo = new RunRepository(db);
    this.llmUsageRepo = new LlmUsageRepository(db);
    this.exportRepo = new SqliteExportRepository(db);
    this.metaRepo = new ProjectMetaRepository(db);
  }

  /** Get the synthetic project ID (used as jobId in all mirrored repo queries). */
  getProjectId(): string {
    return this._projectId;
  }

  /** Convenience: get a meta value by key. */
  async getMeta(key: string): Promise<string | null> {
    return this.metaRepo.get(key);
  }
}
