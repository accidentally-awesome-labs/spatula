import { newId } from '@spatula/core';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { seedDataset, T } from '../test/seed';
import { getDataset } from './datasets';
import { commitSnapshot, getSnapshot, latestSnapshot, type SnapshotRow } from './snapshots';

describe('snapshots', () => {
  it('moves the head generation by compare-and-set, one generation at a time', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const row = (generation: number): SnapshotRow => {
        const id = newId('sn');
        return {
          id,
          datasetId: 'test-products',
          generation,
          runId,
          recordCount: 2,
          recordsSha256: `records-${generation}`,
          key: `datasets/test-products/snapshots/${id}.json`,
          sha256: `file-${generation}`,
          bytes: 1234,
          publishedAt: T(generation).toISOString(),
          report: { excluded: [{ canonicalId: 'sp_x', missing: ['name'] }] },
        };
      };

      expect(await commitSnapshot(db, row(1))).toEqual({ committed: true });
      // Another publisher already took generation 1, and generation 3 skips one.
      expect(await commitSnapshot(db, row(1))).toEqual({ committed: false, headGeneration: 1 });
      expect(await commitSnapshot(db, row(3))).toEqual({ committed: false, headGeneration: 1 });
      expect(await commitSnapshot(db, row(2))).toEqual({ committed: true });

      expect(await getDataset(db, 'test-products')).toMatchObject({ headGeneration: 2 });
      expect(await latestSnapshot(db, 'test-products')).toMatchObject({
        generation: 2,
        runId,
        recordsSha256: 'records-2',
        publishedAt: T(2).toISOString(),
        report: { excluded: [{ canonicalId: 'sp_x', missing: ['name'] }] },
      });
      expect(await getSnapshot(db, 'test-products', 1)).toMatchObject({
        generation: 1,
        sha256: 'file-1',
      });
      expect(await getSnapshot(db, 'test-products', 9)).toBeNull();
      expect(await latestSnapshot(db, 'no-such-dataset')).toBeNull();
    }));
});
