import type {
  JobRepository,
  SchemaRepository,
  ExtractionRepository,
  EntityRepository,
  EntitySourceRepository,
  ActionRepository,
  CrawlTaskRepository,
} from '@spatula/db';
import type { JobManager } from '@spatula/queue';

export interface AppDeps {
  jobRepo: JobRepository;
  schemaRepo: SchemaRepository;
  extractionRepo: ExtractionRepository;
  entityRepo: EntityRepository;
  entitySourceRepo: EntitySourceRepository;
  actionRepo: ActionRepository;
  taskRepo: CrawlTaskRepository;
  jobManager: JobManager;
}

export interface AppEnv {
  Variables: {
    tenantId: string;
    deps: AppDeps;
    validatedBody: unknown;
    validatedQuery: unknown;
  };
}
