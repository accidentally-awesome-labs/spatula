import { newId } from '@spatula/core';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { fetchOf, seedDataset, statementOf, T } from '../test/seed';
import {
  CAPTURE_KEEP_EARLIER,
  captureById,
  deleteCaptures,
  freedKeys,
  latestCapture,
  latestCaptures,
  prunableCaptures,
  purgeKeys,
  purgeSource,
  recordCapture,
  setCaptureRead,
  type NewCapture,
} from './captures';
import type { Executor } from './client';
import { applyDefinition, listLiveItems, type ItemRef } from './datasets';
import { testDefinition } from './fixtures';
import { startRun } from './runs';
import { items, statements } from './schema';
import { reseeStatements, writeStatements } from './statements';

const DAY = 24 * 60 * 60 * 1000;
const DATASET = 'test-products';

/** A capture of the item, fetched at T(minute), of a body with this hash, with its fetch logged. */
async function newCapture(
  db: Executor,
  runId: string,
  item: ItemRef,
  minute: number,
  contentHash: string,
  more: Partial<NewCapture> = {},
): Promise<NewCapture> {
  const fetchId = await fetchOf(db, runId, item, T(minute));
  return {
    id: newId('cp'),
    datasetId: DATASET,
    itemId: item.id,
    sourceId: item.sourceId,
    fetchId,
    url: item.locator,
    finalUrl: item.locator,
    httpStatus: 200,
    etag: null,
    lastModified: null,
    fetchedAt: T(minute),
    contentHash,
    bytes: 1000,
    storedBytes: 300,
    signals: {},
    ...more,
  };
}

const capture = async (...args: Parameters<typeof newCapture>) =>
  recordCapture(args[0], await newCapture(...args));

describe('recordCapture', () => {
  it('records a capture once, however often its step runs', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const input = await newCapture(db, runId, a1!, 0, 'body-0');
      const first = await recordCapture(db, input);
      expect(first).toEqual({ ...input, readKey: null, reader: null });
      // The same ID again, as a step that runs again sends it, keeps what the first time kept.
      expect(await recordCapture(db, { ...input, contentHash: 'other' })).toEqual(first);
      expect(await captureById(db, input.id)).toEqual(first);
      expect(await captureById(db, 'cp_none')).toBeNull();

      await setCaptureRead(db, {
        id: input.id,
        readKey: 'captures/test-products/x.json.gz',
        reader: 1,
      });
      expect(await captureById(db, input.id)).toMatchObject({
        readKey: 'captures/test-products/x.json.gz',
        reader: 1,
      });
    }));
});

describe('latestCapture', () => {
  it('finds each page’s latest capture', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2, b1],
        runId,
      } = await seedDataset(db);
      await capture(db, runId, a1!, 0, 'a1-0');
      const a1Latest = await capture(db, runId, a1!, 5, 'a1-5');
      const a2Only = await capture(db, runId, a2!, 1, 'a2-1');
      expect(await latestCapture(db, a1!.id)).toEqual(a1Latest);
      expect(await latestCapture(db, b1!.id)).toBeNull();

      const latest = await latestCaptures(db, [a1!.id, a2!.id, b1!.id]);
      expect([...latest.keys()].sort()).toEqual([a1!.id, a2!.id].sort());
      expect(latest.get(a1!.id)).toEqual(a1Latest);
      expect(latest.get(a2!.id)).toEqual(a2Only);
      expect(await latestCaptures(db, [])).toEqual(new Map());
    }));
});

describe('statements cite captures', () => {
  it('note the capture a value was first found in, keep it when it’s seen again, and let it go with the capture', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const first = await capture(db, runId, a1!, 0, 'a1-0');
      const base = { datasetId: DATASET, itemId: a1!.id, methods: ['jsonld'] as const };
      await writeStatements(db, {
        ...base,
        fetchId: first.fetchId,
        seenAt: T(0),
        captureId: first.id,
        statements: [statementOf('name', 'A1', 'jsonld')],
      });
      const second = await capture(db, runId, a1!, 5, 'a1-5');
      await writeStatements(db, {
        ...base,
        fetchId: second.fetchId,
        seenAt: T(5),
        captureId: second.id,
        statements: [statementOf('name', 'A1', 'jsonld'), statementOf('mpns', 'A1-100', 'jsonld')],
      });
      const cited = async () =>
        Object.fromEntries(
          (
            await db
              .select({ valueKey: statements.valueKey, captureId: statements.captureId })
              .from(statements)
              .where(eq(statements.itemId, a1!.id))
          ).map((row) => [row.valueKey, row.captureId]),
        );
      expect(await cited()).toEqual({ A1: first.id, 'A1-100': second.id });

      expect(await deleteCaptures(db, [first.id])).toBe(1);
      expect(await cited()).toEqual({ A1: null, 'A1-100': second.id });
      expect(await deleteCaptures(db, [])).toBe(0);
    }));

  it('give a value from before the archive the capture that sees it again', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const fetchId = await fetchOf(db, runId, a1!, T(0));
      const base = { datasetId: DATASET, itemId: a1!.id, methods: ['jsonld'] as const };
      await writeStatements(db, {
        ...base,
        fetchId,
        seenAt: T(0),
        statements: [statementOf('name', 'A1', 'jsonld'), statementOf('mpns', 'A1-100', 'jsonld')],
      });
      const later = await capture(db, runId, a1!, 5, 'a1-5');
      // Re-seen by an unchanged page: both take the capture.
      expect(
        await reseeStatements(db, {
          itemId: a1!.id,
          fetchId: later.fetchId,
          seenAt: T(5),
          captureId: later.id,
        }),
      ).toBe(2);
      // Re-seen by an extraction that names another capture: they keep the one they have.
      const third = await capture(db, runId, a1!, 9, 'a1-9');
      await writeStatements(db, {
        ...base,
        fetchId: third.fetchId,
        seenAt: T(9),
        captureId: third.id,
        statements: [statementOf('name', 'A1', 'jsonld'), statementOf('mpns', 'A1-100', 'jsonld')],
      });
      const rows = await db
        .select({ captureId: statements.captureId, lastSeen: statements.lastSeen })
        .from(statements)
        .where(eq(statements.itemId, a1!.id));
      expect(rows).toEqual([
        { captureId: later.id, lastSeen: T(9) },
        { captureId: later.id, lastSeen: T(9) },
      ]);
    }));
});

describe('prunableCaptures', () => {
  it('keeps a page’s latest capture, and the ten earlier ones of the last year', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      // Twelve differing captures a minute apart: the latest, and eleven earlier.
      const made = [];
      for (let minute = 0; minute < 12; minute += 1) {
        made.push(await capture(db, runId, a1!, minute, `a1-${minute}`));
      }
      expect(CAPTURE_KEEP_EARLIER).toBe(10);
      const prune = (now: Date, limit = 100) =>
        prunableCaptures(db, { datasetId: DATASET, now, limit });
      expect(await prune(T(60))).toEqual([made[0]!.id]);
      // A year on, every earlier capture is past its time, oldest first; the latest stays.
      const yearOn = new Date(T(11).getTime() + 366 * DAY);
      expect(await prune(yearOn)).toEqual(made.slice(0, 11).map((one) => one.id));
      expect(await prune(yearOn, 2)).toEqual([made[0]!.id, made[1]!.id]);
    }));

  it('lets an earlier copy of the latest body go, and keeps what a current statement cites', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
        runId,
      } = await seedDataset(db);
      // A1 went from x to y and back to x: its first x is a copy of the latest.
      const x0 = await capture(db, runId, a1!, 0, 'x');
      const y = await capture(db, runId, a1!, 1, 'y');
      await capture(db, runId, a1!, 2, 'x');
      expect(await prunableCaptures(db, { datasetId: DATASET, now: T(60), limit: 100 })).toEqual([
        x0.id,
      ]);

      // A2's first capture is more than a year old, but its name, still current, came from it.
      const old = await capture(db, runId, a2!, 0, 'a2-old');
      const gone = await capture(db, runId, a2!, 1, 'a2-mid');
      await capture(db, runId, a2!, 2, 'a2-new');
      const base = { datasetId: DATASET, itemId: a2!.id, methods: ['rule'] as const };
      await writeStatements(db, {
        ...base,
        properties: ['name'],
        fetchId: old.fetchId,
        seenAt: T(0),
        captureId: old.id,
        statements: [statementOf('name', 'A2')],
      });
      // A value since withdrawn cites its capture no longer.
      await writeStatements(db, {
        ...base,
        properties: ['mpns'],
        fetchId: gone.fetchId,
        seenAt: T(1),
        captureId: gone.id,
        statements: [statementOf('mpns', 'A2-1')],
      });
      await writeStatements(db, {
        ...base,
        properties: ['mpns'],
        fetchId: gone.fetchId,
        seenAt: T(2),
        statements: [],
      });
      const yearOn = new Date(T(2).getTime() + 366 * DAY);
      expect(
        new Set(await prunableCaptures(db, { datasetId: DATASET, now: yearOn, limit: 100 })),
      ).toEqual(new Set([x0.id, y.id, gone.id]));
    }));

  it('looks only at the dataset it’s asked about', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      await capture(db, runId, a1!, 0, 'a1-0');
      await capture(db, runId, a1!, 1, 'a1-0');
      expect(await prunableCaptures(db, { datasetId: 'another', now: T(60), limit: 100 })).toEqual(
        [],
      );
    }));
});

describe('freedKeys', () => {
  it('frees a body only when no other capture or page holds it, and every read', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
        runId,
      } = await seedDataset(db);
      const sharedOld = await capture(db, runId, a1!, 0, 'shared');
      const alone = await capture(db, runId, a1!, 1, 'alone');
      await capture(db, runId, a2!, 2, 'shared');
      const held = await capture(db, runId, a1!, 3, 'held');
      await capture(db, runId, a1!, 4, 'newest');
      await setCaptureRead(db, {
        id: alone.id,
        readKey: 'captures/test-products/alone.json.gz',
        reader: 1,
      });
      // A2's stored copy is the 'held' body, which keeps that file, as A2's capture keeps 'shared'.
      await db.update(items).set({ contentHash: 'held' }).where(eq(items.id, a2!.id));
      expect(await freedKeys(db, [sharedOld.id, alone.id, held.id])).toEqual({
        hashes: ['alone'],
        reads: ['captures/test-products/alone.json.gz'],
      });
      expect(await freedKeys(db, [])).toEqual({ hashes: [], reads: [] });
      // Nothing was deleted by asking.
      expect(
        await db
          .select({ id: items.id })
          .from(items)
          .where(and(eq(items.id, a2!.id), eq(items.contentHash, 'held'))),
      ).toHaveLength(1);
      expect(await captureById(db, alone.id)).not.toBeNull();
    }));

  it('keeps a body that a capture or a page of another dataset holds', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      await applyDefinition(db, testDefinition('another'));
      const otherRun = 'another-202610100000';
      await startRun(db, { id: otherRun, datasetId: 'another' });
      const [otherA1, otherA2] = await listLiveItems(db, 'another');
      const byCapture = await capture(db, runId, a1!, 0, 'held-by-capture');
      const byPage = await capture(db, runId, a1!, 1, 'held-by-page');
      const alone = await capture(db, runId, a1!, 2, 'alone');
      // The other dataset's capture holds one body, and its page's stored copy the other.
      await capture(db, otherRun, otherA2!, 3, 'held-by-capture', { datasetId: 'another' });
      await db.update(items).set({ contentHash: 'held-by-page' }).where(eq(items.id, otherA1!.id));

      expect(await freedKeys(db, [byCapture.id, byPage.id, alone.id])).toEqual({
        hashes: ['alone'],
        reads: [],
      });
    }));
});

describe('purging a source', () => {
  it('deletes a source’s captures and forgets its pages’ copies, and leaves the other source’s', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2, b1],
        runId,
      } = await seedDataset(db);
      // A1 and A2 are maker-a's, B1 maker-b's.
      const a1Capture = await capture(db, runId, a1!, 0, 'a1-body');
      await setCaptureRead(db, {
        id: a1Capture.id,
        readKey: 'captures/test-products/a1.json.gz',
        reader: 1,
      });
      await capture(db, runId, a2!, 1, 'shared');
      const b1Capture = await capture(db, runId, b1!, 2, 'shared');
      // B1, captured while it was maker-a's, before a definition moved it to maker-b (ADR 0006).
      await capture(db, runId, b1!, 3, 'moved-body', { sourceId: 'maker-a' });
      await db.update(items).set({ contentHash: 'a1-body' }).where(eq(items.id, a1!.id));
      await db
        .update(items)
        .set({ contentHash: 'a2-copy', etag: '"a2"', lastModified: 'Sat, 10 Oct 2026' })
        .where(eq(items.id, a2!.id));

      const source = { datasetId: DATASET, sourceId: 'maker-a' };
      // 'shared' stays: B1's capture holds it.
      expect(await purgeKeys(db, source)).toEqual({
        hashes: ['a1-body', 'a2-copy', 'moved-body'],
        reads: ['captures/test-products/a1.json.gz'],
      });
      expect(await purgeSource(db, source)).toEqual({ captures: 3, pages: 2 });
      expect(await latestCapture(db, b1!.id)).toEqual(b1Capture);
      expect(await latestCapture(db, a1!.id)).toBeNull();
      const [a2Now] = await db.select().from(items).where(eq(items.id, a2!.id));
      expect(a2Now).toMatchObject({ contentHash: null, etag: null, lastModified: null });
      // Again: nothing is left to purge.
      expect(await purgeKeys(db, source)).toEqual({ hashes: [], reads: [] });
      expect(await purgeSource(db, source)).toEqual({ captures: 0, pages: 0 });
    }));

  it('keeps a body that a page of another source holds', () =>
    withRollback(async (db) => {
      const {
        items: [a1, , b1],
        runId,
      } = await seedDataset(db);
      await capture(db, runId, a1!, 0, 'a1-body');
      // A1's stored copy is that body, and so is B1's, which maker-b's page holds without a capture.
      await db.update(items).set({ contentHash: 'a1-body' }).where(eq(items.id, a1!.id));
      await db.update(items).set({ contentHash: 'a1-body' }).where(eq(items.id, b1!.id));

      const source = { datasetId: DATASET, sourceId: 'maker-a' };
      expect(await purgeKeys(db, source)).toEqual({ hashes: [], reads: [] });
      // The purge still deletes A1's capture, and forgets A1's copy, not B1's.
      expect(await purgeSource(db, source)).toEqual({ captures: 1, pages: 1 });
      expect(await latestCapture(db, a1!.id)).toBeNull();
      const [b1Now] = await db.select().from(items).where(eq(items.id, b1!.id));
      expect(b1Now).toMatchObject({ contentHash: 'a1-body' });
    }));

  it('keeps a body that a page or a capture of another dataset holds', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      await applyDefinition(db, testDefinition('another'));
      const otherRun = 'another-202610100000';
      await startRun(db, { id: otherRun, datasetId: 'another' });
      const [otherA1, otherA2] = await listLiveItems(db, 'another');
      await capture(db, runId, a1!, 0, 'alone');
      await capture(db, runId, a1!, 1, 'held-by-page');
      await capture(db, runId, a1!, 2, 'held-by-capture');
      await db.update(items).set({ contentHash: 'alone' }).where(eq(items.id, a1!.id));
      // The other dataset's page holds one body, and its capture the other.
      await db.update(items).set({ contentHash: 'held-by-page' }).where(eq(items.id, otherA1!.id));
      const held = await capture(db, otherRun, otherA2!, 3, 'held-by-capture', {
        datasetId: 'another',
      });

      const source = { datasetId: DATASET, sourceId: 'maker-a' };
      expect(await purgeKeys(db, source)).toEqual({ hashes: ['alone'], reads: [] });
      expect(await purgeSource(db, source)).toEqual({ captures: 3, pages: 1 });
      // Nothing of the other dataset went.
      expect(await latestCapture(db, otherA2!.id)).toEqual(held);
      const [otherPage] = await db.select().from(items).where(eq(items.id, otherA1!.id));
      expect(otherPage).toMatchObject({ contentHash: 'held-by-page' });
    }));

  it('knows a source the dataset never had', () =>
    withRollback(async (db) => {
      await seedDataset(db);
      expect(await purgeKeys(db, { datasetId: DATASET, sourceId: 'maker-z' })).toBeNull();
    }));
});
