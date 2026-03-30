import type { Entity } from '@spatula/shared';

export interface PaginationQuery {
  limit?: number;
  offset?: number;
  search?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
}

export interface ProjectStatus {
  lastRun?: { id: string; status: string; startedAt: string; pagesProcessed: number; entitiesCreated: number };
  totalPages: number;
  totalEntities: number;
  pendingActions: number;
  schemaFields: number;
  storageBytes: { pages: number; database: number; exports: number };
}

export interface DataEvent {
  type: string;
  data: unknown;
}

export interface DataSource {
  getEntities(query: PaginationQuery): Promise<PaginatedResult<Entity>>;
  getEntity(id: string): Promise<Entity | null>;
  searchEntities(filter: string): Promise<Entity[]>;
  getSchema(): Promise<unknown>;
  getSchemaVersions(): Promise<unknown[]>;
  getActions(status?: string): Promise<unknown[]>;
  approveAction(id: string, reviewedBy?: string): Promise<void>;
  rejectAction(id: string, reviewedBy?: string): Promise<void>;
  getStatus(): Promise<ProjectStatus>;
  createExport(options: { format: string; includeProvenance?: boolean }): Promise<unknown>;
  getExport(id: string): Promise<unknown>;
  downloadExport(id: string): Promise<string>;
  getDocumentation(): Promise<unknown>;
  subscribe?(callback: (event: DataEvent) => void): () => void;
}
