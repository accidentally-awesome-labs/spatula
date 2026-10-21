import { eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { T } from '../test/seed';
import { recordCapture } from './captures';
import type { Executor } from './client';
import { applyDefinition, listLiveItems, reviveItems, type ItemRef } from './datasets';
import { recordFetch, setExtractedWith, setItemStatus } from './fetches';
import { testSitemapDefinition, testTaxonomyDefinition } from './fixtures';
import {
  dueItems,
  finishListing,
  itemsByIds,
  listPages,
  markForFetch,
  MISSING_GONE_AFTER,
  recordSitemapFetch,
  taxonomyItemsByIds,
  taxonomyPages,
} from './listing';
import { startRun } from './runs';
import { fetches, items } from './schema';
import { setTaxonomyKey } from './taxonomy';

const DATASET = 'test-sitemaps';
const RUN = 'test-sitemaps-202610100000';
const DAY = 24 * 60 * 60 * 1000;

const page = (n: number, lastmod: string | null = null) => ({
  locator: `https://maker-c.example/products/c${n}`,
  lastmod,
});

async function seed(tx: Executor) {
  await applyDefinition(tx, testSitemapDefinition());
  await startRun(tx, { id: RUN, datasetId: DATASET });
}

const list = (tx: Executor, listedAt: Date, pages: ReturnType<typeof page>[]) =>
  listPages(tx, {
    datasetId: DATASET,
    sourceId: 'maker-c',
    recordType: 'product',
    listedAt,
    pages,
  });

const finish = (tx: Executor, listedAt: Date) =>
  finishListing(tx, { datasetId: DATASET, sourceId: 'maker-c', listedAt });

/** The constraint a query broke, whether or not Drizzle wrapped the driver's error. */
async function brokenConstraint(query: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await query;
    return undefined;
  } catch (error) {
    const driverError = (error as { cause?: unknown }).cause ?? error;
    return (driverError as { constraint_name?: string }).constraint_name;
  }
}

const stateOf = async (tx: Executor, n: number) =>
  (
    await tx
      .select({ status: items.status, missingStreak: items.missingStreak })
      .from(items)
      .where(eq(items.locator, page(n).locator))
  )[0];

describe('listPages', () => {
  it('adds the pages a sitemap lists, once each, with the latest lastmod it gave', () =>
    withRollback(async (tx) => {
      await seed(tx);
      expect(await list(tx, T(1), [page(1, '2026-10-01T00:00:00.000Z'), page(2)])).toEqual({
        listed: 2,
        added: 2,
        revived: 0,
      });
      expect(await list(tx, T(2), [page(1, '2026-10-05T00:00:00.000Z'), page(2)])).toEqual({
        listed: 2,
        added: 0,
        revived: 0,
      });
      const [c1] = await tx
        .select({ listedAt: items.listedAt, listedLastmod: items.listedLastmod })
        .from(items)
        .where(eq(items.locator, page(1).locator));
      expect(c1).toEqual({ listedAt: T(2), listedLastmod: '2026-10-05T00:00:00.000Z' });
    }));

  it('leaves a page that went after 404s gone, even while its sitemap still lists it', () =>
    withRollback(async (tx) => {
      await seed(tx);
      await list(tx, T(1), [page(1)]);
      // As two 404s in a row leave it.
      await tx
        .update(items)
        .set({ status: 'gone' })
        .where(eq(items.locator, page(1).locator));
      expect(await list(tx, T(2), [page(1)])).toMatchObject({ revived: 0 });
      expect((await stateOf(tx, 1))!.status).toBe('gone');
    }));

  it('brings back a page that left the definition, but not one refused or irrelevant', () =>
    withRollback(async (tx) => {
      await seed(tx);
      await list(tx, T(1), [page(1), page(2), page(3)]);
      // As the source leaving the definition, three blocks in a row, and a "None of these" answer
      // leave them.
      for (const [n, status] of [
        [1, 'excluded'],
        [2, 'refused'],
        [3, 'irrelevant'],
      ] as const) {
        await tx
          .update(items)
          .set({ status })
          .where(eq(items.locator, page(n).locator));
      }
      expect(await list(tx, T(2), [page(1), page(2), page(3)])).toEqual({
        listed: 3,
        added: 0,
        revived: 1,
      });
      expect((await stateOf(tx, 1))!.status).toBe('live');
      expect((await stateOf(tx, 2))!.status).toBe('refused');
      expect((await stateOf(tx, 3))!.status).toBe('irrelevant');
    }));

  it('lists a page given twice once, with the latest lastmod it was given', () =>
    withRollback(async (tx) => {
      await seed(tx);
      // The later lastmod wins whichever comes first, and a date beats none.
      expect(
        await list(tx, T(1), [
          page(1, '2026-10-01T00:00:00.000Z'),
          page(2, '2026-10-07T00:00:00.000Z'),
          page(3),
          page(4, '2026-10-02T00:00:00.000Z'),
          page(1, '2026-10-05T00:00:00.000Z'),
          page(2, '2026-10-03T00:00:00.000Z'),
          page(3, '2026-10-02T00:00:00.000Z'),
          page(4),
        ]),
      ).toEqual({ listed: 4, added: 4, revived: 0 });
      const listed = await tx
        .select({ listedLastmod: items.listedLastmod })
        .from(items)
        .where(eq(items.sourceId, 'maker-c'))
        .orderBy(items.locator);
      expect(listed.map((row) => row.listedLastmod)).toEqual([
        '2026-10-05T00:00:00.000Z',
        '2026-10-07T00:00:00.000Z',
        '2026-10-02T00:00:00.000Z',
        '2026-10-02T00:00:00.000Z',
      ]);
    }));

  it('counts a page given again in a later batch of one call once', () =>
    withRollback(async (tx) => {
      await seed(tx);
      // Enough pages that the repeat is written by a later statement than the page it repeats.
      const pages = Array.from({ length: 1500 }, (_, n) => page(n));
      expect(await list(tx, T(1), [...pages, page(0, '2026-10-01T00:00:00.000Z')])).toEqual({
        listed: 1500,
        added: 1500,
        revived: 0,
      });
    }));

  it('leaves a page alone that a later read already listed, and still lists the rest', () =>
    withRollback(async (tx) => {
      await seed(tx);
      await list(tx, T(2), [page(1, '2026-10-05T00:00:00.000Z')]);
      // Three complete reads after it that leave it out.
      for (const minute of [3, 4, 5]) await finish(tx, T(minute));
      expect(await stateOf(tx, 1)).toEqual({ status: 'gone', missingStreak: MISSING_GONE_AFTER });
      // The oldest read's step lands last, as it can when two runs of a dataset overlap.
      expect(await list(tx, T(1), [page(1, '2026-10-01T00:00:00.000Z'), page(2)])).toEqual({
        listed: 1,
        added: 1,
        revived: 0,
      });
      const [c1] = await tx
        .select({
          listedAt: items.listedAt,
          listedLastmod: items.listedLastmod,
          status: items.status,
          missingStreak: items.missingStreak,
        })
        .from(items)
        .where(eq(items.locator, page(1).locator));
      expect(c1).toEqual({
        listedAt: T(2),
        listedLastmod: '2026-10-05T00:00:00.000Z',
        status: 'gone',
        missingStreak: MISSING_GONE_AFTER,
      });
    }));

  it('lets one read list a page again, as a step that runs again does', () =>
    withRollback(async (tx) => {
      await seed(tx);
      await list(tx, T(2), [page(1, '2026-10-01T00:00:00.000Z')]);
      expect(await list(tx, T(2), [page(1, '2026-10-05T00:00:00.000Z')])).toEqual({
        listed: 1,
        added: 0,
        revived: 0,
      });
      const [c1] = await tx
        .select({ listedLastmod: items.listedLastmod })
        .from(items)
        .where(eq(items.locator, page(1).locator));
      expect(c1).toEqual({ listedLastmod: '2026-10-05T00:00:00.000Z' });
    }));

  it('lists a page whose row has no listing time, as when its source changed from pages', () =>
    withRollback(async (tx) => {
      await seed(tx);
      await list(tx, T(1), [page(1)]);
      // As when the source was a pages source under the same ID: its items were never listed.
      await tx
        .update(items)
        .set({ listedAt: null })
        .where(eq(items.locator, page(1).locator));
      expect(await list(tx, T(2), [page(1)])).toEqual({ listed: 1, added: 0, revived: 0 });
      const [c1] = await tx
        .select({ listedAt: items.listedAt })
        .from(items)
        .where(eq(items.locator, page(1).locator));
      expect(c1).toEqual({ listedAt: T(2) });
    }));
});

describe('finishListing', () => {
  it('calls a page gone after three complete reads without it, and brings it back when it returns', () =>
    withRollback(async (tx) => {
      await seed(tx);
      await list(tx, T(1), [page(1), page(2)]);
      const counts = [];
      for (const minute of [2, 3, 4]) {
        await list(tx, T(minute), [page(1)]);
        counts.push(await finish(tx, T(minute)));
      }
      expect(counts).toEqual([
        { missing: 1, gone: 0 },
        { missing: 1, gone: 0 },
        { missing: 1, gone: 1 },
      ]);
      expect(await stateOf(tx, 2)).toEqual({ status: 'gone', missingStreak: MISSING_GONE_AFTER });
      expect(await stateOf(tx, 1)).toEqual({ status: 'live', missingStreak: 0 });
      expect(await list(tx, T(5), [page(1), page(2)])).toMatchObject({ revived: 1 });
      expect(await stateOf(tx, 2)).toEqual({ status: 'live', missingStreak: 0 });
    }));

  it('counts a read once, however often its step runs', () =>
    withRollback(async (tx) => {
      await seed(tx);
      await list(tx, T(1), [page(1), page(2)]);
      await list(tx, T(2), [page(1)]);
      expect(await finish(tx, T(2))).toEqual({ missing: 1, gone: 0 });
      expect(await finish(tx, T(2))).toEqual({ missing: 0, gone: 0 });
      expect((await stateOf(tx, 2))!.missingStreak).toBe(1);
    }));

  it('refuses a source with no sitemaps, whose pages would all count missing', () =>
    withRollback(async (tx) => {
      await seed(tx);
      await expect(
        finishListing(tx, { datasetId: DATASET, sourceId: 'maker-a', listedAt: T(1) }),
      ).rejects.toThrow('Source maker-a isn’t a sitemap source, so it has no listings to finish.');
      const [a1] = await tx
        .select({ status: items.status, missingStreak: items.missingStreak })
        .from(items)
        .where(eq(items.locator, 'https://maker-a.example/products/a1'));
      expect(a1).toEqual({ status: 'live', missingStreak: 0 });
    }));
});

describe('dueItems', () => {
  it('plans the pages that are due, taking turns between hosts', () =>
    withRollback(async (tx) => {
      await seed(tx);
      await list(tx, T(0), [page(1, '2026-10-01T00:00:00.000Z'), page(2), page(3)]);
      const live = await listLiveItems(tx, DATASET);
      const locatorOf = new Map(live.map((item) => [item.id, item.locator]));
      const idOf = (locator: string) => live.find((item) => item.locator === locator)!.id;
      const short = (ids: string[]) => ids.map((id) => locatorOf.get(id)!.split('/').pop());
      const plan = (options: { now?: Date; all?: boolean; limit?: number } = {}) =>
        dueItems(tx, {
          datasetId: DATASET,
          now: options.now ?? T(10),
          maxAgeDays: 7,
          current: 'r1.v1',
          limit: options.limit ?? 100,
          all: options.all,
        });

      // Nothing has been read: every page is due, each host's first, then each host's second.
      const first = await plan();
      expect(short(first.ids)).toEqual(['a1', 'b1', 'c1', 'a2', 'c2', 'c3']);
      expect(first).toMatchObject({ due: 6, live: 6 });
      // A limit cuts the plan by turns: no host takes the budget before the others have a page.
      expect(short((await plan({ limit: 3 })).ids)).toEqual(['a1', 'b1', 'c1']);

      // Every page read, at the lastmod it was listed with, current, and fresh: nothing is due.
      await tx
        .update(items)
        .set({
          lastFetchedAt: T(5),
          extractedWith: 'r1.v1',
          lastOutcome: 'unchanged',
          fetchedLastmod: sql`${items.listedLastmod}`,
        })
        .where(eq(items.datasetId, DATASET));
      expect(await plan()).toEqual({ ids: [], due: 0, live: 6, reread: [] });

      // c1's lastmod moved, a2's last read failed, b1's statements came from older code, and c3
      // was read eight days ago.
      await list(tx, T(6), [page(1, '2026-10-09T00:00:00.000Z'), page(2), page(3)]);
      await tx
        .update(items)
        .set({ lastOutcome: 'failed' })
        .where(eq(items.id, idOf('https://maker-a.example/products/a2')));
      await tx
        .update(items)
        .set({ extractedWith: 'r1.v1.retry' })
        .where(eq(items.id, idOf('https://maker-b.example/products/b1')));
      await tx
        .update(items)
        .set({ lastFetchedAt: new Date(T(10).getTime() - 8 * DAY) })
        .where(eq(items.locator, page(3).locator));
      const second = await plan();
      expect(short(second.ids)).toEqual(['a2', 'b1', 'c3', 'c1']);
      expect(second.due).toBe(4);
      // B1 is due only because its code is older, but no capture holds its copy: it's fetched.
      expect(second.reread).toEqual([]);

      expect((await plan({ all: true })).ids).toHaveLength(6);
      expect(await plan({ limit: 2 })).toMatchObject({ due: 4, live: 6 });
      expect(short((await plan({ limit: 2 })).ids)).toEqual(['a2', 'b1']);
    }));
});

/** A capture of the copy a page's fetch stored (ADR 0008), named by the copy's hash. */
const captureOf = (tx: Executor, item: ItemRef, fetchId: string, contentHash: string, at: Date) =>
  recordCapture(tx, {
    id: `cp_${contentHash}`,
    datasetId: DATASET,
    itemId: item.id,
    sourceId: item.sourceId,
    fetchId,
    url: item.locator,
    finalUrl: item.locator,
    httpStatus: 200,
    etag: null,
    lastModified: null,
    fetchedAt: at,
    contentHash,
    bytes: 100,
    storedBytes: 80,
    signals: {},
  });

describe('dueItems’s re-reads', () => {
  it('names the pages due only because their code is older, whose capture holds their copy', () =>
    withRollback(async (tx) => {
      await seed(tx);
      await list(tx, T(1), [page(1, '2026-10-01T00:00:00.000Z')]);
      const [a1, a2, b1, c1] = await listLiveItems(tx, DATASET);
      // Each page read at T(5) by revision 1's code, and the copy it stored captured.
      for (const item of [a1!, a2!, b1!, c1!]) {
        const name = item.locator.split('/').pop()!;
        await recordFetch(tx, {
          id: `fe_${name}_read`,
          runId: RUN,
          itemId: item.id,
          url: item.locator,
          finalUrl: item.locator,
          policy: 'allowed',
          policyReason: null,
          method: 'http',
          outcome: 'changed',
          httpStatus: 200,
          bytes: 100,
          signals: {},
          startedAt: T(5),
          durationMs: 50,
          error: null,
          page: { contentHash: `hash-${name}`, etag: null, lastModified: null },
          extractedWith: 'r1.v1',
        });
        await captureOf(tx, item, `fe_${name}_read`, `hash-${name}`, T(5));
      }
      const plan = (options: { current?: string; now?: Date; all?: boolean } = {}) =>
        dueItems(tx, {
          datasetId: DATASET,
          now: options.now ?? T(10),
          maxAgeDays: 7,
          current: options.current ?? 'r2.v1',
          limit: 100,
          all: options.all,
        });
      expect(await plan({ current: 'r1.v1' })).toEqual({ ids: [], due: 0, live: 4, reread: [] });
      // Revision 2's code: every page is due for that alone, and read again from its capture.
      const ids = [a1!.id, b1!.id, c1!.id, a2!.id];
      expect(await plan()).toEqual({ ids, due: 4, live: 4, reread: ids });

      // A2's latest capture holds another copy than its statements came from, B1's last fetch
      // failed, and C1 was listed again with a lastmod it wasn't read at. All four are due, and
      // only A1 is read again from its capture.
      await captureOf(tx, a2!, 'fe_a2_read', 'hash-a2-later', T(6));
      await tx.update(items).set({ lastOutcome: 'failed' }).where(eq(items.id, b1!.id));
      await list(tx, T(6), [page(1, '2026-10-09T00:00:00.000Z')]);
      expect(await plan()).toEqual({ ids, due: 4, live: 4, reread: [a1!.id] });
      // Under all, and once its freshness has run out, A1 is fetched.
      expect((await plan({ all: true })).reread).toEqual([]);
      expect((await plan({ now: new Date(T(10).getTime() + 8 * DAY) })).reread).toEqual([]);
    }));

  it('reads a revived irrelevant page again from its capture, and fetches one with none', () =>
    withRollback(async (tx) => {
      await seed(tx);
      await list(tx, T(1), [page(1, '2026-10-01T00:00:00.000Z')]);
      const [a1, a2] = await listLiveItems(tx, DATASET);
      for (const item of [a1!, a2!]) {
        const name = item.locator.split('/').pop()!;
        await recordFetch(tx, {
          id: `fe_${name}_read`,
          runId: RUN,
          itemId: item.id,
          url: item.locator,
          finalUrl: item.locator,
          policy: 'allowed',
          policyReason: null,
          method: 'http',
          outcome: 'changed',
          httpStatus: 200,
          bytes: 100,
          signals: {},
          startedAt: T(5),
          durationMs: 50,
          error: null,
          page: { contentHash: `hash-${name}`, etag: null, lastModified: null },
          extractedWith: 'r1.v1',
        });
      }
      // Only A1's copy was captured: A2 was read before the archive.
      await captureOf(tx, a1!, 'fe_a1_read', 'hash-a1', T(5));
      // The old categories had no place for either: "None of these" left both irrelevant.
      await tx
        .update(items)
        .set({ status: 'irrelevant' })
        .where(inArray(items.id, [a1!.id, a2!.id]));
      expect(
        await reviveItems(tx, { datasetId: DATASET, irrelevant: true, fromCaptures: true }),
      ).toBe(2);
      const planned = await dueItems(tx, {
        datasetId: DATASET,
        now: T(10),
        maxAgeDays: 7,
        current: 'r2.v1',
        limit: 100,
      });
      // Revision 2's code makes both due: A1 is read again from its capture, and A2 fetched.
      expect(planned.reread).toEqual([a1!.id]);
      expect(planned.ids).toEqual(expect.arrayContaining([a1!.id, a2!.id]));
      const kept = await tx
        .select({
          id: items.id,
          lastFetchedAt: items.lastFetchedAt,
          lastOutcome: items.lastOutcome,
          status: items.status,
        })
        .from(items)
        .where(inArray(items.id, [a1!.id, a2!.id]));
      expect(kept.map(({ status }) => status)).toEqual(['live', 'live']);
      // A2 is never read, and A1 keeps its last fetch and what it found.
      expect(kept.find((row) => row.id === a2!.id)).toMatchObject({
        lastFetchedAt: null,
        lastOutcome: null,
      });
      expect(kept.find((row) => row.id === a1!.id)).toMatchObject({
        lastFetchedAt: T(5),
        lastOutcome: 'changed',
      });
    }));

  it('revives irrelevant pages to be fetched without fromCaptures, and only irrelevant ones with it', () =>
    withRollback(async (tx) => {
      await seed(tx);
      await list(tx, T(1), [page(1, '2026-10-01T00:00:00.000Z')]);
      const [a1, a2] = await listLiveItems(tx, DATASET);
      await recordFetch(tx, {
        id: 'fe_a1_read',
        runId: RUN,
        itemId: a1!.id,
        url: a1!.locator,
        finalUrl: a1!.locator,
        policy: 'allowed',
        policyReason: null,
        method: 'http',
        outcome: 'changed',
        httpStatus: 200,
        bytes: 100,
        signals: {},
        startedAt: T(5),
        durationMs: 50,
        error: null,
        page: { contentHash: 'hash-a1', etag: null, lastModified: null },
        extractedWith: 'r1.v1',
      });
      await captureOf(tx, a1!, 'fe_a1_read', 'hash-a1', T(5));
      await tx.update(items).set({ status: 'irrelevant' }).where(eq(items.id, a1!.id));
      // A2 is refused, not irrelevant: --irrelevant leaves it, and a named one is fetched.
      await tx.update(items).set({ status: 'refused' }).where(eq(items.id, a2!.id));
      expect(await reviveItems(tx, { datasetId: DATASET, irrelevant: true })).toBe(1);
      const revived = (id: string) =>
        tx
          .select({ status: items.status, lastFetchedAt: items.lastFetchedAt })
          .from(items)
          .where(eq(items.id, id))
          .then(([row]) => row);
      expect(await revived(a1!.id)).toEqual({ status: 'live', lastFetchedAt: null });
      expect((await revived(a2!.id))!.status).toBe('refused');
      // With fromCaptures, a refused page named beside it is still fetched: only an irrelevant
      // page whose capture holds its copy keeps its last fetch.
      await tx
        .update(items)
        .set({ status: 'irrelevant', lastFetchedAt: T(5), lastOutcome: 'changed' })
        .where(eq(items.id, a1!.id));
      await tx
        .update(items)
        .set({ lastFetchedAt: T(5) })
        .where(eq(items.id, a2!.id));
      expect(
        await reviveItems(tx, {
          datasetId: DATASET,
          irrelevant: true,
          fromCaptures: true,
          pages: [a2!.locator],
        }),
      ).toBe(2);
      expect(await revived(a1!.id)).toEqual({ status: 'live', lastFetchedAt: T(5) });
      expect(await revived(a2!.id)).toEqual({ status: 'live', lastFetchedAt: null });
    }));
});

describe('itemsByIds', () => {
  it('loads live items in the order asked', () =>
    withRollback(async (tx) => {
      await seed(tx);
      await list(tx, T(1), [page(1), page(2)]);
      const live = await listLiveItems(tx, DATASET);
      const [c1, c2] = live.filter((item) => item.sourceId === 'maker-c');
      await tx.update(items).set({ status: 'refused' }).where(eq(items.id, c1!.id));
      const loaded = await itemsByIds(tx, [c2!.id, c1!.id, live[0]!.id]);
      expect(loaded.map((item) => item.id)).toEqual([c2!.id, live[0]!.id]);
    }));
});

describe('taxonomyPages, taxonomyItemsByIds, and markForFetch', () => {
  it('plan the pages a taxonomy change touched, live ones first, and mark them to be fetched', () =>
    withRollback(async (tx) => {
      await applyDefinition(tx, testTaxonomyDefinition('backfill-plan'));
      const [a1, a2, b1] = await listLiveItems(tx, 'backfill-plan');
      const plan = (keys: string[], limit = 10) =>
        taxonomyPages(tx, { datasetId: 'backfill-plan', keys, limit });
      // A live page never decided under the taxonomy waits for its own read.
      expect(await plan(['key-none'])).toEqual({ ids: [], due: 0 });

      // A1 was decided under a key the taxonomy no longer has. A2 was taken out under a key it
      // still has, and B1 before the taxonomy, with no key.
      await setTaxonomyKey(tx, a1!.id, 'key-old');
      await setTaxonomyKey(tx, a2!.id, 'key-now');
      await setItemStatus(tx, a2!.id, 'irrelevant');
      await setItemStatus(tx, b1!.id, 'irrelevant');
      expect(await plan(['key-none', 'key-now'])).toEqual({ ids: [a1!.id, b1!.id], due: 2 });
      // A change to A2's key too: live pages come first, then by source and address.
      expect(await plan(['key-none'])).toEqual({ ids: [a1!.id, a2!.id, b1!.id], due: 3 });
      expect(await plan(['key-none'], 1)).toEqual({ ids: [a1!.id], due: 3 });
      // A run whose item budget the pages used up plans none, and still says how many wait.
      expect(await plan(['key-none'], 0)).toEqual({ ids: [], due: 3 });
      expect(
        (await taxonomyItemsByIds(tx, [b1!.id, a1!.id])).map((item) => [item.id, item.status]),
      ).toEqual([
        [b1!.id, 'irrelevant'],
        [a1!.id, 'live'],
      ]);

      // Marked to be fetched, B1 is live again, and neither page is current.
      await setExtractedWith(tx, a1!.id, 'r1.v1');
      await setExtractedWith(tx, b1!.id, 'r1.v1');
      expect(await markForFetch(tx, [a1!.id, b1!.id])).toBe(2);
      expect(
        await tx
          .select({ id: items.id, status: items.status, extractedWith: items.extractedWith })
          .from(items)
          .where(inArray(items.id, [a1!.id, b1!.id]))
          .orderBy(items.locator),
      ).toEqual([
        { id: a1!.id, status: 'live', extractedWith: null },
        { id: b1!.id, status: 'live', extractedWith: null },
      ]);

      // A page that's gone is neither planned, loaded, nor marked.
      await setItemStatus(tx, a2!.id, 'gone');
      expect(await plan(['key-none'])).toEqual({ ids: [a1!.id], due: 1 });
      expect(await taxonomyItemsByIds(tx, [a2!.id])).toEqual([]);
      expect(await markForFetch(tx, [a2!.id])).toBe(0);
    }));
});

describe('the fetch log', () => {
  it('records when a page was last read, and the lastmod it was read at', () =>
    withRollback(async (tx) => {
      await seed(tx);
      await list(tx, T(1), [page(1, '2026-10-01T00:00:00.000Z')]);
      const c1 = (await listLiveItems(tx, DATASET)).find((item) => item.sourceId === 'maker-c')!;
      const fetch = (id: string, outcome: 'changed' | 'failed', at: Date) =>
        recordFetch(tx, {
          id,
          runId: RUN,
          itemId: c1.id,
          url: c1.locator,
          finalUrl: c1.locator,
          policy: 'allowed',
          policyReason: null,
          method: 'http',
          outcome,
          httpStatus: outcome === 'changed' ? 200 : 503,
          bytes: null,
          signals: {},
          startedAt: at,
          durationMs: 50,
          error: null,
        });
      const read = async () =>
        (
          await tx
            .select({ lastFetchedAt: items.lastFetchedAt, fetchedLastmod: items.fetchedLastmod })
            .from(items)
            .where(eq(items.id, c1.id))
        )[0];
      await fetch('fe_listedread0000000000000', 'changed', T(2));
      expect(await read()).toEqual({
        lastFetchedAt: T(2),
        fetchedLastmod: '2026-10-01T00:00:00.000Z',
      });
      await list(tx, T(3), [page(1, '2026-10-09T00:00:00.000Z')]);
      await fetch('fe_listedfail0000000000000', 'failed', T(4));
      // A failed fetch read nothing, so the lastmod it would have confirmed stays unconfirmed.
      expect(await read()).toEqual({
        lastFetchedAt: T(4),
        fetchedLastmod: '2026-10-01T00:00:00.000Z',
      });
    }));

  it('logs a sitemap read, which belongs to no page, once', () =>
    withRollback(async (tx) => {
      await seed(tx);
      const input = {
        id: 'fe_sitemapread000000000000',
        runId: RUN,
        sourceId: 'maker-c',
        url: 'https://maker-c.example/sitemap.xml',
        finalUrl: 'https://maker-c.example/sitemap.xml',
        policy: 'allowed',
        policyReason: null,
        outcome: 'changed',
        httpStatus: 200,
        bytes: 500,
        startedAt: T(1),
        durationMs: 80,
        error: null,
      } as const;
      await recordSitemapFetch(tx, input);
      await recordSitemapFetch(tx, input);
      const logged = await tx.select().from(fetches).where(eq(fetches.id, input.id));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ kind: 'sitemap', itemId: null, sourceId: 'maker-c' });
      // A page's fetch must name its page: the CHECK refuses one that doesn't. This runs last,
      // because a failed statement ends the test's transaction.
      expect(
        await brokenConstraint(
          tx.insert(fetches).values({
            ...input,
            id: 'fe_pagewithoutitem00000000',
            kind: 'page',
            itemId: null,
            method: 'http',
            signals: null,
          }),
        ),
      ).toBe('fetches_subject');
    }));
});
