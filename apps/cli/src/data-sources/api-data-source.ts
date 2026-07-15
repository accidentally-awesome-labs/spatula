import type {
  DataSource,
  PaginationQuery,
  PaginatedResult,
  ProjectStatus,
} from '@accidentally-awesome-labs/spatula-core';
import type { Entity } from '@accidentally-awesome-labs/spatula-shared';
import type { SpatulaApiClient } from '../api/client.js';

export class ApiDataSource implements DataSource {
  constructor(
    private readonly client: SpatulaApiClient,
    private readonly jobId: string,
  ) {}

  async getEntities(query: PaginationQuery): Promise<PaginatedResult<Entity>> {
    const result = await this.client.listEntitiesPaginated(this.jobId, {
      limit: query.limit,
      offset: query.offset,
      search: query.search,
    });
    return { data: result.data as unknown as Entity[], total: result.total };
  }

  async getEntity(id: string): Promise<Entity | null> {
    try {
      const entity = await this.client.getEntity(this.jobId, id);
      return entity as unknown as Entity;
    } catch {
      return null;
    }
  }

  async searchEntities(filter: string): Promise<Entity[]> {
    const result = await this.client.listEntitiesPaginated(this.jobId, {
      search: filter,
      limit: 50,
    });
    return result.data as unknown as Entity[];
  }

  async getSchema(): Promise<unknown> {
    return this.client.getSchema(this.jobId);
  }

  async getSchemaVersions(): Promise<unknown[]> {
    return this.client.listSchemaVersions(this.jobId);
  }

  async getActions(status?: string): Promise<unknown[]> {
    return this.client.listActions(this.jobId, status ? { status } : undefined);
  }

  async approveAction(id: string, reviewedBy?: string): Promise<void> {
    await this.client.approveAction(this.jobId, id, reviewedBy);
  }

  async rejectAction(id: string, reviewedBy?: string): Promise<void> {
    await this.client.rejectAction(this.jobId, id, reviewedBy);
  }

  async getStatus(): Promise<ProjectStatus> {
    const job = await this.client.getJob(this.jobId);
    return {
      lastRun: {
        id: job.id as string,
        status: job.status as string,
        startedAt: (job.startedAt as string) ?? '',
        pagesProcessed: (job.pagesCompleted as number) ?? 0,
        entitiesCreated: (job.entitiesExtracted as number) ?? 0,
      },
      totalPages: (job.pagesDiscovered as number) ?? 0,
      totalEntities: (job.entitiesExtracted as number) ?? 0,
      pendingActions: (job.stats as Record<string, number>)?.pendingActionsCount ?? 0,
      schemaFields: (job.stats as Record<string, number>)?.schemaFieldCount ?? 0,
      storageBytes: {
        pages: (job.stats as Record<string, number>)?.storageBytesUsed ?? 0,
        database: 0,
        exports: 0,
      },
    };
  }

  async createExport(options: { format: string; includeProvenance?: boolean }): Promise<unknown> {
    return this.client.createExport(this.jobId, options);
  }

  async getExport(id: string): Promise<unknown> {
    return this.client.getExport(this.jobId, id);
  }

  async downloadExport(id: string): Promise<string> {
    return this.client.downloadExport(this.jobId, id);
  }

  async getDocumentation(): Promise<unknown> {
    return this.client.getDocumentation(this.jobId);
  }
}
