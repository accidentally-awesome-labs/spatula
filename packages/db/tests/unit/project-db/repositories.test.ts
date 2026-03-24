/**
 * Integration tests for all SQLite repositories against an in-memory SQLite DB.
 *
 * These tests create a REAL in-memory SQLite database, initialize it with
 * migrations, and exercise each repository. No mocks — this catches
 * Drizzle schema / SQL mismatches at test time.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createProjectDb, initializeProjectDb } from '../../../src/project-db/connection.js';
import { ProjectAdapter } from '../../../src/project-db/adapter.js';
import type { ProjectDbResult } from '../../../src/project-db/connection.js';

describe('SQLite Repositories (in-memory)', () => {
  let dbResult: ProjectDbResult;
  let adapter: ProjectAdapter;
  const projectId = '00000000-0000-0000-0000-000000000001';
  const tenantId = '00000000-0000-0000-0000-000000000002'; // ignored by SQLite repos

  beforeAll(() => {
    dbResult = createProjectDb(':memory:');
    initializeProjectDb(dbResult.db, { projectId, name: 'test-project' });
    adapter = new ProjectAdapter(dbResult.db, projectId);
  });

  afterAll(() => {
    dbResult.close();
  });

  // ---------------------------------------------------------------------------
  // ProjectMetaRepository
  // ---------------------------------------------------------------------------

  describe('ProjectMetaRepository', () => {
    it('reads seeded project_id', async () => {
      const value = await adapter.getMeta('project_id');
      expect(value).toBe(projectId);
    });

    it('reads seeded project_name', async () => {
      const value = await adapter.getMeta('project_name');
      expect(value).toBe('test-project');
    });

    it('sets and gets a custom value', async () => {
      await adapter.metaRepo.set('custom_key', 'custom_value');
      const value = await adapter.metaRepo.get('custom_key');
      expect(value).toBe('custom_value');
    });

    it('overwrites an existing value', async () => {
      await adapter.metaRepo.set('custom_key', 'updated_value');
      const value = await adapter.metaRepo.get('custom_key');
      expect(value).toBe('updated_value');
    });

    it('returns null for non-existent key', async () => {
      const value = await adapter.metaRepo.get('nonexistent_key');
      expect(value).toBeNull();
    });

    it('getAll returns all seeded + custom entries', async () => {
      const all = await adapter.metaRepo.getAll();
      expect(all).toHaveProperty('project_id', projectId);
      expect(all).toHaveProperty('project_name', 'test-project');
      expect(all).toHaveProperty('schema_version', '1');
      expect(all).toHaveProperty('created_at');
      expect(all).toHaveProperty('custom_key');
    });
  });

  // ---------------------------------------------------------------------------
  // PageRepository
  // ---------------------------------------------------------------------------

  describe('PageRepository', () => {
    it('creates a page and returns an id', async () => {
      const page = await adapter.pageRepo.create({
        taskId: 'task-1',
        tenantId,
        contentRef: 'ref-1',
        contentHash: 'hash-abc',
        metadata: { url: 'https://example.com', title: 'Test' },
      });
      expect(page.id).toBeDefined();
      expect(typeof page.id).toBe('string');
    });

    it('finds a page by content hash', async () => {
      const found = await adapter.pageRepo.findByContentHash('hash-abc', tenantId);
      expect(found).not.toBeNull();
      expect(found!.id).toBeDefined();
    });

    it('returns null for non-existent content hash', async () => {
      const found = await adapter.pageRepo.findByContentHash('nonexistent', tenantId);
      expect(found).toBeNull();
    });

    it('creates a page with SQLite-only extensions', async () => {
      const page = await adapter.pageRepo.create({
        taskId: 'task-2',
        tenantId,
        contentRef: 'ref-2',
        contentHash: 'hash-def',
        metadata: {},
        url: 'https://example.com/page2',
        statusCode: 200,
        title: 'Page 2',
        classification: 'single_entry',
      });
      expect(page.id).toBeDefined();
    });

    it('finds pages by ids', async () => {
      const p1 = await adapter.pageRepo.create({
        taskId: 'task-3',
        tenantId,
        contentRef: 'ref-3',
        contentHash: 'hash-ghi',
        metadata: { title: 'Find Me' },
      });

      const results = await adapter.pageRepo.findByIds([p1.id], tenantId);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(p1.id);
      expect(results[0].metadata).toBeDefined();
      expect(results[0].createdAt).toBeInstanceOf(Date);
    });

    it('findByIds returns empty array for empty input', async () => {
      const results = await adapter.pageRepo.findByIds([], tenantId);
      expect(results).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // ExtractionRepository
  // ---------------------------------------------------------------------------

  describe('ExtractionRepository', () => {
    it('stores an extraction and returns an id', async () => {
      const result = await adapter.extractionRepo.store({
        jobId: projectId,
        tenantId,
        pageId: 'page-1',
        schemaVersion: 1,
        data: { title: 'Test Product', price: 29.99 },
        unmappedFields: [],
        metadata: { confidence: 0.95 },
      });
      expect(result.id).toBeDefined();
    });

    it('retrieves extractions by job', async () => {
      const results = await adapter.extractionRepo.findByJob(projectId, tenantId);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].data).toBeDefined();
      expect(results[0].jobId).toBe(projectId);
      expect(results[0].pageId).toBe('page-1');
      expect(results[0].schemaVersion).toBe(1);
    });

    it('filters extractions by schema version', async () => {
      await adapter.extractionRepo.store({
        jobId: projectId,
        tenantId,
        pageId: 'page-2',
        schemaVersion: 2,
        data: { title: 'V2 Product' },
        unmappedFields: [],
        metadata: {},
      });

      const v1 = await adapter.extractionRepo.findByJob(projectId, tenantId, { schemaVersion: 1 });
      const v2 = await adapter.extractionRepo.findByJob(projectId, tenantId, { schemaVersion: 2 });
      expect(v1.length).toBeGreaterThanOrEqual(1);
      expect(v2.length).toBeGreaterThanOrEqual(1);
      expect(v1.every((e) => e.schemaVersion === 1)).toBe(true);
      expect(v2.every((e) => e.schemaVersion === 2)).toBe(true);
    });

    it('respects limit and offset options', async () => {
      const limited = await adapter.extractionRepo.findByJob(projectId, tenantId, { limit: 1 });
      expect(limited).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // SchemaRepository
  // ---------------------------------------------------------------------------

  describe('SchemaRepository', () => {
    it('creates a schema and returns an id', async () => {
      const result = await adapter.schemaRepo.create({
        jobId: projectId,
        tenantId,
        version: 1,
        definition: {
          version: 1,
          fields: [{ name: 'title', type: 'string', confidence: 0.9, provenance: 'extracted', sources: [] }],
          fieldAliases: [],
          createdAt: new Date(),
          parentVersion: null,
        } as any,
      });
      expect(result).toBeDefined();
    });

    it('finds latest schema', async () => {
      const latest = await adapter.schemaRepo.findLatest(projectId, tenantId);
      expect(latest).not.toBeNull();
      expect(latest!.version).toBe(1);
      expect(latest!.definition).toBeDefined();
    });

    it('creates a newer schema version and findLatest returns it', async () => {
      await adapter.schemaRepo.create({
        jobId: projectId,
        tenantId,
        version: 2,
        definition: {
          version: 2,
          fields: [
            { name: 'title', type: 'string', confidence: 0.95, provenance: 'extracted', sources: [] },
            { name: 'price', type: 'number', confidence: 0.8, provenance: 'extracted', sources: [] },
          ],
          fieldAliases: [],
          createdAt: new Date(),
          parentVersion: 1,
        } as any,
      });

      const latest = await adapter.schemaRepo.findLatest(projectId, tenantId);
      expect(latest).not.toBeNull();
      expect(latest!.version).toBe(2);
    });

    it('findAllVersions returns all versions ordered desc', async () => {
      const versions = await adapter.schemaRepo.findAllVersions(projectId);
      expect(versions.length).toBeGreaterThanOrEqual(2);
      // Ordered by version desc
      expect(versions[0].version).toBeGreaterThanOrEqual(versions[versions.length - 1].version);
    });
  });

  // ---------------------------------------------------------------------------
  // CrawlTaskRepository
  // ---------------------------------------------------------------------------

  describe('CrawlTaskRepository', () => {
    let taskId: string;

    it('enqueues a task', async () => {
      const task = await adapter.taskRepo.enqueue({
        jobId: projectId,
        tenantId,
        url: 'https://example.com/page1',
        depth: 0,
        parentTaskId: '',
      });
      expect(task.id).toBeDefined();
      taskId = task.id;
    });

    it('updates task status', async () => {
      await adapter.taskRepo.updateStatus(taskId, tenantId, 'completed');
      // No error thrown = success (status update is fire-and-forget in interface)
    });

    it('updates task classification', async () => {
      await adapter.taskRepo.updateClassification(taskId, tenantId, 'single_entry');
    });

    it('enqueues a second task in pending state', async () => {
      await adapter.taskRepo.enqueue({
        jobId: projectId,
        tenantId,
        url: 'https://example.com/page2',
        depth: 1,
        parentTaskId: taskId,
      });
    });

    it('gets job stats with correct counts', async () => {
      const stats = await adapter.taskRepo.getJobStats(projectId, tenantId);
      expect(stats).toHaveProperty('pending');
      expect(stats).toHaveProperty('completed');
      expect(stats).toHaveProperty('inProgress');
      expect(stats).toHaveProperty('failed');
      expect(stats).toHaveProperty('skipped');
      // We have 1 completed + 1 pending
      expect(stats.completed).toBe(1);
      expect(stats.pending).toBe(1);
    });

    it('finds pending tasks', async () => {
      const pending = await adapter.taskRepo.findPending(projectId);
      expect(pending.length).toBeGreaterThanOrEqual(1);
      expect(pending[0].url).toBe('https://example.com/page2');
    });
  });

  // ---------------------------------------------------------------------------
  // EntityRepository
  // ---------------------------------------------------------------------------

  describe('EntityRepository', () => {
    let entityId: string;

    it('creates an entity and returns an id', async () => {
      const result = await adapter.entityRepo.create({
        jobId: projectId,
        tenantId,
        mergedData: { name: 'Test Entity', price: 29.99 },
        provenance: { name: 'extracted', price: 'extracted' },
        qualityScore: 0.85,
      });
      expect(result.id).toBeDefined();
      entityId = result.id;
    });

    it('creates an entity with categories', async () => {
      const result = await adapter.entityRepo.create({
        jobId: projectId,
        tenantId,
        mergedData: { name: 'Categorized Entity' },
        provenance: {},
        qualityScore: 0.9,
        categories: ['electronics', 'gadgets'],
      });
      expect(result.id).toBeDefined();
    });

    it('counts entities by job', async () => {
      const count = await adapter.entityRepo.countByJob(projectId, tenantId);
      expect(count).toBeGreaterThanOrEqual(2);
    });

    it('finds entities by job', async () => {
      const entities = await adapter.entityRepo.findByJob(projectId, tenantId);
      expect(entities.length).toBeGreaterThanOrEqual(2);
    });

    it('finds entities by job with provenance', async () => {
      const entities = await adapter.entityRepo.findByJobWithProvenance(projectId, tenantId);
      expect(entities.length).toBeGreaterThanOrEqual(2);
    });

    it('respects limit option', async () => {
      const entities = await adapter.entityRepo.findByJob(projectId, tenantId, { limit: 1, offset: 0 });
      expect(entities).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // EntitySourceRepository
  // ---------------------------------------------------------------------------

  describe('EntitySourceRepository', () => {
    it('bulk links entities to extractions', async () => {
      // Create an entity and extraction for linking
      const entity = await adapter.entityRepo.create({
        jobId: projectId,
        tenantId,
        mergedData: { name: 'Linked Entity' },
        provenance: {},
        qualityScore: 0.7,
      });

      const extraction = await adapter.extractionRepo.store({
        jobId: projectId,
        tenantId,
        pageId: 'page-link-test',
        schemaVersion: 1,
        data: { name: 'Linked Entity' },
        unmappedFields: [],
        metadata: {},
      });

      const result = await adapter.entitySourceRepo.bulkLink([
        { entityId: entity.id, extractionId: extraction.id, matchConfidence: 0.95 },
      ]);
      expect(result).toEqual({ count: 1 });
    });

    it('handles empty bulk link gracefully', async () => {
      const result = await adapter.entitySourceRepo.bulkLink([]);
      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // ActionRepository
  // ---------------------------------------------------------------------------

  describe('ActionRepository', () => {
    let actionId: string;

    it('creates an action and returns an id', async () => {
      const result = await adapter.actionRepo.create({
        jobId: projectId,
        tenantId,
        type: 'add_field',
        payload: { fieldName: 'description', fieldType: 'string' },
        source: 'extraction',
        status: 'pending_review',
        confidence: 0.85,
        reasoning: 'Multiple pages contain description data',
      }) as { id: string };
      expect(result.id).toBeDefined();
      actionId = result.id;
    });

    it('finds actions by job', async () => {
      const actions = await adapter.actionRepo.findByJob(projectId);
      expect(actions.length).toBeGreaterThanOrEqual(1);
      expect(actions[0].type).toBe('add_field');
      expect(actions[0].status).toBe('pending_review');
    });

    it('finds actions by job with status filter', async () => {
      const pending = await adapter.actionRepo.findByJob(projectId, { status: 'pending_review' });
      expect(pending.length).toBeGreaterThanOrEqual(1);

      const applied = await adapter.actionRepo.findByJob(projectId, { status: 'applied' });
      expect(applied).toHaveLength(0);
    });

    it('updates action status', async () => {
      await adapter.actionRepo.updateStatus(actionId, tenantId, 'applied', 'user');

      const actions = await adapter.actionRepo.findByJob(projectId, { status: 'applied' });
      expect(actions).toHaveLength(1);
      expect(actions[0].id).toBe(actionId);
      expect(actions[0].reviewedBy).toBe('user');
      expect(actions[0].appliedAt).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // SourceTrustRepository
  // ---------------------------------------------------------------------------

  describe('SourceTrustRepository', () => {
    it('upserts a source trust record', async () => {
      const result = await adapter.sourceTrustRepo.upsert({
        jobId: projectId,
        tenantId,
        domain: 'example.com',
        trustLevel: 'high',
        reasoning: 'Consistent data quality', // silently dropped per spec
        score: 0.9,
      }) as { id: string };
      expect(result.id).toBeDefined();
    });

    it('finds trust records by job', async () => {
      const records = await adapter.sourceTrustRepo.findByJob(projectId);
      expect(records.length).toBeGreaterThanOrEqual(1);
      expect(records[0].domain).toBe('example.com');
      expect(records[0].trustLevel).toBe('high');
      expect(records[0].score).toBe(0.9);
    });

    it('upsert replaces existing record for same domain', async () => {
      await adapter.sourceTrustRepo.upsert({
        jobId: projectId,
        tenantId,
        domain: 'example.com',
        trustLevel: 'medium',
        reasoning: 'Revised assessment',
        score: 0.6,
      });

      const records = await adapter.sourceTrustRepo.findByJob(projectId);
      const exampleRecords = records.filter((r) => r.domain === 'example.com');
      expect(exampleRecords).toHaveLength(1);
      expect(exampleRecords[0].trustLevel).toBe('medium');
      expect(exampleRecords[0].score).toBe(0.6);
    });
  });

  // ---------------------------------------------------------------------------
  // RunRepository
  // ---------------------------------------------------------------------------

  describe('RunRepository', () => {
    let runId: string;

    it('creates a run and returns an id', async () => {
      const run = await adapter.runRepo.create({
        status: 'running',
        source: 'local',
        configSnapshot: { seeds: ['https://example.com'], maxPages: 100 },
        startedAt: new Date().toISOString(),
      });
      expect(run.id).toBeDefined();
      runId = run.id;
    });

    it('finds a run by id', async () => {
      const found = await adapter.runRepo.findById(runId);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(runId);
      expect(found!.status).toBe('running');
      expect(found!.source).toBe('local');
      expect(found!.configSnapshot).toEqual({ seeds: ['https://example.com'], maxPages: 100 });
    });

    it('returns null for non-existent run id', async () => {
      const found = await adapter.runRepo.findById('nonexistent-id');
      expect(found).toBeNull();
    });

    it('finds latest run by status', async () => {
      const latest = await adapter.runRepo.findLatestByStatus(['running', 'completed', 'paused']);
      expect(latest).not.toBeNull();
      expect(latest!.status).toBe('running');
    });

    it('findLatestByStatus returns null for unmatched statuses', async () => {
      const latest = await adapter.runRepo.findLatestByStatus(['nonexistent_status']);
      expect(latest).toBeNull();
    });

    it('findLatestByStatus returns null for empty array', async () => {
      const latest = await adapter.runRepo.findLatestByStatus([]);
      expect(latest).toBeNull();
    });

    it('updates run status', async () => {
      await adapter.runRepo.updateStatus(runId, 'completed', new Date().toISOString());
      const found = await adapter.runRepo.findById(runId);
      expect(found!.status).toBe('completed');
      expect(found!.completedAt).toBeDefined();
    });

    it('updates run stats', async () => {
      await adapter.runRepo.updateStats(runId, {
        pagesCrawled: 42,
        entitiesCreated: 15,
        llmTokensUsed: 10000,
        llmCostUsd: 0.05,
      });
      const found = await adapter.runRepo.findById(runId);
      expect(found!.pagesCrawled).toBe(42);
      expect(found!.entitiesCreated).toBe(15);
      expect(found!.llmTokensUsed).toBe(10000);
    });
  });

  // ---------------------------------------------------------------------------
  // LlmUsageRepository
  // ---------------------------------------------------------------------------

  describe('LlmUsageRepository', () => {
    let usageRunId: string;

    beforeAll(async () => {
      const run = await adapter.runRepo.create({
        status: 'running',
        source: 'local',
        configSnapshot: {},
        startedAt: new Date().toISOString(),
      });
      usageRunId = run.id;
    });

    it('records LLM usage', async () => {
      const result = await adapter.llmUsageRepo.record({
        runId: usageRunId,
        model: 'gpt-4o-mini',
        promptTokens: 500,
        completionTokens: 200,
        totalTokens: 700,
        costUsd: 0.002,
        purpose: 'extraction',
      });
      expect(result.id).toBeDefined();
    });

    it('records a second usage entry', async () => {
      await adapter.llmUsageRepo.record({
        runId: usageRunId,
        model: 'gpt-4o-mini',
        promptTokens: 300,
        completionTokens: 100,
        totalTokens: 400,
        costUsd: 0.001,
        purpose: 'extraction',
      });
    });

    it('records usage for a different purpose', async () => {
      await adapter.llmUsageRepo.record({
        runId: usageRunId,
        model: 'gpt-4o',
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        costUsd: 0.05,
        purpose: 'classification',
      });
    });

    it('finds usage by run', async () => {
      const usage = await adapter.llmUsageRepo.findByRun(usageRunId);
      expect(usage.length).toBe(3);
      expect(usage[0].model).toBeDefined();
      expect(usage[0].purpose).toBeDefined();
    });

    it('aggregates usage by run (grouped by purpose)', async () => {
      const agg = await adapter.llmUsageRepo.aggregateByRun(usageRunId);
      expect(agg.length).toBe(2); // extraction + classification

      const extraction = agg.find((a) => a.purpose === 'extraction');
      expect(extraction).toBeDefined();
      expect(extraction!.callCount).toBe(2);
      expect(extraction!.totalPromptTokens).toBe(800);
      expect(extraction!.totalCompletionTokens).toBe(300);
      expect(extraction!.totalTokens).toBe(1100);

      const classification = agg.find((a) => a.purpose === 'classification');
      expect(classification).toBeDefined();
      expect(classification!.callCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // ExportRepository
  // ---------------------------------------------------------------------------

  describe('ExportRepository', () => {
    let exportId: string;

    it('creates an export record', async () => {
      const result = await adapter.exportRepo.create({
        format: 'json',
        filePath: '/tmp/test-export.json',
        includeProvenance: true,
      });
      expect(result.id).toBeDefined();
      exportId = result.id;
    });

    it('finds an export by id', async () => {
      const found = await adapter.exportRepo.findById(exportId);
      expect(found).not.toBeNull();
      expect(found!.format).toBe('json');
      expect(found!.filePath).toBe('/tmp/test-export.json');
      expect(found!.status).toBe('pending');
      expect(found!.includeProvenance).toBe(true);
    });

    it('returns null for non-existent export id', async () => {
      const found = await adapter.exportRepo.findById('nonexistent');
      expect(found).toBeNull();
    });

    it('finds all exports', async () => {
      await adapter.exportRepo.create({
        format: 'csv',
        filePath: '/tmp/test-export.csv',
      });

      const all = await adapter.exportRepo.findAll();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('updates export status', async () => {
      await adapter.exportRepo.updateStatus(exportId, tenantId, {
        status: 'completed',
        entityCount: 42,
        fileSize: 12345,
        completedAt: new Date(),
      });

      const found = await adapter.exportRepo.findById(exportId);
      expect(found!.status).toBe('completed');
      expect(found!.entityCount).toBe(42);
      expect(found!.fileSize).toBe(12345);
      expect(found!.completedAt).toBeDefined();
    });

    it('updates export status with error', async () => {
      const errorExport = await adapter.exportRepo.create({
        format: 'parquet',
        filePath: '/tmp/test-export.parquet',
      });

      await adapter.exportRepo.updateStatus(errorExport.id, tenantId, {
        status: 'failed',
        error: 'Disk full',
      });

      const found = await adapter.exportRepo.findById(errorExport.id);
      expect(found!.status).toBe('failed');
      expect(found!.error).toBe('Disk full');
    });
  });

  // ---------------------------------------------------------------------------
  // JobRepository (Synthetic)
  // ---------------------------------------------------------------------------

  describe('JobRepository (Synthetic)', () => {
    it('returns synthetic job from latest run', async () => {
      // Runs were created in RunRepository tests above
      const job = await adapter.jobRepo.findById(projectId, tenantId);
      expect(job).not.toBeNull();
      expect(job!.id).toBe(projectId);
      expect(job!.config).toBeDefined();
      expect(job!.status).toBeDefined();
    });

    it('updateStatus updates the latest run status', async () => {
      await adapter.jobRepo.updateStatus(projectId, tenantId, 'paused');
      const job = await adapter.jobRepo.findById(projectId, tenantId);
      expect(job).not.toBeNull();
      expect(job!.status).toBe('paused');
    });
  });

  // ---------------------------------------------------------------------------
  // ProjectAdapter
  // ---------------------------------------------------------------------------

  describe('ProjectAdapter', () => {
    it('returns projectId', () => {
      expect(adapter.getProjectId()).toBe(projectId);
    });

    it('has all 13 repositories initialized', () => {
      expect(adapter.jobRepo).toBeDefined();
      expect(adapter.pageRepo).toBeDefined();
      expect(adapter.extractionRepo).toBeDefined();
      expect(adapter.entityRepo).toBeDefined();
      expect(adapter.entitySourceRepo).toBeDefined();
      expect(adapter.schemaRepo).toBeDefined();
      expect(adapter.taskRepo).toBeDefined();
      expect(adapter.actionRepo).toBeDefined();
      expect(adapter.sourceTrustRepo).toBeDefined();
      expect(adapter.runRepo).toBeDefined();
      expect(adapter.llmUsageRepo).toBeDefined();
      expect(adapter.exportRepo).toBeDefined();
      expect(adapter.metaRepo).toBeDefined();
    });

    it('getMeta convenience method works', async () => {
      const value = await adapter.getMeta('project_id');
      expect(value).toBe(projectId);
    });
  });
});
