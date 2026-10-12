import { newId, type Outcome } from '@spatula/core';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Executor } from './client';
import type { ItemRef } from './datasets';
import { fetches, items, sources } from './schema';

/*
 * What discovery found, and what a run reads. A sitemap source's pages come and go with its
 * sitemaps: a page listed again comes back, and one left out of three complete reads in a row is
 * gone. A read that wasn't complete marks nothing missing. A run reads the pages that are due, the
 * least recently read first, taking turns between hosts, so no host waits on another's pacing.
 */

/** Three complete reads of a source's sitemaps in a row without a page make it gone. */
export const MISSING_GONE_AFTER = 3;
/** Rows written by one statement: seven parameters each, far under postgres.js's limit. */
const LIST_CHUNK = 1000;

export interface ListedPage {
  locator: string;
  lastmod: string | null;
}

/**
 * Lists a source's pages as one read of its sitemaps found them. A new page becomes a live item.
 * A page listed again comes back if it had left the definition or gone missing; one that's gone
 * after 404s, refused, or irrelevant stays as it is. Every page this read listed carries its time,
 * so `finishListing` can tell which pages it left out.
 */
export async function listPages(
  db: Executor,
  input: {
    datasetId: string;
    sourceId: string;
    recordType: string;
    listedAt: Date;
    pages: ListedPage[];
  },
): Promise<{ listed: number; added: number; revived: number }> {
  if (input.pages.length === 0) return { listed: 0, added: 0, revived: 0 };
  return db.transaction(async (tx) => {
    const before = new Map(
      (
        await tx
          .select({
            locator: items.locator,
            status: items.status,
            missingStreak: items.missingStreak,
          })
          .from(items)
          .where(and(eq(items.datasetId, input.datasetId), eq(items.sourceId, input.sourceId)))
      ).map((row) => [row.locator, row]),
    );
    let added = 0;
    let revived = 0;
    for (const page of input.pages) {
      const row = before.get(page.locator);
      if (row === undefined) added += 1;
      // The same rule as the upsert's status below: keep the two in step.
      else if (
        row.status === 'excluded' ||
        (row.status === 'gone' && row.missingStreak >= MISSING_GONE_AFTER)
      ) {
        revived += 1;
      }
    }
    for (let start = 0; start < input.pages.length; start += LIST_CHUNK) {
      const chunk = input.pages.slice(start, start + LIST_CHUNK);
      await tx
        .insert(items)
        .values(
          chunk.map((page) => ({
            id: newId('it'),
            datasetId: input.datasetId,
            sourceId: input.sourceId,
            recordType: input.recordType,
            locator: page.locator,
            listedAt: input.listedAt,
            listedLastmod: page.lastmod,
          })),
        )
        .onConflictDoUpdate({
          target: [items.datasetId, items.sourceId, items.locator],
          // Each expression reads the row as it was, so the status sees the old streak.
          set: {
            recordType: input.recordType,
            listedAt: input.listedAt,
            listedLastmod: sql`excluded.listed_lastmod`,
            missingStreak: 0,
            status: sql`case when ${items.status} = 'excluded' or (${items.status} = 'gone' and ${items.missingStreak} >= ${MISSING_GONE_AFTER}) then 'live' else ${items.status} end`,
          },
        });
    }
    return { listed: input.pages.length, added, revived };
  });
}

/**
 * Ends a complete read of a source's sitemaps: each live page it didn't list is one read closer to
 * gone. The source keeps the read's time, so a step that runs again counts nothing twice.
 */
export async function finishListing(
  db: Executor,
  input: { datasetId: string; sourceId: string; listedAt: Date },
): Promise<{ missing: number; gone: number }> {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select({ listedAt: sources.listedAt })
      .from(sources)
      .where(and(eq(sources.datasetId, input.datasetId), eq(sources.id, input.sourceId)))
      .for('update');
    if (source === undefined) throw new Error(`Source ${input.sourceId} doesn't exist`);
    if (source.listedAt !== null && source.listedAt >= input.listedAt)
      return { missing: 0, gone: 0 };
    const missed = await tx
      .update(items)
      .set({
        missingStreak: sql`${items.missingStreak} + 1`,
        status: sql`case when ${items.missingStreak} + 1 >= ${MISSING_GONE_AFTER} then 'gone' else ${items.status} end`,
      })
      .where(
        and(
          eq(items.datasetId, input.datasetId),
          eq(items.sourceId, input.sourceId),
          eq(items.status, 'live'),
          or(isNull(items.listedAt), lt(items.listedAt, input.listedAt)),
        ),
      )
      .returning({ status: items.status });
    await tx
      .update(sources)
      .set({ listedAt: input.listedAt })
      .where(and(eq(sources.datasetId, input.datasetId), eq(sources.id, input.sourceId)));
    return { missing: missed.length, gone: missed.filter((row) => row.status === 'gone').length };
  });
}

/**
 * The live pages a run reads, at most `limit`, and how many were due. A page is due when it was
 * never read, was read more than `maxAgeDays` ago, has statements from older code (`current` is the
 * extraction mark a page read now gets), was listed with a lastmod it wasn't read at, or its last
 * fetch failed, was blocked, or found it gone once. `all` makes every live page due. Pages come
 * least recently read first, each host's first page, then each host's second, and so on.
 */
export async function dueItems(
  db: Executor,
  input: {
    datasetId: string;
    now: Date;
    maxAgeDays: number;
    current: string;
    limit: number;
    all?: boolean;
  },
): Promise<{ ids: string[]; due: number; live: number }> {
  const cutoff = new Date(input.now.getTime() - input.maxAgeDays * 24 * 60 * 60 * 1000);
  // A Date can't go into a raw sql template: drizzle's postgres-js driver passes it unencoded,
  // and postgres.js can't bind it. Its ISO text, cast, compares the same.
  const rows = await db.execute<{ id: string | null; due: string; live: string }>(sql`
    with live as (
      select
        ${items.id} as id,
        ${items.locator} as locator,
        ${items.lastFetchedAt} as last_fetched_at,
        substring(${items.locator} from '^https://([^/?#]+)') as host,
        (
          ${input.all === true}::boolean
          or ${items.lastFetchedAt} is null
          or ${items.lastFetchedAt} < ${cutoff.toISOString()}::timestamptz
          or ${items.extractedWith} is distinct from ${input.current}
          or (${items.listedLastmod} is not null and ${items.listedLastmod} is distinct from ${items.fetchedLastmod})
          or ${items.lastOutcome} in ('failed', 'blocked', 'gone')
        ) as due
      from ${items}
      where ${items.datasetId} = ${input.datasetId} and ${items.status} = 'live'
    ),
    ranked as (
      select id, host, row_number() over (
        partition by host order by last_fetched_at asc nulls first, locator
      ) as turn
      from live where due
    ),
    chosen as (
      select id, turn, host from ranked order by turn, host limit ${input.limit}
    )
    select
      chosen.id,
      (select count(*) from ranked)::text as due,
      (select count(*) from live)::text as live
    from (select 1) as one
    left join chosen on true
    order by chosen.turn, chosen.host
  `);
  const first = rows[0];
  return {
    ids: rows.flatMap((row) => (row.id === null ? [] : [row.id])),
    due: Number(first?.due ?? 0),
    live: Number(first?.live ?? 0),
  };
}

/** The live items with these IDs, in the order asked. */
export async function itemsByIds(db: Executor, ids: string[]): Promise<ItemRef[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: items.id,
      sourceId: items.sourceId,
      recordType: items.recordType,
      locator: items.locator,
      etag: items.etag,
      lastModified: items.lastModified,
      contentHash: items.contentHash,
      extractInputHash: items.extractInputHash,
      extractedWith: items.extractedWith,
    })
    .from(items)
    .where(and(inArray(items.id, ids), eq(items.status, 'live')));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

export interface SitemapFetchInput {
  id: string;
  runId: string;
  sourceId: string;
  url: string;
  finalUrl: string | null;
  policy: 'allowed' | 'denied';
  policyReason: string | null;
  outcome: Outcome;
  httpStatus: number | null;
  bytes: number | null;
  startedAt: Date;
  durationMs: number;
  error: string | null;
}

/** Logs a read of a sitemap. Its ID comes from the run, so a step that runs again logs it once. */
export async function recordSitemapFetch(db: Executor, input: SitemapFetchInput): Promise<void> {
  await db
    .insert(fetches)
    .values({ ...input, kind: 'sitemap', itemId: null, method: 'http', signals: null })
    .onConflictDoNothing({ target: fetches.id });
}
