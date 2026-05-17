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
  LlmUsageRepository,
  RedisCache,
  UserTenantRepository,
} from '@spatula/db';
import type { ContentStore, ReviewQueue } from '@spatula/core';
import type { JobManager, ExportJobPayload, SpatulaQueues } from '@spatula/queue';
import type { AuthProvider, AuthResult, AuditLogger, SpatulaMetrics } from '@spatula/shared';
import type { AuditLogRepository } from '@spatula/db';
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
  authProvider?: AuthProvider;
  queues?: SpatulaQueues;
  redis?: Redis;  // Shared ioredis client for rate limiting, WS tokens, etc.
  cache?: RedisCache;
  auditLogger?: AuditLogger;
  auditLogRepo?: AuditLogRepository;
  llmUsageRepo?: LlmUsageRepository;
  userTenantRepo?: UserTenantRepository;
  metrics?: SpatulaMetrics;
}

export interface AppEnv {
  Variables: {
    tenantId: string;
    deps: AppDeps;
    validatedBody: unknown;
    validatedQuery: unknown;
    requestId: string;
    logger: import('@spatula/shared').Logger;
    auth: AuthResult;
  };
}
