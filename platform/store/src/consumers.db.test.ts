import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { seedDataset, T } from '../test/seed';
import { latestAcknowledgments, recordAcknowledgment } from './consumers';
import { applyDefinition } from './datasets';
import { closeReview, countOpenReviews, dismissReviews, openReview } from './decisions';
import { testDefinition } from './fixtures';
import { acknowledgments } from './schema';
import { commitSnapshot } from './snapshots';

const published = (id: string, generation: number) => ({
  id,
  datasetId: 'test-products',
  generation,
  runId: null,
  recordCount: 3,
  recordsSha256: id,
  key: `datasets/test-products/snapshots/${id}.json`,
  sha256: id,
  bytes: 100,
  publishedAt: T(generation).toISOString(),
  report: { excluded: [] },
});

const ack = (generation: number, snapshotId: string, bodySha256: string) => ({
  datasetId: 'test-products',
  consumer: 'crowdio',
  generation,
  snapshotId,
  outcome: 'applied' as const,
  detail: null,
  counts: { linked: 3 },
  sentAt: T(generation),
  receivedAt: T(generation),
  bodySha256,
});

describe('acknowledgments', () => {
  it('are kept once per consumer and generation, and the same body again is a repeat', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      await commitSnapshot(tx, published('sn_one', 1));
      await commitSnapshot(tx, published('sn_two', 2));
      expect(await recordAcknowledgment(tx, ack(1, 'sn_one', 'body-1'))).toBe('recorded');
      expect(await recordAcknowledgment(tx, ack(1, 'sn_one', 'body-1'))).toBe('repeated');
      expect(await recordAcknowledgment(tx, ack(1, 'sn_one', 'body-other'))).toBe('conflict');
      expect(await recordAcknowledgment(tx, ack(2, 'sn_two', 'body-2'))).toBe('recorded');
      expect(await latestAcknowledgments(tx, 'test-products')).toEqual([
        { consumer: 'crowdio', generation: 2, outcome: 'applied', receivedAt: T(2).toISOString() },
      ]);
    }));
});

describe('acknowledgments, beyond the first', () => {
  it('keep what the consumer said, and when it said it and when Spatula heard', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      await commitSnapshot(tx, published('sn_one', 1));
      await recordAcknowledgment(tx, {
        ...ack(1, 'sn_one', 'body-1'),
        outcome: 'refused',
        detail: 'two records had no brand',
        counts: { linked: 3, skipped: 2 },
        sentAt: T(5),
        receivedAt: T(6),
      });
      const [kept] = await tx.select().from(acknowledgments);
      expect(kept).toMatchObject({
        datasetId: 'test-products',
        consumer: 'crowdio',
        generation: 1,
        snapshotId: 'sn_one',
        outcome: 'refused',
        detail: 'two records had no brand',
        counts: { linked: 3, skipped: 2 },
        sentAt: T(5),
        receivedAt: T(6),
        bodySha256: 'body-1',
      });
    }));

  it('are kept apart for each consumer: one’s repeat is its own, whatever another said', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      await commitSnapshot(tx, published('sn_one', 1));
      const other = { ...ack(1, 'sn_one', 'body-of-other'), consumer: 'other' };
      expect(await recordAcknowledgment(tx, ack(1, 'sn_one', 'body-1'))).toBe('recorded');
      // Another consumer saying something else about the same generation is not a conflict.
      expect(await recordAcknowledgment(tx, other)).toBe('recorded');
      // And each one's own repeat and change are judged against its own body.
      expect(await recordAcknowledgment(tx, ack(1, 'sn_one', 'body-1'))).toBe('repeated');
      expect(await recordAcknowledgment(tx, other)).toBe('repeated');
      expect(await recordAcknowledgment(tx, { ...other, bodySha256: 'changed' })).toBe('conflict');
      expect(
        await tx
          .select({ id: acknowledgments.id })
          .from(acknowledgments)
          .where(eq(acknowledgments.generation, 1)),
      ).toHaveLength(2);
      expect(await latestAcknowledgments(tx, 'test-products')).toEqual([
        { consumer: 'crowdio', generation: 1, outcome: 'applied', receivedAt: T(1).toISOString() },
        { consumer: 'other', generation: 1, outcome: 'applied', receivedAt: T(1).toISOString() },
      ]);
    }));
});

describe('acknowledgments of more than one dataset', () => {
  it('are kept apart for each dataset: a repeat, a change, and the latest are its own', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      await applyDefinition(tx, testDefinition('test-other'));
      const publishedIn = (id: string, generation: number) => ({
        ...published(id, generation),
        datasetId: 'test-other',
        key: `datasets/test-other/snapshots/${id}.json`,
      });
      const inOther = (generation: number, snapshotId: string, bodySha256: string) => ({
        ...ack(generation, snapshotId, bodySha256),
        datasetId: 'test-other',
      });
      await commitSnapshot(tx, published('sn_one', 1));
      await commitSnapshot(tx, publishedIn('sn_other_one', 1));
      await commitSnapshot(tx, publishedIn('sn_other_two', 2));
      expect(await recordAcknowledgment(tx, ack(1, 'sn_one', 'body-here'))).toBe('recorded');
      expect(await recordAcknowledgment(tx, inOther(1, 'sn_other_one', 'body-there'))).toBe(
        'recorded',
      );
      expect(await recordAcknowledgment(tx, inOther(2, 'sn_other_two', 'body-later'))).toBe(
        'recorded',
      );
      // The same consumer and generation in two datasets: each is judged by its own dataset's.
      expect(await recordAcknowledgment(tx, ack(1, 'sn_one', 'body-here'))).toBe('repeated');
      expect(await recordAcknowledgment(tx, inOther(1, 'sn_other_one', 'body-there'))).toBe(
        'repeated',
      );
      expect(await recordAcknowledgment(tx, inOther(1, 'sn_other_one', 'body-here'))).toBe(
        'conflict',
      );
      expect(await latestAcknowledgments(tx, 'test-products')).toEqual([
        { consumer: 'crowdio', generation: 1, outcome: 'applied', receivedAt: T(1).toISOString() },
      ]);
      expect(await latestAcknowledgments(tx, 'test-other')).toEqual([
        { consumer: 'crowdio', generation: 2, outcome: 'applied', receivedAt: T(2).toISOString() },
      ]);
    }));
});

describe('countOpenReviews', () => {
  it('counts the open questions of each kind', () =>
    withRollback(async (tx) => {
      const {
        items: [a1, a2],
      } = await seedDataset(tx);
      const question = { type: 'choice' as const, prompt: 'Which?', options: ['a', 'b'] };
      for (const item of [a1!, a2!]) {
        await openReview(tx, {
          id: `rv_${item.id}`,
          datasetId: 'test-products',
          kind: 'classify',
          subject: item.id,
          question,
          context: {},
          at: T(1),
        });
      }
      expect(await countOpenReviews(tx, 'test-products')).toEqual({
        classify: 2,
        match: 0,
        publication: 0,
      });
    }));
});

describe('countOpenReviews, beyond the open ones', () => {
  it('counts each kind, and leaves out answered and dismissed questions and another dataset’s', () =>
    withRollback(async (tx) => {
      const {
        items: [a1, a2, b1],
      } = await seedDataset(tx);
      const question = { type: 'choice' as const, prompt: 'Which?', options: ['a', 'b'] };
      const ask = (datasetId: string, id: string, kind: 'classify' | 'match' | 'publication') =>
        openReview(tx, {
          id: `rv_${id}`,
          datasetId,
          kind,
          subject: id,
          question,
          context: {},
          at: T(1),
        });
      await ask('test-products', a1!.id, 'classify');
      await ask('test-products', a2!.id, 'classify');
      await ask('test-products', b1!.id, 'classify');
      await ask('test-products', 'it_x|sp_y', 'match');
      await ask('test-products', 'sn_z', 'publication');
      await ask('test-products', 'sn_w', 'publication');
      // One of the classifications is answered, and one publication question is dismissed.
      await closeReview(tx, { id: `rv_${a1!.id}`, status: 'decided', answer: 'a', at: T(2) });
      await dismissReviews(tx, {
        datasetId: 'test-products',
        kind: 'publication',
        subject: 'sn_w',
        at: T(2),
      });
      // Another dataset's open questions are its own.
      await applyDefinition(tx, testDefinition('test-other'));
      await ask('test-other', 'it_other', 'classify');
      await ask('test-other', 'sn_other', 'publication');

      expect(await countOpenReviews(tx, 'test-products')).toEqual({
        classify: 2,
        match: 1,
        publication: 1,
      });
      expect(await countOpenReviews(tx, 'test-other')).toEqual({
        classify: 1,
        match: 0,
        publication: 1,
      });
      expect(await countOpenReviews(tx, 'test-nothing')).toEqual({
        classify: 0,
        match: 0,
        publication: 0,
      });
    }));
});
