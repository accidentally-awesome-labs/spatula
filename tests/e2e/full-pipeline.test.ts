import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import {
  createDatabase,
  JobRepository,
  CrawlTaskRepository,
  SchemaRepository,
  ExtractionRepository,
  PageRepository,
  EntityRepository,
  SourceTrustRepository,
  EntitySourceRepository,
  ExportRepository,
  ActionRepository,
  PgContentStore,
} from '@spatula/db';
import type { Database } from '@spatula/db';

import {
  createQueues,
  WorkerDeps,
  processCrawlJob,
  processSchemaEvolutionJob,
  processReconciliationJob,
  processExportJob,
  JobManager,
  type SpatulaQueues,
  type WorkerDepsConfig,
} from '@spatula/queue';

import type {
  Crawler,
  CrawlResult,
  Extractor,
  SchemaEvolver,
  DataReconciler,
  ContentStore,
  SchemaDefinition,
  ExtractionResult,
  PipelineAction,
  ExtractionWithSource,
  ReconciliationConfig,
  JobConfig,
  EntityMatch,
  PageClassification,
} from '@spatula/core';
import type { PageClassificationResult } from '@spatula/core';

// ---------------------------------------------------------------------------
// Fixture HTML
// ---------------------------------------------------------------------------
const FIXTURE_HTML = readFileSync(join(__dirname, 'fixtures', 'product-page.html'), 'utf-8');

const FIXTURE_URL = 'https://example.com/products/xz-500';

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------
let db: Database;
let queues: SpatulaQueues;
let server: Server;
let serverPort: number;
let tenantId: string;
let jobId: string;

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockCrawler(): Crawler {
  return {
    type: 'playwright' as const,
    async crawl(_url: string): Promise<CrawlResult> {
      return {
        url: FIXTURE_URL,
        html: FIXTURE_HTML,
        title: 'Test Product',
        statusCode: 200,
        contentType: 'text/html',
        links: [], // no child links to follow
        metadata: {
          crawledAt: new Date(),
          responseTimeMs: 42,
          contentLength: FIXTURE_HTML.length,
          crawlerType: 'playwright' as const,
        },
      };
    },
    async close() {},
  };
}

function createMockClassifier(): {
  classify: (
    html: string,
    url: string,
    jobDescription: string,
  ) => Promise<PageClassificationResult>;
} {
  return {
    async classify(
      _html: string,
      _url: string,
      _jobDescription: string,
    ): Promise<PageClassificationResult> {
      return {
        classification: 'single_entry' as PageClassification,
        strategy: 'full_extraction',
        estimatedEntryCount: 1,
        confidence: 0.95,
        reasoning: 'Product detail page with structured data.',
      };
    },
  };
}

function createMockExtractor(): Extractor {
  return {
    async extract(
      _html: string,
      _url: string,
      _schema: SchemaDefinition,
      _jobDescription: string,
    ): Promise<ExtractionResult> {
      return {
        id: randomUUID(),
        jobId: '', // will be set by worker
        pageId: '', // will be set by worker
        schemaVersion: 1,
        data: {
          name: 'Wireless Headphones XZ-500',
          price: 149.99,
          description: 'Premium wireless headphones with active noise cancellation.',
          brand: 'AudioTech',
        },
        metadata: {
          confidence: 0.92,
          modelUsed: 'mock-model',
          tokensUsed: 500,
          extractionTimeMs: 100,
          unmappedFields: [{ name: 'color', value: 'black', suggestedType: 'string' }],
        },
      };
    },
  };
}

function createMockSchemaEvolver(): SchemaEvolver {
  return {
    async evolve(
      _currentSchema: SchemaDefinition,
      _recentExtractions: ExtractionResult[],
      _jobDescription: string,
    ): Promise<PipelineAction[]> {
      return [
        {
          id: randomUUID(),
          jobId: '', // will be stamped by worker
          source: 'schema_evolution',
          reasoning: 'Field "color" appeared in recent extractions.',
          confidence: 0.88,
          type: 'add_field',
          payload: {
            field: {
              name: 'color',
              description: 'Product color',
              type: 'string',
              required: false,
            },
            relevance: {
              globalFrequency: 0.8,
              categoryBreakdown: [{ category: 'electronics', frequency: 0.9, sampleSize: 10 }],
              classification: 'universal_optional',
              applicableCategories: null,
            },
          },
        },
      ];
    },
  };
}

function createMockReconciler(extractionId: string): DataReconciler {
  return {
    async reconcile(
      extractions: ExtractionWithSource[],
      _schema: SchemaDefinition,
      _config: ReconciliationConfig,
      _jobDescription: string,
    ): Promise<{ entities: EntityMatch[]; actions: PipelineAction[] }> {
      const entityId = randomUUID();
      return {
        entities: [
          {
            entityId,
            sourceExtractions: extractions.map((ext) => ({
              extractionId: ext.id,
              sourceUrl: ext.sourceUrl,
              sourceDomain: ext.sourceDomain,
              crawledAt: ext.crawledAt,
              fieldsCovered: ['name', 'price', 'description', 'brand'],
            })),
            mergedData: {
              name: 'Wireless Headphones XZ-500',
              price: 149.99,
              description: 'Premium wireless headphones with active noise cancellation.',
              brand: 'AudioTech',
            },
            fieldProvenance: {
              name: {
                finalValue: 'Wireless Headphones XZ-500',
                provenanceType: 'extracted',
                sources: [
                  {
                    sourceUrl: FIXTURE_URL,
                    rawValue: 'Wireless Headphones XZ-500',
                    normalizedValue: 'Wireless Headphones XZ-500',
                  },
                ],
                hadConflict: false,
              },
              price: {
                finalValue: 149.99,
                provenanceType: 'extracted',
                sources: [
                  {
                    sourceUrl: FIXTURE_URL,
                    rawValue: 149.99,
                    normalizedValue: 149.99,
                  },
                ],
                hadConflict: false,
              },
            },
          },
        ],
        actions: [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------
let setupOk = false;

describe('Full Pipeline E2E', () => {
  beforeAll(async () => {
    // Skip if no Postgres/Redis available
    if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
      return; // setupOk stays false → all tests skip
    }

    // 1. Start fixture HTTP server
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });

    // 2. Connect to test database
    const dbUrl =
      process.env.TEST_DATABASE_URL ?? 'postgresql://spatula:spatula@localhost:5432/spatula_test';
    db = createDatabase(dbUrl);

    // 3. Create BullMQ queues against real Redis
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const redisUrlObj = new URL(redisUrl);
    queues = createQueues({
      host: redisUrlObj.hostname,
      port: parseInt(redisUrlObj.port, 10) || 6379,
    });

    // 4. Create a test tenant
    tenantId = randomUUID();
    await db.execute(
      sql`INSERT INTO tenants (id, name) VALUES (${tenantId}, ${'e2e-test-tenant'})`,
    );

    setupOk = true;
  });

  afterAll(async () => {
    // Cleanup in FK dependency order
    try {
      if (jobId && tenantId) {
        await db.execute(
          sql`DELETE FROM entity_sources WHERE entity_id IN (SELECT id FROM entities WHERE job_id = ${jobId})`,
        );
        await db.execute(sql`DELETE FROM entities WHERE job_id = ${jobId}`);
        await db.execute(sql`DELETE FROM source_trust WHERE job_id = ${jobId}`);
        await db.execute(sql`DELETE FROM extractions WHERE job_id = ${jobId}`);
        await db.execute(
          sql`DELETE FROM raw_pages WHERE task_id IN (SELECT id FROM crawl_tasks WHERE job_id = ${jobId})`,
        );
        await db.execute(sql`DELETE FROM crawl_tasks WHERE job_id = ${jobId}`);
        await db.execute(sql`DELETE FROM actions WHERE job_id = ${jobId}`);
        await db.execute(sql`DELETE FROM exports WHERE job_id = ${jobId}`);
        await db.execute(sql`UPDATE jobs SET schema_id = NULL WHERE id = ${jobId}`);
        await db.execute(sql`DELETE FROM schemas WHERE job_id = ${jobId}`);
        await db.execute(sql`DELETE FROM jobs WHERE id = ${jobId}`);
        await db.execute(
          sql`DELETE FROM content_store WHERE key LIKE ${jobId + '%'} OR key LIKE ${'exports/' + tenantId + '/' + jobId + '%'}`,
        );
      }
      if (tenantId) {
        await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
      }
    } catch (e) {
      console.error('Cleanup error:', e);
    }

    // Close connections
    await queues?.closeAll().catch(() => {});
    server?.close();
  });

  it('runs the full pipeline: create job → crawl → evolve → reconcile → export', async (ctx) => {
    if (!setupOk) return ctx.skip();
    // ---------------------------------------------------------------
    // Setup repositories and deps
    // ---------------------------------------------------------------
    const jobRepo = new JobRepository(db);
    const taskRepo = new CrawlTaskRepository(db);
    const schemaRepo = new SchemaRepository(db);
    const extractionRepo = new ExtractionRepository(db);
    const pageRepo = new PageRepository(db);
    const entityRepo = new EntityRepository(db);
    const sourceTrustRepo = new SourceTrustRepository(db);
    const entitySourceRepo = new EntitySourceRepository(db);
    const exportRepo = new ExportRepository(db);
    const actionRepo = new ActionRepository(db);
    const contentStore: ContentStore = new PgContentStore(db);

    // ---------------------------------------------------------------
    // 1. Create job via JobManager
    // ---------------------------------------------------------------
    const jobManager = new JobManager({
      jobRepo,
      taskRepo,
      schemaRepo,
      queues,
    });

    const jobConfig: JobConfig = {
      tenantId,
      name: 'E2E Test Product Scrape',
      description: 'Extract product information from electronics retailer pages.',
      seedUrls: [FIXTURE_URL],
      crawl: {
        maxDepth: 0,
        maxPages: 10,
        concurrency: 1,
        crawlerType: 'playwright',
      },
      schema: {
        mode: 'discovery',
        userFields: [
          { name: 'name', description: 'Product name', type: 'string', required: true },
          { name: 'price', description: 'Product price', type: 'number', required: true },
          {
            name: 'description',
            description: 'Product description',
            type: 'string',
            required: false,
          },
          { name: 'brand', description: 'Product brand', type: 'string', required: false },
        ],
        evolutionConfig: {
          enabled: true,
          batchSize: 1, // trigger evolution after a single extraction
          maxFields: 50,
          relevanceThresholds: {
            requiredMin: 0.85,
            optionalMin: 0.4,
            rareBelow: 0.4,
            minCategorySampleSize: 5,
          },
          tableStrategy: 'auto',
        },
      },
      llm: {
        primaryModel: 'mock/model',
      },
    };

    jobId = await jobManager.createJob(jobConfig);
    expect(jobId).toBeTruthy();

    // Verify job is created with pending status
    const createdJob = await jobRepo.findById(jobId, tenantId);
    expect(createdJob).toBeTruthy();
    expect(createdJob!.status).toBe('pending');

    // ---------------------------------------------------------------
    // 2. Start job (transitions to running, creates schema + tasks)
    // ---------------------------------------------------------------
    await jobManager.startJob(jobId, tenantId);

    const runningJob = await jobRepo.findById(jobId, tenantId);
    expect(runningJob!.status).toBe('running');

    // Verify initial schema was created
    const initialSchema = await schemaRepo.findLatest(jobId, tenantId);
    expect(initialSchema).toBeTruthy();
    expect(initialSchema!.version).toBe(1);
    expect(initialSchema!.definition.fields.length).toBe(4);

    // Verify crawl task was created
    const tasks = await taskRepo.findByJob(jobId);
    expect(tasks.length).toBe(1);
    expect(tasks[0].url).toBe(FIXTURE_URL);
    const taskId = tasks[0].id;

    // ---------------------------------------------------------------
    // 3. Process crawl job (with mocked crawler/extractor/classifier)
    // ---------------------------------------------------------------
    // We need a mock reconciler placeholder for deps -- the real one is used later
    const placeholderReconciler = createMockReconciler('placeholder');

    const workerDeps = new WorkerDeps({
      crawler: createMockCrawler(),
      extractor: createMockExtractor(),
      classifier: createMockClassifier() as any,
      contentStore,
      schemaEvolver: createMockSchemaEvolver(),
      reconciler: placeholderReconciler,
      jobRepo,
      taskRepo,
      pageRepo,
      extractionRepo,
      schemaRepo,
      entityRepo,
      sourceTrustRepo,
      entitySourceRepo,
      exportRepo,
      actionRepo,
      queues,
    });

    await processCrawlJob(
      {
        taskId,
        jobId,
        tenantId,
        url: FIXTURE_URL,
        depth: 0,
      },
      workerDeps,
    );

    // Verify crawl task completed
    const updatedTasks = await taskRepo.findByJob(jobId, { status: 'completed' });
    expect(updatedTasks.length).toBe(1);

    // Verify page was stored
    const extractions = await extractionRepo.findByJob(jobId, tenantId);
    expect(extractions.length).toBe(1);
    const extraction = extractions[0];
    expect((extraction.data as Record<string, unknown>).name).toBe('Wireless Headphones XZ-500');
    expect((extraction.data as Record<string, unknown>).price).toBe(149.99);

    // ---------------------------------------------------------------
    // 4. Process schema evolution job
    // ---------------------------------------------------------------
    await processSchemaEvolutionJob(
      {
        jobId,
        tenantId,
        extractionIds: [extraction.id],
      },
      workerDeps,
    );

    // Verify schema evolved to version 2 with new "color" field
    const evolvedSchema = await schemaRepo.findLatest(jobId, tenantId);
    expect(evolvedSchema).toBeTruthy();
    expect(evolvedSchema!.version).toBe(2);
    const fieldNames = evolvedSchema!.definition.fields.map((f: { name: string }) => f.name);
    expect(fieldNames).toContain('color');

    // Verify action was persisted
    const actionsResult = await actionRepo.findByJob(jobId, tenantId);
    expect(actionsResult.length).toBeGreaterThanOrEqual(1);
    expect(actionsResult.some((a: { type: string }) => a.type === 'add_field')).toBe(true);

    // ---------------------------------------------------------------
    // 5. Trigger reconciliation
    // ---------------------------------------------------------------
    // Transition job to reconciling
    await jobManager.triggerReconciliation(jobId, tenantId);

    const reconcilingJob = await jobRepo.findById(jobId, tenantId);
    expect(reconcilingJob!.status).toBe('reconciling');

    // Build a reconciler that knows about our actual extraction ID
    const realReconciler = createMockReconciler(extraction.id);
    const reconDeps = new WorkerDeps({
      ...workerDeps,
      reconciler: realReconciler,
    } as any);

    await processReconciliationJob({ jobId, tenantId }, reconDeps);

    // Verify entities were created
    const entityCount = await entityRepo.countByJob(jobId, tenantId);
    expect(entityCount).toBe(1);

    const entitiesResult = await entityRepo.findByJob(jobId, tenantId);
    expect(entitiesResult.length).toBe(1);
    expect((entitiesResult[0].mergedData as Record<string, unknown>).name).toBe(
      'Wireless Headphones XZ-500',
    );

    // Verify entity sources were linked
    const sources = await entitySourceRepo.findByEntity(entitiesResult[0].id);
    expect(sources.length).toBe(1);

    // Verify job completed
    const completedJob = await jobRepo.findById(jobId, tenantId);
    expect(completedJob!.status).toBe('completed');

    // ---------------------------------------------------------------
    // 6. Export
    // ---------------------------------------------------------------
    const exportRecord = await exportRepo.create({
      jobId,
      tenantId,
      format: 'json',
      includeProvenance: false,
    });

    await processExportJob(
      {
        exportId: exportRecord.id,
        jobId,
        tenantId,
        format: 'json',
        includeProvenance: false,
      },
      workerDeps,
    );

    // Verify export completed
    const completedExport = await exportRepo.findById(exportRecord.id, tenantId);
    expect(completedExport).toBeTruthy();
    expect(completedExport!.status).toBe('completed');
    expect(completedExport!.entityCount).toBe(1);
    expect(completedExport!.contentRef).toBeTruthy();

    // Verify export content is retrievable
    const exportContent = await contentStore.retrieve(completedExport!.contentRef!);
    const parsed = JSON.parse(exportContent);
    expect(parsed.metadata.entityCount).toBe(1);
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0].data.name).toBe('Wireless Headphones XZ-500');
  });

  // =========================================================================
  // Error-path tests — each creates its own tenant + job for isolation
  // =========================================================================

  describe('error paths', () => {
    // Track IDs for per-test cleanup
    const cleanupState: Array<{ tenantId: string; jobId?: string }> = [];

    async function createIsolatedTenant(label: string) {
      const tid = randomUUID();
      await db.execute(sql`INSERT INTO tenants (id, name) VALUES (${tid}, ${label})`);
      return tid;
    }

    async function cleanupTenant(tid: string, jid?: string) {
      try {
        if (jid) {
          await db.execute(
            sql`DELETE FROM entity_sources WHERE entity_id IN (SELECT id FROM entities WHERE job_id = ${jid})`,
          );
          await db.execute(sql`DELETE FROM entities WHERE job_id = ${jid}`);
          await db.execute(sql`DELETE FROM source_trust WHERE job_id = ${jid}`);
          await db.execute(sql`DELETE FROM extractions WHERE job_id = ${jid}`);
          await db.execute(
            sql`DELETE FROM raw_pages WHERE task_id IN (SELECT id FROM crawl_tasks WHERE job_id = ${jid})`,
          );
          await db.execute(sql`DELETE FROM crawl_tasks WHERE job_id = ${jid}`);
          await db.execute(sql`DELETE FROM actions WHERE job_id = ${jid}`);
          await db.execute(sql`DELETE FROM exports WHERE job_id = ${jid}`);
          await db.execute(sql`UPDATE jobs SET schema_id = NULL WHERE id = ${jid}`);
          await db.execute(sql`DELETE FROM schemas WHERE job_id = ${jid}`);
          await db.execute(sql`DELETE FROM jobs WHERE id = ${jid}`);
          await db.execute(
            sql`DELETE FROM content_store WHERE key LIKE ${jid + '%'} OR key LIKE ${'exports/' + tid + '/' + jid + '%'}`,
          );
        }
        await db.execute(sql`DELETE FROM tenants WHERE id = ${tid}`);
      } catch (e) {
        console.error('Error-path cleanup error:', e);
      }
    }

    afterAll(async () => {
      for (const { tenantId: tid, jobId: jid } of cleanupState) {
        await cleanupTenant(tid, jid);
      }
    });

    function makeJobConfig(tid: string, overrides?: Partial<JobConfig>): JobConfig {
      return {
        tenantId: tid,
        name: 'Error Path Test Job',
        description: 'Testing error scenarios in E2E pipeline.',
        seedUrls: [FIXTURE_URL],
        crawl: {
          maxDepth: 0,
          maxPages: 10,
          concurrency: 1,
          crawlerType: 'playwright',
        },
        schema: {
          mode: 'discovery',
          userFields: [
            { name: 'name', description: 'Product name', type: 'string', required: true },
            { name: 'price', description: 'Product price', type: 'number', required: true },
          ],
          evolutionConfig: {
            enabled: true,
            batchSize: 1,
            maxFields: 50,
            relevanceThresholds: {
              requiredMin: 0.85,
              optionalMin: 0.4,
              rareBelow: 0.4,
              minCategorySampleSize: 5,
            },
            tableStrategy: 'auto',
          },
        },
        llm: { primaryModel: 'mock/model' },
        ...overrides,
      };
    }

    function buildWorkerDeps(overrides?: Partial<WorkerDepsConfig>): WorkerDeps {
      const jobRepo = new JobRepository(db);
      const taskRepo = new CrawlTaskRepository(db);
      const schemaRepo = new SchemaRepository(db);
      const extractionRepo = new ExtractionRepository(db);
      const pageRepo = new PageRepository(db);
      const entityRepo = new EntityRepository(db);
      const sourceTrustRepo = new SourceTrustRepository(db);
      const entitySourceRepo = new EntitySourceRepository(db);
      const exportRepo = new ExportRepository(db);
      const actionRepo = new ActionRepository(db);
      const contentStore: ContentStore = new PgContentStore(db);

      return new WorkerDeps({
        crawler: createMockCrawler(),
        extractor: createMockExtractor(),
        classifier: createMockClassifier() as any,
        contentStore,
        schemaEvolver: createMockSchemaEvolver(),
        reconciler: createMockReconciler('placeholder'),
        jobRepo,
        taskRepo,
        pageRepo,
        extractionRepo,
        schemaRepo,
        entityRepo,
        sourceTrustRepo,
        entitySourceRepo,
        exportRepo,
        actionRepo,
        queues,
        ...overrides,
      });
    }

    // -----------------------------------------------------------------
    // Test 1: Crawl failure is handled gracefully
    // -----------------------------------------------------------------
    it('handles crawl failure gracefully', async (ctx) => {
      if (!setupOk) return ctx.skip();
      const tid = await createIsolatedTenant('e2e-crawl-failure');

      const jobRepo = new JobRepository(db);
      const taskRepo = new CrawlTaskRepository(db);
      const schemaRepo = new SchemaRepository(db);
      const extractionRepo = new ExtractionRepository(db);

      const jm = new JobManager({ jobRepo, taskRepo, schemaRepo, queues });
      const jid = await jm.createJob(makeJobConfig(tid));
      cleanupState.push({ tenantId: tid, jobId: jid });

      await jm.startJob(jid, tid);

      // Get the crawl task that was created
      const tasks = await taskRepo.findByJob(jid);
      expect(tasks.length).toBe(1);
      const taskId = tasks[0].id;

      // Build deps with a failing crawler
      const failingCrawler: Crawler = {
        type: 'playwright' as const,
        async crawl(_url: string): Promise<CrawlResult> {
          throw new Error('Network timeout: connection refused');
        },
        async close() {},
      };

      const deps = buildWorkerDeps({ crawler: failingCrawler });

      // Process the crawl job — should NOT throw (error is caught internally)
      await processCrawlJob(
        { taskId, jobId: jid, tenantId: tid, url: FIXTURE_URL, depth: 0 },
        deps,
      );

      // Verify task status is 'failed'
      const failedTasks = await taskRepo.findByJob(jid, { status: 'failed' });
      expect(failedTasks.length).toBe(1);
      expect(failedTasks[0].id).toBe(taskId);

      // Verify no extraction was created
      const extractions = await extractionRepo.findByJob(jid, tid);
      expect(extractions.length).toBe(0);

      // Verify job can still be cancelled
      await jm.cancelJob(jid, tid);
      const cancelledJob = await jobRepo.findById(jid, tid);
      expect(cancelledJob!.status).toBe('cancelled');
    });

    // -----------------------------------------------------------------
    // Test 2: Schema evolution with no changes
    // -----------------------------------------------------------------
    it('handles schema evolution with no proposed changes', async (ctx) => {
      if (!setupOk) return ctx.skip();
      const tid = await createIsolatedTenant('e2e-no-evolution');

      const jobRepo = new JobRepository(db);
      const taskRepo = new CrawlTaskRepository(db);
      const schemaRepo = new SchemaRepository(db);
      const extractionRepo = new ExtractionRepository(db);
      const actionRepo = new ActionRepository(db);

      const jm = new JobManager({ jobRepo, taskRepo, schemaRepo, queues });
      const jid = await jm.createJob(makeJobConfig(tid));
      cleanupState.push({ tenantId: tid, jobId: jid });

      await jm.startJob(jid, tid);

      // Process crawl so we have an extraction (needed for evolution to run)
      const tasks = await taskRepo.findByJob(jid);
      const taskId = tasks[0].id;

      // Use a no-op schema evolver that returns empty actions
      const noOpEvolver: SchemaEvolver = {
        async evolve(
          _currentSchema: SchemaDefinition,
          _recentExtractions: ExtractionResult[],
          _jobDescription: string,
        ): Promise<PipelineAction[]> {
          return [];
        },
      };

      const deps = buildWorkerDeps({ schemaEvolver: noOpEvolver });

      // Crawl first (to produce an extraction for the evolution step)
      await processCrawlJob(
        { taskId, jobId: jid, tenantId: tid, url: FIXTURE_URL, depth: 0 },
        deps,
      );

      const extractions = await extractionRepo.findByJob(jid, tid);
      expect(extractions.length).toBe(1);

      // Now run schema evolution with the no-op evolver
      await processSchemaEvolutionJob(
        { jobId: jid, tenantId: tid, extractionIds: [extractions[0].id] },
        deps,
      );

      // Verify NO new schema version was created (still v1)
      const latestSchema = await schemaRepo.findLatest(jid, tid);
      expect(latestSchema).toBeTruthy();
      expect(latestSchema!.version).toBe(1);

      // Verify no actions were persisted for this job
      const actions = await actionRepo.findByJob(jid, tid);
      expect(actions.length).toBe(0);
    });

    // -----------------------------------------------------------------
    // Test 3: Export of empty job (no entities)
    // -----------------------------------------------------------------
    it('handles export of a job with no entities', async (ctx) => {
      if (!setupOk) return ctx.skip();
      const tid = await createIsolatedTenant('e2e-empty-export');

      const jobRepo = new JobRepository(db);
      const taskRepo = new CrawlTaskRepository(db);
      const schemaRepo = new SchemaRepository(db);
      const exportRepo = new ExportRepository(db);

      const jm = new JobManager({ jobRepo, taskRepo, schemaRepo, queues });
      const jid = await jm.createJob(makeJobConfig(tid));
      cleanupState.push({ tenantId: tid, jobId: jid });

      await jm.startJob(jid, tid);

      // Manually set job to 'completed' so export worker accepts it
      // running → reconciling → completed
      await jobRepo.updateStatus(jid, tid, 'reconciling');
      await jobRepo.updateStatus(jid, tid, 'completed');

      const deps = buildWorkerDeps();

      // Create export record and run export
      const exportRecord = await exportRepo.create({
        jobId: jid,
        tenantId: tid,
        format: 'json',
        includeProvenance: false,
      });

      await processExportJob(
        {
          exportId: exportRecord.id,
          jobId: jid,
          tenantId: tid,
          format: 'json',
          includeProvenance: false,
        },
        deps,
      );

      // Verify export completed with zero entities
      const completedExport = await exportRepo.findById(exportRecord.id, tid);
      expect(completedExport).toBeTruthy();
      expect(completedExport!.status).toBe('completed');
      expect(completedExport!.entityCount).toBe(0);

      // Verify export content is a valid JSON with empty entities array
      const contentStore: ContentStore = new PgContentStore(db);
      const exportContent = await contentStore.retrieve(completedExport!.contentRef!);
      const parsed = JSON.parse(exportContent);
      expect(parsed.metadata.entityCount).toBe(0);
      expect(parsed.entities).toHaveLength(0);
    });

    // -----------------------------------------------------------------
    // Test 4: Job cancellation mid-pipeline
    // -----------------------------------------------------------------
    it('preserves existing data when job is cancelled mid-pipeline', async (ctx) => {
      if (!setupOk) return ctx.skip();
      const tid = await createIsolatedTenant('e2e-cancel-mid');

      const jobRepo = new JobRepository(db);
      const taskRepo = new CrawlTaskRepository(db);
      const schemaRepo = new SchemaRepository(db);
      const extractionRepo = new ExtractionRepository(db);
      const pageRepo = new PageRepository(db);

      const jm = new JobManager({ jobRepo, taskRepo, schemaRepo, queues });
      const jid = await jm.createJob(makeJobConfig(tid));
      cleanupState.push({ tenantId: tid, jobId: jid });

      await jm.startJob(jid, tid);

      // Process one crawl so we have real data in the pipeline
      const tasks = await taskRepo.findByJob(jid);
      expect(tasks.length).toBe(1);
      const taskId = tasks[0].id;

      const deps = buildWorkerDeps();

      await processCrawlJob(
        { taskId, jobId: jid, tenantId: tid, url: FIXTURE_URL, depth: 0 },
        deps,
      );

      // Confirm data exists before cancellation
      const completedTasks = await taskRepo.findByJob(jid, { status: 'completed' });
      expect(completedTasks.length).toBe(1);

      const extractions = await extractionRepo.findByJob(jid, tid);
      expect(extractions.length).toBe(1);

      // Now cancel the job
      await jm.cancelJob(jid, tid);

      // Verify job status is 'cancelled'
      const cancelledJob = await jobRepo.findById(jid, tid);
      expect(cancelledJob!.status).toBe('cancelled');

      // Verify existing data is preserved (NOT deleted)
      const tasksAfterCancel = await taskRepo.findByJob(jid);
      expect(tasksAfterCancel.length).toBe(1);
      expect(tasksAfterCancel[0].status).toBe('completed');

      const extractionsAfterCancel = await extractionRepo.findByJob(jid, tid);
      expect(extractionsAfterCancel.length).toBe(1);
      expect((extractionsAfterCancel[0].data as Record<string, unknown>).name).toBe(
        'Wireless Headphones XZ-500',
      );

      // Schema should also be preserved
      const schema = await schemaRepo.findLatest(jid, tid);
      expect(schema).toBeTruthy();
      expect(schema!.version).toBeGreaterThanOrEqual(1);
    });
  });
});
