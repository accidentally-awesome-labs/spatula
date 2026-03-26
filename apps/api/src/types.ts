import type {
  JobRepository,
  SchemaRepository,
  ExtractionRepository,
  EntityRepository,
  EntitySourceRepository,
  ActionRepository,
  CrawlTaskRepository,
  ExportRepository,
  TenantRepository,
  DlqRepository,
  ApiKeyRepository,
} from '@spatula/db';
import type { ContentStore, ReviewQueue } from '@spatula/core';
import type { JobManager, ExportJobPayload, SpatulaQueues } from '@spatula/queue';
import type Redis from 'ioredis';
import type { Pool } from 'pg';

export interface AppDeps {
  dbPool: Pool;
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
  reviewQueue?: ReviewQueue;
  redisSubscriber?: Redis;
  tenantRepo?: TenantRepository;
  dlqRepo?: DlqRepository;
  apiKeyRepo?: ApiKeyRepository;
  queues?: SpatulaQueues;
}

export interface AppEnv {
  Variables: {
    tenantId: string;
    deps: AppDeps;
    validatedBody: unknown;
    validatedQuery: unknown;
    requestId: string;
    logger: import('@spatula/shared').Logger;
  };
}
