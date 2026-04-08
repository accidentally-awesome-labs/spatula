import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteEntityRepository,
  RunRepository,
  sqliteSchema,
  createProjectDb,
  initializeProjectDb,
} from '@spatula/db';
import type { ProjectDbResult } from '@spatula/db';

const { runs } = sqliteSchema;

const projectId = 'test-project';

function createTestDb(): ProjectDbResult {
  const result = createProjectDb(':memory:');
  initializeProjectDb(result.db, { projectId, name: 'Test Project' });
  return result;
}

describe('SqliteEntityRepository pull extensions', () => {
  let dbResult: ProjectDbResult;
  let repo: SqliteEntityRepository;

  beforeEach(() => {
    dbResult = createTestDb();
    repo = new SqliteEntityRepository(dbResult.db, projectId);
  });

  afterEach(() => {
    dbResult.close();
  });

  describe('upsertBatch', () => {
    it('inserts new entities', async () => {
      const result = await repo.upsertBatch([
        {
          id: 'ent-1',
          mergedData: { name: 'Entity 1' },
          provenance: {},
          qualityScore: 0.9,
          categories: ['product'],
          runId: 'run-1',
        },
        {
          id: 'ent-2',
          mergedData: { name: 'Entity 2' },
          provenance: {},
          qualityScore: 0.8,
          categories: [],
          runId: 'run-1',
        },
      ]);
      expect(result.inserted).toBe(2);
      expect(result.updated).toBe(0);
      expect(await repo.countByJob(projectId, '')).toBe(2);
    });

    it('updates existing entities on conflict', async () => {
      await repo.upsertBatch([{
        id: 'ent-1',
        mergedData: { name: 'Original' },
        provenance: {},
        qualityScore: 0.5,
        categories: [],
        runId: 'run-1',
      }]);

      const result = await repo.upsertBatch([{
        id: 'ent-1',
        mergedData: { name: 'Updated' },
        provenance: { name: { finalValue: 'Updated' } },
        qualityScore: 0.9,
        categories: ['product'],
        runId: 'run-2',
      }]);
      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(1);

      const rows = await repo.findByJob(projectId, '', { limit: 10, offset: 0 });
      expect((rows[0] as { mergedData: { name: string } }).mergedData.name).toBe('Updated');
    });

    it('handles empty batch', async () => {
      const result = await repo.upsertBatch([]);
      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(0);
    });

    it('duplicate IDs in same batch: second overwrites first, counts correctly', async () => {
      const result = await repo.upsertBatch([
        {
          id: 'ent-dup',
          mergedData: { name: 'First' },
          provenance: {},
          qualityScore: 0.5,
          categories: [],
          runId: 'run-1',
        },
        {
          id: 'ent-dup',
          mergedData: { name: 'Second' },
          provenance: {},
          qualityScore: 0.9,
          categories: ['product'],
          runId: 'run-2',
        },
      ]);
      // First is a new insert, second is an update (conflict on same id)
      expect(result.inserted).toBe(1);
      expect(result.updated).toBe(1);
      // Only one entity should exist in DB
      expect(await repo.countByJob(projectId, '')).toBe(1);
      // The second value wins
      const rows = await repo.findByJob(projectId, '', { limit: 10, offset: 0 });
      expect((rows[0] as { mergedData: { name: string } }).mergedData.name).toBe('Second');
    });

    it('null runId is stored correctly', async () => {
      const result = await repo.upsertBatch([
        {
          id: 'ent-null-run',
          mergedData: { name: 'No Run' },
          provenance: {},
          qualityScore: 0.7,
          categories: [],
          runId: null,
        },
      ]);
      expect(result.inserted).toBe(1);
      expect(await repo.countByJob(projectId, '')).toBe(1);
    });
  });

  describe('deleteByRunIds', () => {
    it('deletes entities matching the given run IDs', async () => {
      await repo.upsertBatch([
        { id: 'e1', mergedData: {}, provenance: {}, qualityScore: 0, categories: [], runId: 'run-a' },
        { id: 'e2', mergedData: {}, provenance: {}, qualityScore: 0, categories: [], runId: 'run-a' },
        { id: 'e3', mergedData: {}, provenance: {}, qualityScore: 0, categories: [], runId: 'run-b' },
      ]);
      const deleted = await repo.deleteByRunIds(['run-a']);
      expect(deleted).toBe(2);
      expect(await repo.countByJob(projectId, '')).toBe(1);
    });

    it('returns 0 for empty array', async () => {
      const deleted = await repo.deleteByRunIds([]);
      expect(deleted).toBe(0);
    });

    it('non-existent run IDs return 0', async () => {
      await repo.upsertBatch([
        { id: 'e1', mergedData: {}, provenance: {}, qualityScore: 0, categories: [], runId: 'run-x' },
      ]);
      const deleted = await repo.deleteByRunIds(['run-nonexistent', 'run-also-nonexistent']);
      expect(deleted).toBe(0);
      expect(await repo.countByJob(projectId, '')).toBe(1);
    });
  });

  describe('countBySource', () => {
    it('counts entities by source filter', async () => {
      dbResult.db.insert(runs).values({
        id: 'run-local',
        status: 'completed',
        source: 'local',
        configSnapshot: {},
        startedAt: new Date().toISOString(),
      }).run();
      dbResult.db.insert(runs).values({
        id: 'run-remote',
        status: 'pulled',
        source: 'remote:prod:job-1',
        configSnapshot: {},
        startedAt: new Date().toISOString(),
      }).run();
      await repo.upsertBatch([
        { id: 'e1', mergedData: {}, provenance: {}, qualityScore: 0, categories: [], runId: 'run-local' },
        { id: 'e2', mergedData: {}, provenance: {}, qualityScore: 0, categories: [], runId: 'run-remote' },
        { id: 'e3', mergedData: {}, provenance: {}, qualityScore: 0, categories: [], runId: null as unknown as string },
      ]);

      expect(await repo.countBySource('all')).toBe(3);
      expect(await repo.countBySource('local')).toBe(2);
      expect(await repo.countBySource('remote')).toBe(1);
    });
  });

  describe('findByJobFiltered', () => {
    beforeEach(() => {
      // Insert runs with different sources
      dbResult.db.insert(runs).values({
        id: 'run-local',
        status: 'completed',
        source: 'local',
        configSnapshot: {},
        startedAt: new Date().toISOString(),
      }).run();
      dbResult.db.insert(runs).values({
        id: 'run-remote',
        status: 'pulled',
        source: 'remote:prod:job-1',
        configSnapshot: {},
        startedAt: new Date().toISOString(),
      }).run();
    });

    it('filter local returns entities with null runId and local source', async () => {
      await repo.upsertBatch([
        { id: 'e-local', mergedData: { name: 'local-run' }, provenance: {}, qualityScore: 0.8, categories: [], runId: 'run-local' },
        { id: 'e-remote', mergedData: { name: 'remote-run' }, provenance: {}, qualityScore: 0.7, categories: [], runId: 'run-remote' },
        { id: 'e-null', mergedData: { name: 'no-run' }, provenance: {}, qualityScore: 0.6, categories: [], runId: null as unknown as string },
      ]);

      const result = await repo.findByJobFiltered(projectId, '', {
        limit: 10,
        offset: 0,
        sourceFilter: 'local',
      });

      const ids = (result as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain('e-local');
      expect(ids).toContain('e-null');
      expect(ids).not.toContain('e-remote');
    });

    it('filter remote returns only remote-sourced entities', async () => {
      await repo.upsertBatch([
        { id: 'e-local', mergedData: { name: 'local-run' }, provenance: {}, qualityScore: 0.8, categories: [], runId: 'run-local' },
        { id: 'e-remote', mergedData: { name: 'remote-run' }, provenance: {}, qualityScore: 0.7, categories: [], runId: 'run-remote' },
        { id: 'e-null', mergedData: { name: 'no-run' }, provenance: {}, qualityScore: 0.6, categories: [], runId: null as unknown as string },
      ]);

      const result = await repo.findByJobFiltered(projectId, '', {
        limit: 10,
        offset: 0,
        sourceFilter: 'remote',
      });

      const ids = (result as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain('e-remote');
      expect(ids).not.toContain('e-local');
      expect(ids).not.toContain('e-null');
    });

    it('filter all delegates to findByJob and returns all entities with pagination', async () => {
      await repo.upsertBatch([
        { id: 'e-local', mergedData: {}, provenance: {}, qualityScore: 0.8, categories: [], runId: 'run-local' },
        { id: 'e-remote', mergedData: {}, provenance: {}, qualityScore: 0.7, categories: [], runId: 'run-remote' },
      ]);

      const result = await repo.findByJobFiltered(projectId, '', {
        limit: 10,
        offset: 0,
        sourceFilter: 'all',
      });

      expect((result as Array<{ id: string }>).map((r) => r.id)).toHaveLength(2);
    });
  });

  describe('RunRepository findIdsBySourcePrefix', () => {
    let runRepo: RunRepository;

    beforeEach(() => {
      runRepo = new RunRepository(dbResult.db);
    });

    it('returns matching run IDs by source prefix', async () => {
      await runRepo.create({ status: 'pulled', source: 'remote:prod:job-1', configSnapshot: {}, startedAt: new Date().toISOString() });
      await runRepo.create({ status: 'pulled', source: 'remote:prod:job-2', configSnapshot: {}, startedAt: new Date().toISOString() });
      await runRepo.create({ status: 'completed', source: 'local', configSnapshot: {}, startedAt: new Date().toISOString() });

      const ids = await runRepo.findIdsBySourcePrefix('remote:prod:');
      expect(ids).toHaveLength(2);
      // All returned IDs should come from remote:prod: runs
      for (const id of ids) {
        const run = await runRepo.findById(id);
        expect(run?.source).toMatch(/^remote:prod:/);
      }
    });

    it('returns empty array when no runs match prefix', async () => {
      await runRepo.create({ status: 'completed', source: 'local', configSnapshot: {}, startedAt: new Date().toISOString() });

      const ids = await runRepo.findIdsBySourcePrefix('remote:staging:');
      expect(ids).toHaveLength(0);
    });
  });
});
