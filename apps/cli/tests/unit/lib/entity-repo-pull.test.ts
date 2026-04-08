import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteEntityRepository,
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
});
