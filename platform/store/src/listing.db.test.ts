import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { T } from '../test/seed';
import type { Executor } from './client';
import { applyDefinition, listLiveItems } from './datasets';
import { recordFetch } from './fetches';
import { testSitemapDefinition } from './fixtures';
import {
  dueItems,
  finishListing,
  itemsByIds,
  listPages,
  MISSING_GONE_AFTER,
  recordSitemapFetch,
} from './listing';
import { startRun } from './runs';
import { fetches, items } from './schema';

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
      expect(await plan()).toEqual({ ids: [], due: 0, live: 6 });

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

      expect((await plan({ all: true })).ids).toHaveLength(6);
      expect(await plan({ limit: 2 })).toMatchObject({ due: 4, live: 6 });
      expect(short((await plan({ limit: 2 })).ids)).toEqual(['a2', 'b1']);
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
