import { newId } from '@spatula/core';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { seedDataset, T } from '../test/seed';
import { applyDefinition, getDataset, StaleDefinitionError } from './datasets';
import { listOpenReviews } from './decisions';
import { testDefinition } from './fixtures';
import { startRun } from './runs';
import { datasets, runs, snapshots } from './schema';
import {
  commitSnapshot,
  discardHeld,
  getSnapshot,
  headGenerationOf,
  heldSnapshot,
  holdSnapshot,
  latestSnapshot,
  newerRunSnapshot,
  publishHeld,
  snapshotById,
  snapshotOfRun,
  supersedeHeld,
  type SnapshotRow,
} from './snapshots';

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
          revision: null,
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

  it('keeps the definition revision a snapshot came from, and none for one that names none', () =>
    withRollback(async (db) => {
      await seedDataset(db);
      const commit = (generation: number, revision?: number) =>
        commitSnapshot(db, {
          id: newId('sn'),
          datasetId: 'test-products',
          generation,
          runId: null,
          ...(revision === undefined ? {} : { revision }),
          recordCount: 1,
          recordsSha256: `records-${generation}`,
          key: `datasets/test-products/snapshots/${generation}.json`,
          sha256: `file-${generation}`,
          bytes: 10,
          publishedAt: T(generation).toISOString(),
          report: { excluded: [] },
        });
      await commit(1);
      expect((await getSnapshot(db, 'test-products', 1))?.revision).toBeNull();
      await commit(2, 7);
      expect((await getSnapshot(db, 'test-products', 2))?.revision).toBe(7);
    }));

  it('reads the head generation without reading the definition', () =>
    withRollback(async (db) => {
      await seedDataset(db);
      expect(await headGenerationOf(db, 'test-products')).toBe(0);
      await commitSnapshot(db, {
        id: newId('sn'),
        datasetId: 'test-products',
        generation: 1,
        runId: null,
        revision: 1,
        recordCount: 1,
        recordsSha256: 'records',
        key: 'datasets/test-products/snapshots/one.json',
        sha256: 'file',
        bytes: 10,
        publishedAt: T(1).toISOString(),
        report: { excluded: [] },
      });
      // A definition an earlier version stored, which no longer passes the checks, can't be read
      // by getDataset. It mustn't keep an owner from publishing what is held.
      await db
        .update(datasets)
        .set({ definition: { ...testDefinition(), consumers: ['Not A Slug'] } });
      await expect(getDataset(db, 'test-products')).rejects.toBeInstanceOf(StaleDefinitionError);
      expect(await headGenerationOf(db, 'test-products')).toBe(1);
      expect(await headGenerationOf(db, 'no-such-dataset')).toBe(0);
    }));
});

describe('held snapshots', () => {
  const held = (id: string, at: Date) => ({
    id,
    datasetId: 'test-products',
    runId: null,
    revision: 1,
    recordCount: 3,
    recordsSha256: `records-${id}`,
    key: `datasets/test-products/held/${id}.json`,
    sha256: `file-${id}`,
    bytes: 100,
    heldReason: 'it’s the dataset’s first publication',
    report: { excluded: [] },
    at,
    review: {
      id: `rv_${id}`,
      question: {
        type: 'choice' as const,
        prompt: 'Publish this held snapshot?',
        options: ['publish', 'discard'],
      },
      context: { snapshotId: id },
    },
  });

  it('wait with no generation, one at a time, and publish compared and set', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      await holdSnapshot(tx, held('sn_one', T(1)));
      await holdSnapshot(tx, held('sn_two', T(2)));
      // The newer one supersedes the older, whose question is dismissed.
      expect((await snapshotById(tx, 'sn_one'))?.state).toBe('superseded');
      expect((await heldSnapshot(tx, 'test-products'))?.id).toBe('sn_two');
      expect((await listOpenReviews(tx, 'test-products')).map((review) => review.subject)).toEqual([
        'sn_two',
      ]);
      expect(await latestSnapshot(tx, 'test-products')).toBeNull();

      const publishing = {
        datasetId: 'test-products',
        key: 'datasets/test-products/snapshots/sn_two.json',
        sha256: 'final',
        bytes: 120,
        publishedAt: T(3).toISOString(),
      };
      expect(await publishHeld(tx, { ...publishing, snapshotId: 'sn_one', generation: 1 })).toEqual(
        {
          stale: 'superseded',
        },
      );
      // A generation that isn't the head's next is refused, and the head named.
      expect(await publishHeld(tx, { ...publishing, snapshotId: 'sn_two', generation: 2 })).toEqual(
        {
          committed: false,
          headGeneration: 0,
        },
      );
      expect(await publishHeld(tx, { ...publishing, snapshotId: 'sn_two', generation: 1 })).toEqual(
        {
          committed: true,
        },
      );
      expect(await latestSnapshot(tx, 'test-products')).toMatchObject({
        id: 'sn_two',
        generation: 1,
        revision: 1,
        key: publishing.key,
      });
      expect(await heldSnapshot(tx, 'test-products')).toBeNull();
      // Publishing answered the question about it.
      expect(await listOpenReviews(tx, 'test-products')).toEqual([]);
      expect(await publishHeld(tx, { ...publishing, snapshotId: 'sn_two', generation: 2 })).toEqual(
        {
          stale: 'published',
        },
      );
    }));

  it('are superseded by a run that publishes, and can be discarded once', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      await holdSnapshot(tx, held('sn_held', T(1)));
      expect(await discardHeld(tx, { snapshotId: 'sn_held', at: T(2) })).toBe(true);
      expect(await discardHeld(tx, { snapshotId: 'sn_held', at: T(2) })).toBe(false);
      expect((await snapshotById(tx, 'sn_held'))?.state).toBe('discarded');
      expect(await listOpenReviews(tx, 'test-products')).toEqual([]);

      await holdSnapshot(tx, held('sn_later', T(3)));
      expect(await supersedeHeld(tx, { datasetId: 'test-products', at: T(4) })).toBe(1);
      expect((await snapshotById(tx, 'sn_later'))?.state).toBe('superseded');

      await holdSnapshot(tx, held('sn_again', T(5)));
      await commitSnapshot(tx, {
        id: 'sn_direct',
        datasetId: 'test-products',
        generation: 1,
        runId: null,
        revision: 1,
        recordCount: 3,
        recordsSha256: 'direct',
        key: 'datasets/test-products/snapshots/sn_direct.json',
        sha256: 'direct',
        bytes: 100,
        publishedAt: T(6).toISOString(),
        report: { excluded: [] },
      });
      expect((await snapshotById(tx, 'sn_again'))?.state).toBe('superseded');
      expect(await listOpenReviews(tx, 'test-products')).toEqual([]);
    }));

  it('stay held when they are held again, and an older hold run again supersedes nothing', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      await holdSnapshot(tx, held('sn_old', T(1)));
      // The same step, run twice: the snapshot is held once, with one question.
      await holdSnapshot(tx, held('sn_old', T(1)));
      expect((await snapshotById(tx, 'sn_old'))?.state).toBe('held');
      expect((await listOpenReviews(tx, 'test-products')).map((review) => review.subject)).toEqual([
        'sn_old',
      ]);

      await holdSnapshot(tx, held('sn_new', T(2)));
      expect((await snapshotById(tx, 'sn_old'))?.state).toBe('superseded');

      // The older run's step runs again after the newer run held its snapshot. It finds its row
      // already there, so it supersedes nothing, and doesn't ask its question again.
      await holdSnapshot(tx, held('sn_old', T(1)));
      expect((await snapshotById(tx, 'sn_old'))?.state).toBe('superseded');
      expect((await snapshotById(tx, 'sn_new'))?.state).toBe('held');
      expect((await heldSnapshot(tx, 'test-products'))?.id).toBe('sn_new');
      expect((await listOpenReviews(tx, 'test-products')).map((review) => review.subject)).toEqual([
        'sn_new',
      ]);
    }));

  it('are found by the run that made them, whatever became of them', () =>
    withRollback(async (tx) => {
      const { runId } = await seedDataset(tx);
      expect(await snapshotOfRun(tx, runId)).toBeNull();
      await holdSnapshot(tx, { ...held('sn_run', T(1)), runId });
      expect(await snapshotOfRun(tx, runId)).toMatchObject({
        id: 'sn_run',
        state: 'held',
        generation: null,
        publishedAt: null,
        revision: 1,
        heldReason: 'it’s the dataset’s first publication',
        createdAt: T(1).toISOString(),
      });
      await discardHeld(tx, { snapshotId: 'sn_run', at: T(2) });
      expect((await snapshotOfRun(tx, runId))?.state).toBe('discarded');
    }));

  it('are published only by the dataset they belong to', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      await holdSnapshot(tx, held('sn_theirs', T(1)));
      const publishing = {
        key: 'datasets/other/snapshots/sn_theirs.json',
        sha256: 'final',
        bytes: 120,
        publishedAt: T(2).toISOString(),
        generation: 1,
      };
      expect(
        await publishHeld(tx, { ...publishing, datasetId: 'other', snapshotId: 'sn_theirs' }),
      ).toEqual({ stale: 'missing' });
      expect(
        await publishHeld(tx, { ...publishing, datasetId: 'test-products', snapshotId: 'sn_none' }),
      ).toEqual({ stale: 'missing' });
      expect((await snapshotById(tx, 'sn_theirs'))?.state).toBe('held');
    }));

  it('are superseded only in their own dataset', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      await applyDefinition(tx, testDefinition('other-products'));
      await holdSnapshot(tx, held('sn_here', T(1)));
      await holdSnapshot(tx, { ...held('sn_there', T(2)), datasetId: 'other-products' });
      // Each dataset holds a snapshot of its own: the second hold superseded nothing of the first's.
      expect((await heldSnapshot(tx, 'test-products'))?.id).toBe('sn_here');
      expect((await heldSnapshot(tx, 'other-products'))?.id).toBe('sn_there');

      expect(await supersedeHeld(tx, { datasetId: 'test-products', at: T(3) })).toBe(1);
      expect((await snapshotById(tx, 'sn_there'))?.state).toBe('held');
      expect((await listOpenReviews(tx, 'other-products')).map((review) => review.subject)).toEqual(
        ['sn_there'],
      );
      await commitSnapshot(tx, {
        id: 'sn_direct',
        datasetId: 'test-products',
        generation: 1,
        runId: null,
        revision: 1,
        recordCount: 3,
        recordsSha256: 'direct',
        key: 'datasets/test-products/snapshots/sn_direct.json',
        sha256: 'direct',
        bytes: 100,
        publishedAt: T(4).toISOString(),
        report: { excluded: [] },
      });
      expect((await snapshotById(tx, 'sn_there'))?.state).toBe('held');
    }));

  it('stay held when their question can’t be closed, whether they are published or discarded', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      await holdSnapshot(tx, held('sn_atomic', T(1)));
      // Closing the question comes last. It fails, as if the database went away.
      await tx.execute(
        sql`create function refuse_closing() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$`,
      );
      await tx.execute(
        sql`create trigger refuse_closing before update on review_items for each row when (new.status <> 'open') execute function refuse_closing()`,
      );
      await expect(
        publishHeld(tx, {
          datasetId: 'test-products',
          snapshotId: 'sn_atomic',
          generation: 1,
          key: 'datasets/test-products/snapshots/sn_atomic.json',
          sha256: 'final',
          bytes: 120,
          publishedAt: T(2).toISOString(),
        }),
      ).rejects.toThrow();
      await expect(discardHeld(tx, { snapshotId: 'sn_atomic', at: T(2) })).rejects.toThrow();
      // Neither went through without the other: the snapshot is as it was, and so is the head.
      expect(await snapshotById(tx, 'sn_atomic')).toMatchObject({
        state: 'held',
        generation: null,
      });
      expect(await headGenerationOf(tx, 'test-products')).toBe(0);
      expect((await listOpenReviews(tx, 'test-products')).map((review) => review.subject)).toEqual([
        'sn_atomic',
      ]);
    }));
});

describe('newerRunSnapshot', () => {
  /** A snapshot that `runId` held in a dataset, with its question. */
  const heldBy = (id: string, runId: string | null, datasetId = 'test-products') => ({
    id,
    datasetId,
    runId,
    revision: 1,
    recordCount: 3,
    recordsSha256: `records-${id}`,
    key: `datasets/${datasetId}/held/${id}.json`,
    sha256: `file-${id}`,
    bytes: 100,
    heldReason: 'it’s the dataset’s first publication',
    report: { excluded: [] },
    at: T(10),
    review: {
      id: `rv_${id}`,
      question: {
        type: 'choice' as const,
        prompt: 'Publish this held snapshot?',
        options: ['publish', 'discard'],
      },
      context: { snapshotId: id },
    },
  });

  it('names the snapshot, in any state, of the newest run that started after a run', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      await applyDefinition(tx, testDefinition('other-products'));
      const runAt = async (id: string, at: Date, datasetId = 'test-products') => {
        await startRun(tx, { id, datasetId });
        await tx.update(runs).set({ startedAt: at }).where(eq(runs.id, id));
      };
      // Their IDs sort the other way from when they started, so only start times can tell.
      await runAt('test-products-c', T(1));
      await runAt('test-products-b', T(2));
      await runAt('test-products-a', T(3));
      const newerThan = (runId: string) =>
        newerRunSnapshot(tx, { datasetId: 'test-products', runId });
      expect(await newerThan('test-products-c')).toBeNull();

      // b's snapshot was discarded, and b still started after c.
      await holdSnapshot(tx, heldBy('sn_b', 'test-products-b'));
      await discardHeld(tx, { snapshotId: 'sn_b', at: T(11) });
      expect(await newerThan('test-products-c')).toEqual({
        runId: 'test-products-b',
        snapshotId: 'sn_b',
      });
      // A run's own snapshot isn't newer than it, and neither is an older run's.
      expect(await newerThan('test-products-b')).toBeNull();
      expect(await newerThan('test-products-a')).toBeNull();

      // A snapshot with no run, as slice 0's can be, says nothing of which run is newer, and
      // another dataset's runs aren't this one's.
      await holdSnapshot(tx, heldBy('sn_none', null));
      await runAt('other-products-z', T(9), 'other-products');
      await holdSnapshot(tx, heldBy('sn_other', 'other-products-z', 'other-products'));
      expect(await newerThan('test-products-a')).toBeNull();

      // Of several, the newest run's, published or held.
      await commitSnapshot(tx, {
        id: 'sn_a',
        datasetId: 'test-products',
        generation: 1,
        runId: 'test-products-a',
        revision: 1,
        recordCount: 3,
        recordsSha256: 'records-a',
        key: 'datasets/test-products/snapshots/sn_a.json',
        sha256: 'file-a',
        bytes: 100,
        publishedAt: T(12).toISOString(),
        report: { excluded: [] },
      });
      for (const older of ['test-products-c', 'test-products-b']) {
        expect(await newerThan(older), older).toEqual({
          runId: 'test-products-a',
          snapshotId: 'sn_a',
        });
      }
    }));
});

describe('the snapshots table', () => {
  it('gives a snapshot a generation and a publication time exactly when it is published', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      const insert = (values: Partial<typeof snapshots.$inferInsert>) =>
        // A savepoint, so a refused row doesn't end the test's transaction.
        tx.transaction((inner) =>
          inner.insert(snapshots).values({
            id: newId('sn'),
            datasetId: 'test-products',
            recordCount: 1,
            recordsSha256: 'records',
            key: 'key',
            sha256: 'file',
            bytes: 1,
            report: { excluded: [] },
            ...values,
          }),
        );
      const refused = { cause: { constraint_name: 'snapshots_published' } };
      // Held, superseded, and discarded snapshots have neither.
      await expect(insert({ state: 'held', generation: 1 })).rejects.toMatchObject(refused);
      await expect(insert({ state: 'held', publishedAt: T(1) })).rejects.toMatchObject(refused);
      await expect(
        insert({ state: 'superseded', generation: 1, publishedAt: T(1) }),
      ).rejects.toMatchObject(refused);
      await expect(insert({ state: 'discarded', generation: 1 })).rejects.toMatchObject(refused);
      // A published one has both.
      await expect(insert({ state: 'published' })).rejects.toMatchObject(refused);
      await expect(insert({ state: 'published', generation: 1 })).rejects.toMatchObject(refused);
      await expect(insert({ state: 'published', publishedAt: T(1) })).rejects.toMatchObject(
        refused,
      );
      await insert({ state: 'held' });
      await insert({ state: 'superseded' });
      await insert({ state: 'discarded' });
      await insert({ state: 'published', generation: 1, publishedAt: T(1) });
    }));
});
