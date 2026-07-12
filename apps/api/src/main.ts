// apps/api/src/main.ts
// Real production bootstrap for the API server.
//
// This is the file that Dockerfile.api CMD and the Render startCommand should
// target: `node dist/main.js`  (NOT dist/index.js — that is a re-export barrel).
//
// When SPATULA_EMBEDDED_WORKER=1 the worker is co-hosted in-process. Its
// shutdown is wired BEFORE the API's own SIGTERM/SIGINT path so in-flight
// jobs drain before the database pool closes.

import Redis from 'ioredis';
import {
  createDatabasePool,
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
  AuditLogRepository,
  LlmUsageRepository,
  PgContentStore,
  RedisCache,
  TenantDataRepository,
} from '@spatula/db';
import { createQueues, JobManager, redisConnectionOptionsFromUrl } from '@spatula/queue';
import { createContentStore } from '@spatula/core';
import { AuditLogger, createLogger, getEnvOrDefault, loadConfig } from '@spatula/shared';
import { createAuthProvider } from './auth/factory.js';
import { startServer } from './server.js';
import { startEmbeddedWorker } from './embedded-worker.js';
import type { AppDeps } from './types.js';

const logger = createLogger('api:main');

/**
 * Compose the full AppDeps object from environment config.
 * Exported so tests can import and inspect it.
 */
export async function buildAppDeps(): Promise<AppDeps> {
  const config = loadConfig();

  // --- Database ---
  const { db, pool } = createDatabasePool();

  // --- Repositories ---
  const jobRepo = new JobRepository(db);
  const schemaRepo = new SchemaRepository(db);
  const extractionRepo = new ExtractionRepository(db);
  const entityRepo = new EntityRepository(db);
  const entitySourceRepo = new EntitySourceRepository(db);
  const actionRepo = new ActionRepository(db);
  const taskRepo = new CrawlTaskRepository(db);
  const exportRepo = new ExportRepository(db);
  const tenantRepo = new TenantRepository(db);
  const dlqRepo = new DlqRepository(db);
  const apiKeyRepo = new ApiKeyRepository(db);
  const auditLogRepo = new AuditLogRepository(db);
  const llmUsageRepo = new LlmUsageRepository(db);
  const tenantDataRepo = new TenantDataRepository(db);

  // --- Redis ---
  const redisUrl = config.redis.url;
  const redisOpts = redisConnectionOptionsFromUrl(redisUrl);

  const redis = new Redis(redisUrl);
  const redisSubscriber = new Redis(redisUrl);
  const cache = new RedisCache(redis);

  // --- Queues ---
  const queues = createQueues(redisOpts);

  // --- Content Store ---
  const contentStoreType = getEnvOrDefault('CONTENT_STORE', 'postgres');
  const contentStore =
    contentStoreType === 's3'
      ? createContentStore({
          type: 's3',
          s3: {
            bucket: getEnvOrDefault('S3_BUCKET', ''),
            region: getEnvOrDefault('S3_REGION', 'us-east-1'),
            ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
          },
        })
      : new PgContentStore(db);

  // --- Auth ---
  const authStrategy = getEnvOrDefault('AUTH_STRATEGY', 'none');
  const authProvider = createAuthProvider(authStrategy, {
    apiKeyRepo,
    jwtConfig:
      authStrategy === 'jwt'
        ? {
            issuer: getEnvOrDefault('JWT_ISSUER', ''),
            audience: getEnvOrDefault('JWT_AUDIENCE', ''),
            jwksUrl: getEnvOrDefault('JWT_JWKS_URL', ''),
          }
        : undefined,
  });

  // --- Audit Logger ---
  const auditLogger = new AuditLogger(auditLogRepo);

  // --- Job Manager ---
  const jobManager = new JobManager({
    jobRepo,
    taskRepo,
    schemaRepo,
    queues,
    tenantRepo,
    auditLogger,
  });

  return {
    dbPool: pool,
    jobRepo,
    schemaRepo,
    extractionRepo,
    entityRepo,
    entitySourceRepo,
    actionRepo,
    taskRepo,
    exportRepo,
    tenantRepo,
    dlqRepo,
    apiKeyRepo,
    auditLogRepo,
    llmUsageRepo,
    tenantDataRepo,
    contentStore,
    exportQueue: queues.export,
    queues,
    redis,
    redisSubscriber,
    cache,
    authProvider,
    auditLogger,
    jobManager,
  };
}

async function main() {
  logger.info('API bootstrap starting');

  const deps = await buildAppDeps();

  // Start embedded worker BEFORE the HTTP server so it can drain jobs
  // before the DB pool is closed during shutdown.
  const embedded = await startEmbeddedWorker();
  if (embedded) {
    logger.info('Embedded worker started (SPATULA_EMBEDDED_WORKER=1)');
  }

  // startServer() registers its own SIGTERM/SIGINT -> executeShutdown -> process.exit.
  const server = startServer(deps);

  // Wire the embedded worker's shutdown ahead of the API's own shutdown path.
  // When a signal arrives, the worker drains in-flight jobs first; the API's
  // own handler then closes the DB pool, Redis subscriber, etc.
  if (embedded) {
    const drain = async () => {
      try {
        await embedded.shutdown();
        logger.info('Embedded worker drained');
      } catch (err) {
        logger.error({ err }, 'Embedded worker shutdown error');
      }
    };
    // Register BEFORE the API's handlers so drain() runs first
    process.prependListener('SIGTERM', () => void drain());
    process.prependListener('SIGINT', () => void drain());
  }

  logger.info({ embedded: !!embedded }, 'API bootstrap complete');
  return server;
}

main().catch((err) => {
  console.error('API bootstrap failed', err);
  process.exit(1);
});
