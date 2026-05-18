/**
 * Tier 4 Test Helpers — API lifecycle testing with real Postgres + Redis via Hono app.request().
 *
 * These helpers spin up a real Hono app backed by a live database, enabling
 * full-stack integration tests that exercise the API routes, middleware chain,
 * and repository layer without an external HTTP server.
 */

import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import crypto from 'node:crypto';

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
} from '@spatula/db';
import type { Database } from '@spatula/db';

// pg and ioredis types come transitively through @spatula/api — use
// structural types here so the CLI package doesn't need its own @types/pg
// or ioredis devDependency.
type Pool = { end(): Promise<void>; [k: string]: unknown };
type RedisClient = { disconnect(): void; quit(): Promise<string>; [k: string]: unknown };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestRepos {
  jobRepo: JobRepository;
  schemaRepo: SchemaRepository;
  entityRepo: EntityRepository;
  entitySourceRepo: EntitySourceRepository;
  actionRepo: ActionRepository;
  exportRepo: ExportRepository;
  tenantRepo: TenantRepository;
  dlqRepo: DlqRepository;
  apiKeyRepo: ApiKeyRepository;
  auditLogRepo: AuditLogRepository;
}

/** Return type of createTestApp() when DATABASE_URL is available. */
export interface TestApp {
  /** The Hono app instance — call app.request() to exercise routes. */
  app: any;
  pool: Pool;
  db: Database;
  redis: RedisClient | null;
  repos: TestRepos;
  cleanup(): Promise<void>;
}

export interface WebhookReceiver {
  port: number;
  requests: Array<{ headers: Record<string, string>; body: unknown }>;
  close(): Promise<void>;
  waitForRequest(timeoutMs?: number): Promise<unknown>;
}

export interface SeedResult {
  jobId: string;
  schemaId: string;
  entityIds: string[];
  actionIds: string[];
}

// ---------------------------------------------------------------------------
// createTestApp()
// ---------------------------------------------------------------------------

/**
 * Create a Hono app backed by a real Postgres database (and optionally Redis).
 * Returns `null` when `DATABASE_URL` is not set, so tests can be skipped
 * gracefully in environments that lack infrastructure.
 */
export async function createTestApp(opts?: {
  authStrategy?: 'none' | 'api-key';
}): Promise<TestApp | null> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;

  // 1. Real database connection
  const { db, pool } = createDatabasePool(databaseUrl);

  // 2. Real repository instances
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

  // 3. Optional Redis
  let redis: RedisClient | null = null;
  if (process.env.REDIS_URL) {
    // Dynamic import — ioredis is a transitive dep via @spatula/api.
    // We use a variable to defeat tsc module resolution (runtime-only).
    const redisModule = 'ioredis';
    const mod: any = await import(/* @vite-ignore */ redisModule);
    const IoRedis = mod.default;
    redis = new IoRedis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  }

  // 4. Stubbed services — createJob inserts via jobRepo so the subsequent
  //    findById in the route handler returns the newly created job.
  const jobManager = {
    createJob: async (config: any) => {
      const job = await jobRepo.create({
        tenantId: config.tenantId,
        name: config.name,
        description: config.description,
        config,
      });
      return job.id;
    },
    startJob: async () => {},
    pauseJob: async () => {},
    resumeJob: async () => {},
    cancelJob: async () => {},
    triggerReconciliation: async () => {},
    getJobStatus: async () => 'pending' as const,
  };
  const exportQueue = { add: async () => {} };
  const contentStore = {
    store: async () => 'ref',
    retrieve: async () => '',
    delete: async () => {},
  };

  // 5. Set auth strategy (defaults to 'none' so tenant header is accepted without tokens)
  process.env.AUTH_STRATEGY = opts?.authStrategy ?? 'none';

  // 6. Create audit logger
  const { AuditLogger } = await import('@spatula/shared');
  const auditLogger = new AuditLogger(auditLogRepo);

  // 7. Build the Hono app
  const { createApp } = await import('@spatula/api');

  const deps = {
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
    auditLogger,
    jobManager,
    exportQueue,
    contentStore,
    redis: redis ?? undefined,
  };

  const app = createApp(deps as any);

  return {
    app,
    pool: pool as unknown as Pool,
    db,
    redis,
    repos: {
      jobRepo,
      schemaRepo,
      entityRepo,
      entitySourceRepo,
      actionRepo,
      exportRepo,
      tenantRepo,
      dlqRepo,
      apiKeyRepo,
      auditLogRepo,
    },
    cleanup: async () => {
      await pool.end();
      if (redis) {
        redis.disconnect();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// createTenant()
// ---------------------------------------------------------------------------

/**
 * Create a tenant via the API and return its ID.
 * Throws if the request fails (e.g. tenantRepo not wired).
 */
export async function createTenant(app: any, name = 'Test Tenant'): Promise<{ tenantId: string }> {
  const res = await app.request('/api/v1/tenants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

  if (res.status !== 201) {
    const body = await res.text();
    throw new Error(`Failed to create tenant: ${res.status} ${body}`);
  }

  const body = await res.json();
  return { tenantId: body.data.id };
}

// ---------------------------------------------------------------------------
// authHeaders()
// ---------------------------------------------------------------------------

/**
 * Convenience helper: returns headers needed to authenticate as a tenant
 * when AUTH_STRATEGY=none.
 */
export function authHeaders(tenantId: string): Record<string, string> {
  return { 'x-tenant-id': tenantId, 'Content-Type': 'application/json' };
}

// ---------------------------------------------------------------------------
// seedJobWithData()
// ---------------------------------------------------------------------------

/**
 * Insert test data directly via Drizzle, bypassing the API.
 *
 * Creates:
 *  - 1 job (status: completed)
 *  - 1 schema with 2 fields (title, price)
 *  - 3 entities with mergedData
 *  - 2 pending actions (add_field, remove_field)
 *
 * Returns the IDs of all created records.
 */
export async function seedJobWithData(db: Database, tenantId: string): Promise<SeedResult> {
  // Lazy-import the schema tables so this file can be loaded even when
  // @spatula/db isn't built yet (type-checking only).
  const { jobs, schemasTable, entities, actions } =
    await import('@spatula/db/dist/schema/index.js');

  // -- Job ------------------------------------------------------------------
  const jobConfig = {
    tenantId,
    name: 'Seed Test Job',
    description: 'Seeded for tier-4 tests',
    seedUrls: ['https://example.com'],
    crawl: {
      maxDepth: 1,
      maxPages: 10,
      concurrency: 1,
      crawlerType: 'playwright' as const,
    },
    schema: {
      mode: 'discovery' as const,
    },
    llm: {
      primaryModel: 'anthropic/claude-sonnet-4-20250514',
    },
  };

  const [job] = await db
    .insert(jobs)
    .values({
      tenantId,
      name: 'Seed Test Job',
      description: 'Seeded for tier-4 tests',
      config: jobConfig,
      status: 'completed',
    })
    .returning();

  const jobId = job.id;

  // -- Schema ---------------------------------------------------------------
  const schemaDef = {
    version: 1,
    fields: [
      {
        name: 'title',
        description: 'Product title',
        type: 'string' as const,
        required: true,
      },
      {
        name: 'price',
        description: 'Product price',
        type: 'number' as const,
        required: true,
      },
    ],
    fieldAliases: [],
    createdAt: new Date(),
    parentVersion: null,
  };

  const [schema] = await db
    .insert(schemasTable)
    .values({
      jobId,
      tenantId,
      version: 1,
      definition: schemaDef,
    })
    .returning();

  const schemaId = schema.id;

  // -- Entities -------------------------------------------------------------
  const entityValues = [
    {
      jobId,
      tenantId,
      mergedData: { title: 'Widget A', price: 9.99 },
      provenance: { title: 'extracted', price: 'extracted' },
    },
    {
      jobId,
      tenantId,
      mergedData: { title: 'Widget B', price: 19.99 },
      provenance: { title: 'extracted', price: 'normalized' },
    },
    {
      jobId,
      tenantId,
      mergedData: { title: 'Widget C', price: 29.99 },
      provenance: { title: 'extracted', price: 'merged' },
    },
  ];

  const insertedEntities = await db.insert(entities).values(entityValues).returning();

  const entityIds = insertedEntities.map((e) => e.id);

  // -- Actions --------------------------------------------------------------
  const actionValues = [
    {
      jobId,
      tenantId,
      type: 'add_field',
      payload: {
        fieldName: 'rating',
        fieldType: 'number',
        description: 'Product rating',
      },
      source: 'schema_evolution' as const,
      status: 'pending_review' as const,
      confidence: 0.87,
      reasoning: 'Field "rating" found in 87% of pages',
    },
    {
      jobId,
      tenantId,
      type: 'remove_field',
      payload: { fieldName: 'sku', reason: 'Rarely populated' },
      source: 'quality_audit' as const,
      status: 'pending_review' as const,
      confidence: 0.92,
      reasoning: 'Field "sku" present in only 3% of entities',
    },
  ];

  const insertedActions = await db.insert(actions).values(actionValues).returning();

  const actionIds = insertedActions.map((a) => a.id);

  return { jobId, schemaId, entityIds, actionIds };
}

// ---------------------------------------------------------------------------
// startWebhookReceiver()
// ---------------------------------------------------------------------------

/**
 * Spin up a tiny HTTP server on an ephemeral port to capture webhook
 * deliveries during tests. Call `.close()` in afterEach/afterAll.
 */
export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const requests: WebhookReceiver['requests'] = [];
  const waiters: Array<{
    resolve: (body: unknown) => void;
    reject: (err: Error) => void;
  }> = [];

  const server: Server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk: string) => {
      data += chunk;
    });
    req.on('end', () => {
      let body: unknown;
      try {
        body = JSON.parse(data);
      } catch {
        body = data;
      }

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }

      requests.push({ headers, body });

      // Resolve any pending waiters
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(body);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  // Listen on port 0 for an OS-assigned ephemeral port
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  return {
    port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Reject any pending waiters
        for (const w of waiters) {
          w.reject(new Error('Webhook receiver closed before request arrived'));
        }
        waiters.length = 0;
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    waitForRequest: (timeoutMs = 5_000) =>
      new Promise<unknown>((resolve, reject) => {
        // If a request already arrived, return it immediately
        if (requests.length > 0) {
          resolve(requests[requests.length - 1].body);
          return;
        }
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`Webhook not received within ${timeoutMs}ms`));
        }, timeoutMs);

        waiters.push({
          resolve: (body) => {
            clearTimeout(timer);
            resolve(body);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      }),
  };
}

// ---------------------------------------------------------------------------
// isDockerAvailable()
// ---------------------------------------------------------------------------

/**
 * Quick synchronous check for whether the Docker daemon is reachable.
 * Used by test setup to skip container-dependent tests gracefully.
 */
export function isDockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
