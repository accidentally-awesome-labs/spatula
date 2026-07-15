/**
 * LocalDataSource — SQLite-backed DataSource implementation for local mode.
 *
 * Delegates all operations to the ProjectAdapter's repositories.
 * Per spec 5.7: uses adapter.getProjectId() for both jobId and tenantId
 * parameters in all mirrored repo calls (local mode, projectId serves as both).
 *
 * The adapter parameter is typed as a structural interface so that
 * @accidentally-awesome-labs/spatula-core does not take a hard dependency on @accidentally-awesome-labs/spatula-db — the
 * actual ProjectAdapter class from @accidentally-awesome-labs/spatula-db satisfies this interface.
 *
 * The optional subscribe() method bridges the PipelineEventEmitter to the
 * DataSource callback pattern.
 */
import { StorageError } from '@accidentally-awesome-labs/spatula-shared';
import type { Entity } from '@accidentally-awesome-labs/spatula-shared';
import type {
  DataSource,
  PaginationQuery,
  PaginatedResult,
  ProjectStatus,
  DataEvent,
} from '../interfaces/data-source.js';
import type { PipelineEventEmitter } from './pipeline-events.js';

// ---------------------------------------------------------------------------
// Structural interface for the subset of ProjectAdapter used by LocalDataSource
// ---------------------------------------------------------------------------

interface EntityRepoLike {
  findByJob(
    jobId: string,
    tenantId: string,
    options?: { limit: number; offset: number },
  ): Promise<unknown[]>;
  findByJobWithProvenance(
    jobId: string,
    tenantId: string,
    options?: { limit: number; offset: number },
  ): Promise<unknown[]>;
  countByJob(jobId: string, tenantId: string): Promise<number>;
}

interface SchemaRepoLike {
  findLatest(
    jobId: string,
    tenantId: string,
  ): Promise<{ id: string; version: number; definition: unknown } | null>;
  findAllVersions(jobId: string): Promise<unknown[]>;
}

interface ActionRepoLike {
  findByJob(
    jobId: string,
    options?: { status?: string; limit?: number; offset?: number },
  ): Promise<unknown[]>;
  updateStatus(
    actionId: string,
    tenantId: string,
    status: string,
    reviewedBy?: string,
  ): Promise<unknown>;
}

interface TaskRepoLike {
  getJobStats(
    jobId: string,
    tenantId: string,
  ): Promise<{
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    skipped: number;
  }>;
}

interface RunRepoLike {
  findLatestByStatus(
    statuses: string[],
  ): Promise<{ id: string; status: string; startedAt: string } | null>;
}

interface ExportRepoLike {
  create(data: {
    runId?: string;
    format: string;
    filePath: string;
    includeProvenance?: boolean;
  }): Promise<{ id: string }>;
  findById(
    id: string,
  ): Promise<{ id: string; filePath: string; format: string; status: string } | null>;
}

interface MetaRepoLike {
  getAll(): Promise<Record<string, string>>;
}

export interface ProjectAdapterLike {
  getProjectId(): string;
  entityRepo: EntityRepoLike;
  schemaRepo: SchemaRepoLike;
  actionRepo: ActionRepoLike;
  taskRepo: TaskRepoLike;
  runRepo: RunRepoLike;
  exportRepo: ExportRepoLike;
  metaRepo: MetaRepoLike;
}

// ---------------------------------------------------------------------------
// LocalDataSource implementation
// ---------------------------------------------------------------------------

export class LocalDataSource implements DataSource {
  constructor(
    private readonly adapter: ProjectAdapterLike,
    private readonly emitter?: PipelineEventEmitter,
  ) {}

  async getEntities(query: PaginationQuery): Promise<PaginatedResult<Entity>> {
    const projectId = this.adapter.getProjectId();
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const [rows, total] = await Promise.all([
      this.adapter.entityRepo.findByJob(projectId, projectId, { limit, offset }),
      this.adapter.entityRepo.countByJob(projectId, projectId),
    ]);

    return { data: rows as Entity[], total };
  }

  async getEntity(id: string): Promise<Entity | null> {
    const projectId = this.adapter.getProjectId();
    // Fetch all with provenance and find by id — local mode datasets are small
    const rows = await this.adapter.entityRepo.findByJobWithProvenance(projectId, projectId);
    const found = (rows as Array<Entity & { id: string }>).find((r) => r.id === id);
    return found ?? null;
  }

  async searchEntities(filter: string): Promise<Entity[]> {
    const projectId = this.adapter.getProjectId();
    // Fetch all entities and filter in-memory (acceptable for local/small datasets)
    const rows = await this.adapter.entityRepo.findByJob(projectId, projectId);
    const lowerFilter = filter.toLowerCase();
    return (rows as Entity[]).filter((row) => {
      const text = JSON.stringify(row.mergedData ?? {}).toLowerCase();
      return text.includes(lowerFilter);
    });
  }

  async getSchema(): Promise<unknown> {
    const projectId = this.adapter.getProjectId();
    return this.adapter.schemaRepo.findLatest(projectId, projectId);
  }

  async getSchemaVersions(): Promise<unknown[]> {
    const projectId = this.adapter.getProjectId();
    return this.adapter.schemaRepo.findAllVersions(projectId);
  }

  async getActions(status?: string): Promise<unknown[]> {
    const projectId = this.adapter.getProjectId();
    return this.adapter.actionRepo.findByJob(projectId, { status });
  }

  async approveAction(id: string, reviewedBy?: string): Promise<void> {
    const projectId = this.adapter.getProjectId();
    await this.adapter.actionRepo.updateStatus(id, projectId, 'approved', reviewedBy);
  }

  async rejectAction(id: string, reviewedBy?: string): Promise<void> {
    const projectId = this.adapter.getProjectId();
    await this.adapter.actionRepo.updateStatus(id, projectId, 'rejected', reviewedBy);
  }

  async getStatus(): Promise<ProjectStatus> {
    const projectId = this.adapter.getProjectId();

    const [entityCount, taskStats, pendingActions, latestSchema, latestRun] = await Promise.all([
      this.adapter.entityRepo.countByJob(projectId, projectId),
      this.adapter.taskRepo.getJobStats(projectId, projectId),
      this.adapter.actionRepo.findByJob(projectId, { status: 'pending_review' }),
      this.adapter.schemaRepo.findLatest(projectId, projectId),
      this.adapter.runRepo.findLatestByStatus(['completed', 'failed', 'running']),
    ]);

    const totalPages =
      (taskStats.completed ?? 0) + (taskStats.failed ?? 0) + (taskStats.skipped ?? 0);

    const schemaFields = latestSchema
      ? Object.keys((latestSchema.definition as { fields?: Record<string, unknown> })?.fields ?? {})
          .length
      : 0;

    const status: ProjectStatus = {
      totalPages,
      totalEntities: entityCount,
      pendingActions: pendingActions.length,
      schemaFields,
      storageBytes: { pages: 0, database: 0, exports: 0 },
    };

    if (latestRun) {
      status.lastRun = {
        id: latestRun.id,
        status: latestRun.status,
        startedAt: latestRun.startedAt,
        pagesProcessed: taskStats.completed ?? 0,
        entitiesCreated: entityCount,
      };
    }

    return status;
  }

  async createExport(options: { format: string; includeProvenance?: boolean }): Promise<unknown> {
    return this.adapter.exportRepo.create({
      format: options.format,
      filePath: '',
      includeProvenance: options.includeProvenance ?? false,
    });
  }

  async getExport(id: string): Promise<unknown> {
    return this.adapter.exportRepo.findById(id);
  }

  async downloadExport(id: string): Promise<string> {
    const record = await this.adapter.exportRepo.findById(id);
    if (!record) {
      throw new StorageError(`Export not found: ${id}`);
    }
    return record.filePath;
  }

  async getDocumentation(): Promise<unknown> {
    return this.adapter.metaRepo.getAll();
  }

  subscribe(callback: (event: DataEvent) => void): () => void {
    if (!this.emitter) {
      return () => {};
    }

    // Wrap each event type into a generic DataEvent and forward to the callback
    const taskCompleted = (data: unknown): void => callback({ type: 'task:completed', data });
    const entityCreated = (data: unknown): void => callback({ type: 'entity:created', data });
    const schemaEvolved = (data: unknown): void => callback({ type: 'schema:evolved', data });
    const actionPending = (data: unknown): void => callback({ type: 'action:pending', data });
    const progress = (data: unknown): void => callback({ type: 'progress', data });

    // Use the underlying EventEmitter addListener/removeListener to avoid
    // fighting the typed overloads on PipelineEventEmitter.on()
    const ee = this.emitter as unknown as NodeJS.EventEmitter;
    ee.on('task:completed', taskCompleted);
    ee.on('entity:created', entityCreated);
    ee.on('schema:evolved', schemaEvolved);
    ee.on('action:pending', actionPending);
    ee.on('progress', progress);

    return () => {
      ee.off('task:completed', taskCompleted);
      ee.off('entity:created', entityCreated);
      ee.off('schema:evolved', schemaEvolved);
      ee.off('action:pending', actionPending);
      ee.off('progress', progress);
    };
  }
}
