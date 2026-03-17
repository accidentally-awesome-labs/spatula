import type {
  JobRepository,
  SchemaRepository,
  ExtractionRepository,
  EntityRepository,
  EntitySourceRepository,
  ActionRepository,
  CrawlTaskRepository,
  ExportRepository,
} from '@spatula/db';
import type { ContentStore } from '@spatula/core';
import type { JobManager, ExportJobPayload, SpatulaQueues } from '@spatula/queue';

export interface AppDeps {
  jobRepo: JobRepository;
  schemaRepo: SchemaRepository;
  extractionRepo: ExtractionRepository;
  entityRepo: EntityRepository;
  entitySourceRepo: EntitySourceRepository;
  actionRepo: ActionRepository;
  taskRepo: CrawlTaskRepository;
  jobManager: JobManager;
  exportRepo: ExportRepository;
  contentStore: ContentStore;
  exportQueue: SpatulaQueues['export'];
}

export interface AppEnv {
  Variables: {
    tenantId: string;
    deps: AppDeps;
    validatedBody: unknown;
    validatedQuery: unknown;
  };
}
