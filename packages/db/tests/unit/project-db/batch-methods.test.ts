/**
 * Tests for batch methods on SQLite repositories:
 * - SqliteExtractionRepository.upsertBatch / deleteByRunIds / findIdsByRunId
 * - SqliteActionRepository.upsertBatch / deleteByRunIds
 * - SqliteEntitySourceRepository.upsertBatchSources / deleteByExtractionIds
 *
 * Uses an in-memory SQLite database with real migrations applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createProjectDb, initializeProjectDb } from '../../../src/project-db/connection.js';
import { SqliteExtractionRepository } from '../../../src/project-db/repositories/extraction-repository.js';
import { SqliteActionRepository } from '../../../src/project-db/repositories/action-repository.js';
import {
  SqliteEntityRepository,
  SqliteEntitySourceRepository,
} from '../../../src/project-db/repositories/entity-repository.js';
import type { ProjectDbResult } from '../../../src/project-db/connection.js';

const PROJECT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

describe('SQLite Batch Methods (in-memory)', () => {
  let dbResult: ProjectDbResult;
  let extractionRepo: SqliteExtractionRepository;
  let actionRepo: SqliteActionRepository;
  let entityRepo: SqliteEntityRepository;
  let entitySourceRepo: SqliteEntitySourceRepository;

  beforeAll(() => {
    dbResult = createProjectDb(':memory:');
    initializeProjectDb(dbResult.db, { projectId: PROJECT_ID, name: 'batch-test-project' });
    extractionRepo = new SqliteExtractionRepository(dbResult.db, PROJECT_ID);
    actionRepo = new SqliteActionRepository(dbResult.db, PROJECT_ID);
    entityRepo = new SqliteEntityRepository(dbResult.db, PROJECT_ID);
    entitySourceRepo = new SqliteEntitySourceRepository(dbResult.db, PROJECT_ID);
  });

  afterAll(() => {
    dbResult.close();
  });

  // ---------------------------------------------------------------------------
  // ExtractionRepository batch methods
  // ---------------------------------------------------------------------------

  describe('SqliteExtractionRepository', () => {
    const runId1 = 'run-ext-1';
    const runId2 = 'run-ext-2';

    const makeExtraction = (id: string, runId: string | null) => ({
      id,
      pageId: null,
      pageUrl: `https://example.com/${id}`,
      schemaVersion: 1,
      data: { title: `Product ${id}` },
      unmappedFields: [],
      metadata: { confidence: 0.9 },
      runId,
    });

    describe('upsertBatch', () => {
      it('returns {0, 0} for empty batch', async () => {
        const result = await extractionRepo.upsertBatch([]);
        expect(result).toEqual({ inserted: 0, updated: 0 });
      });

      it('inserts new records and returns correct counts', async () => {
        const batch = [
          makeExtraction('ext-001', runId1),
          makeExtraction('ext-002', runId1),
          makeExtraction('ext-003', runId2),
        ];
        const result = await extractionRepo.upsertBatch(batch);
        expect(result).toEqual({ inserted: 3, updated: 0 });
      });

      it('updates existing records on conflict and returns correct counts', async () => {
        const batch = [
          makeExtraction('ext-001', runId1), // already exists → update
          makeExtraction('ext-004', runId1), // new → insert
        ];
        const result = await extractionRepo.upsertBatch(batch);
        expect(result).toEqual({ inserted: 1, updated: 1 });
      });

      it('updates data on conflict', async () => {
        const updated = {
          ...makeExtraction('ext-001', runId1),
          data: { title: 'Updated Product' },
        };
        await extractionRepo.upsertBatch([updated]);

        // Verify the update via findByJob
        const all = await extractionRepo.findByJob(PROJECT_ID, '');
        const row = all.find((e: any) => e.id === 'ext-001');
        expect(row).toBeDefined();
        expect((row as any).data).toMatchObject({ title: 'Updated Product' });
      });

      it('handles a batch where all records already exist', async () => {
        const batch = [makeExtraction('ext-001', runId1), makeExtraction('ext-002', runId1)];
        const result = await extractionRepo.upsertBatch(batch);
        expect(result).toEqual({ inserted: 0, updated: 2 });
      });

      it('counts within-batch duplicate ids as 1 insert + 1 update', async () => {
        // ext-dup-1 is brand new but appears twice in the same batch.
        // First occurrence = insert; second occurrence = update of the
        // row inserted moments ago. Wrong impl would count both as inserts.
        // Use isolated runId so it doesn't pollute downstream findIdsByRunId tests.
        const dupRun = 'run-ext-dup';
        const batch = [makeExtraction('ext-dup-1', dupRun), makeExtraction('ext-dup-1', dupRun)];
        const result = await extractionRepo.upsertBatch(batch);
        expect(result).toEqual({ inserted: 1, updated: 1 });
      });
    });

    describe('deleteByRunIds', () => {
      it('returns 0 for empty array', async () => {
        const count = await extractionRepo.deleteByRunIds([]);
        expect(count).toBe(0);
      });

      it('deletes records matching runId and returns count', async () => {
        // ext-002 and ext-004 are on runId1; ext-003 is on runId2
        const count = await extractionRepo.deleteByRunIds([runId2]);
        expect(count).toBe(1); // only ext-003
      });

      it('does not delete records from a different project', async () => {
        // Create a separate repo with a different projectId
        const otherRepo = new SqliteExtractionRepository(dbResult.db, 'other-project-id');
        // ext-001, ext-002, ext-004 belong to PROJECT_ID / runId1
        const count = await otherRepo.deleteByRunIds([runId1]);
        expect(count).toBe(0); // none belong to "other-project-id"
      });

      it('deletes across multiple runIds', async () => {
        // First re-insert ext-003 on runId2
        await extractionRepo.upsertBatch([makeExtraction('ext-003', runId2)]);

        // Insert something on a third runId
        const runId3 = 'run-ext-3';
        await extractionRepo.upsertBatch([makeExtraction('ext-005', runId3)]);

        const count = await extractionRepo.deleteByRunIds([runId2, runId3]);
        expect(count).toBe(2); // ext-003 + ext-005
      });

      it('returns 0 when no records match', async () => {
        const count = await extractionRepo.deleteByRunIds(['nonexistent-run']);
        expect(count).toBe(0);
      });
    });

    describe('findIdsByRunId', () => {
      it('returns ids for existing runId', async () => {
        // runId1 has ext-001, ext-002, ext-004 remaining
        const ids = await extractionRepo.findIdsByRunId(runId1);
        expect(ids).toHaveLength(3);
        expect(ids).toEqual(expect.arrayContaining(['ext-001', 'ext-002', 'ext-004']));
      });

      it('returns empty array for unknown runId', async () => {
        const ids = await extractionRepo.findIdsByRunId('nonexistent-run');
        expect(ids).toEqual([]);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // ActionRepository batch methods
  // ---------------------------------------------------------------------------

  describe('SqliteActionRepository', () => {
    const runId1 = 'run-act-1';
    const runId2 = 'run-act-2';
    const now = new Date().toISOString();

    const makeAction = (id: string, runId: string | null) => ({
      id,
      type: 'add_field',
      payload: { fieldName: 'description' },
      source: 'extraction' as const,
      status: 'pending_review',
      confidence: 0.85,
      reasoning: `Reasoning for ${id}`,
      runId,
      createdAt: now,
      updatedAt: now,
      appliedAt: null,
      stateChanges: null,
      reviewedBy: null,
    });

    describe('upsertBatch', () => {
      it('returns {0, 0} for empty batch', async () => {
        const result = await actionRepo.upsertBatch([]);
        expect(result).toEqual({ inserted: 0, updated: 0 });
      });

      it('inserts new records and returns correct counts', async () => {
        const batch = [
          makeAction('act-001', runId1),
          makeAction('act-002', runId1),
          makeAction('act-003', runId2),
        ];
        const result = await actionRepo.upsertBatch(batch);
        expect(result).toEqual({ inserted: 3, updated: 0 });
      });

      it('updates existing records on conflict and returns correct counts', async () => {
        const batch = [
          makeAction('act-001', runId1), // already exists → update
          makeAction('act-004', runId1), // new → insert
        ];
        const result = await actionRepo.upsertBatch(batch);
        expect(result).toEqual({ inserted: 1, updated: 1 });
      });

      it('updates reasoning on conflict', async () => {
        const updated = {
          ...makeAction('act-001', runId1),
          reasoning: 'Updated reasoning',
          status: 'approved',
        };
        await actionRepo.upsertBatch([updated]);

        const all = await actionRepo.findByJob(PROJECT_ID);
        const row = all.find((a) => a.id === 'act-001');
        expect(row).toBeDefined();
        expect(row!.reasoning).toBe('Updated reasoning');
        expect(row!.status).toBe('approved');
      });

      it('handles a batch where all records already exist', async () => {
        const batch = [makeAction('act-001', runId1), makeAction('act-002', runId1)];
        const result = await actionRepo.upsertBatch(batch);
        expect(result).toEqual({ inserted: 0, updated: 2 });
      });

      it('counts within-batch duplicate ids as 1 insert + 1 update', async () => {
        const batch = [makeAction('act-dup-1', runId1), makeAction('act-dup-1', runId1)];
        const result = await actionRepo.upsertBatch(batch);
        expect(result).toEqual({ inserted: 1, updated: 1 });
      });

      it('correctly sets optional fields stateChanges and reviewedBy', async () => {
        const withOptionals = {
          ...makeAction('act-005', runId1),
          stateChanges: { before: 'a', after: 'b' },
          reviewedBy: 'user@example.com',
        };
        const result = await actionRepo.upsertBatch([withOptionals]);
        expect(result).toEqual({ inserted: 1, updated: 0 });
      });
    });

    describe('deleteByRunIds', () => {
      it('returns 0 for empty array', async () => {
        const count = await actionRepo.deleteByRunIds([]);
        expect(count).toBe(0);
      });

      it('deletes records matching runId and returns count', async () => {
        // act-003 is on runId2
        const count = await actionRepo.deleteByRunIds([runId2]);
        expect(count).toBe(1);
      });

      it('does not delete records from a different project', async () => {
        const otherRepo = new SqliteActionRepository(dbResult.db, 'other-project-id');
        const count = await otherRepo.deleteByRunIds([runId1]);
        expect(count).toBe(0);
      });

      it('deletes across multiple runIds', async () => {
        // Re-insert act-003 on runId2
        await actionRepo.upsertBatch([makeAction('act-003', runId2)]);
        // Add act-006 on runId3
        const runId3 = 'run-act-3';
        await actionRepo.upsertBatch([makeAction('act-006', runId3)]);

        const count = await actionRepo.deleteByRunIds([runId2, runId3]);
        expect(count).toBe(2);
      });

      it('returns 0 when no records match', async () => {
        const count = await actionRepo.deleteByRunIds(['nonexistent-run']);
        expect(count).toBe(0);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // EntitySourceRepository batch methods
  // ---------------------------------------------------------------------------

  describe('SqliteEntitySourceRepository', () => {
    // We need real entity and extraction IDs — create them first
    let entityId1: string;
    let entityId2: string;
    let extractionId1: string;
    let extractionId2: string;
    let extractionId3: string;

    beforeAll(async () => {
      const tenantId = 'ignored';

      const e1 = await entityRepo.create({
        jobId: PROJECT_ID,
        tenantId,
        mergedData: { name: 'Entity 1' },
        provenance: {},
        qualityScore: 0.9,
      });
      entityId1 = e1.id;

      const e2 = await entityRepo.create({
        jobId: PROJECT_ID,
        tenantId,
        mergedData: { name: 'Entity 2' },
        provenance: {},
        qualityScore: 0.8,
      });
      entityId2 = e2.id;

      const ex1 = await extractionRepo.store({
        jobId: PROJECT_ID,
        tenantId,
        pageId: 'p1',
        schemaVersion: 1,
        data: { name: 'Extraction 1' },
        unmappedFields: [],
        metadata: {},
      });
      extractionId1 = ex1.id;

      const ex2 = await extractionRepo.store({
        jobId: PROJECT_ID,
        tenantId,
        pageId: 'p2',
        schemaVersion: 1,
        data: { name: 'Extraction 2' },
        unmappedFields: [],
        metadata: {},
      });
      extractionId2 = ex2.id;

      const ex3 = await extractionRepo.store({
        jobId: PROJECT_ID,
        tenantId,
        pageId: 'p3',
        schemaVersion: 1,
        data: { name: 'Extraction 3' },
        unmappedFields: [],
        metadata: {},
      });
      extractionId3 = ex3.id;
    });

    describe('upsertBatchSources', () => {
      it('returns 0 for empty batch', async () => {
        const count = await entitySourceRepo.upsertBatchSources([]);
        expect(count).toBe(0);
      });

      it('inserts new source links and returns count', async () => {
        const batch = [
          { entityId: entityId1, extractionId: extractionId1, matchConfidence: 0.9 },
          { entityId: entityId1, extractionId: extractionId2, matchConfidence: 0.75 },
          { entityId: entityId2, extractionId: extractionId3, matchConfidence: 0.85 },
        ];
        const count = await entitySourceRepo.upsertBatchSources(batch);
        expect(count).toBe(3);
      });

      it('updates matchConfidence on conflict (same entityId + extractionId)', async () => {
        const batch = [{ entityId: entityId1, extractionId: extractionId1, matchConfidence: 0.99 }];
        const count = await entitySourceRepo.upsertBatchSources(batch);
        expect(count).toBe(1); // processed 1 item
      });

      it('handles batch where all entries already exist', async () => {
        const batch = [
          { entityId: entityId1, extractionId: extractionId1, matchConfidence: 0.5 },
          { entityId: entityId1, extractionId: extractionId2, matchConfidence: 0.6 },
        ];
        const count = await entitySourceRepo.upsertBatchSources(batch);
        expect(count).toBe(2);
      });
    });

    describe('deleteByExtractionIds', () => {
      it('returns 0 for empty array', async () => {
        const count = await entitySourceRepo.deleteByExtractionIds([]);
        expect(count).toBe(0);
      });

      it('deletes records matching extractionId and returns count', async () => {
        // extractionId3 → linked to entityId2
        const count = await entitySourceRepo.deleteByExtractionIds([extractionId3]);
        expect(count).toBe(1);
      });

      it('deletes across multiple extractionIds', async () => {
        // extractionId1 and extractionId2 are still linked to entityId1
        const count = await entitySourceRepo.deleteByExtractionIds([extractionId1, extractionId2]);
        expect(count).toBe(2);
      });

      it('returns 0 when no records match', async () => {
        const count = await entitySourceRepo.deleteByExtractionIds(['nonexistent-extraction']);
        expect(count).toBe(0);
      });
    });
  });
});
