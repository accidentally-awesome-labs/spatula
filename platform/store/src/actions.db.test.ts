import type { ActorRecord } from '@spatula/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { seedDataset, T } from '../test/seed';
import { listActions, logAction } from './actions';
import type { Executor } from './client';
import { datasets } from './schema';

const OWNER: ActorRecord = { role: 'owner', client: 'console' };
const REVIEWER: ActorRecord = {
  role: 'reviewer',
  client: 'consumer',
  consumer: 'crowdio',
  reviewer: 'reviewer-7',
};

const logged = (db: Executor, subject: string, at: Date, actor = OWNER) =>
  logAction(db, {
    datasetId: 'test-products',
    action: 'answer',
    subject,
    actor,
    detail: { answer: subject },
    at,
  });

describe('the review log', () => {
  it('lists writes newest first, in pages that never split a moment', () =>
    withRollback(async (db) => {
      await seedDataset(db);
      await logged(db, 'rv_one', T(1));
      await logged(db, 'rv_two', T(2), REVIEWER);
      await logged(db, 'rv_three', T(3));
      await logged(db, 'rv_four', T(3));
      const subjects = async (options?: { limit?: number; before?: Date }) =>
        (await listActions(db, 'test-products', options)).map((action) => action.subject);
      const newest = await listActions(db, 'test-products');
      expect(newest.map((action) => action.subject).slice(2)).toEqual(['rv_two', 'rv_one']);
      expect(newest[2]).toEqual({
        id: expect.stringMatching(/^ra_/u),
        action: 'answer',
        subject: 'rv_two',
        actor: REVIEWER,
        detail: { answer: 'rv_two' },
        at: T(2).toISOString(),
      });
      // A page of one holds both writes made at T(3), so the next page, from before T(3), misses
      // none.
      expect((await subjects({ limit: 1 })).sort()).toEqual(['rv_four', 'rv_three']);
      expect(await subjects({ limit: 1, before: T(3) })).toEqual(['rv_two']);
      expect(await subjects({ before: T(2) })).toEqual(['rv_one']);
      expect(await listActions(db, 'another-dataset')).toEqual([]);
    }));

  it('goes with its dataset', () =>
    withRollback(async (db) => {
      await seedDataset(db);
      await logged(db, 'rv_one', T(1));
      await db.delete(datasets).where(eq(datasets.id, 'test-products'));
      expect(await listActions(db, 'test-products')).toEqual([]);
    }));
});
