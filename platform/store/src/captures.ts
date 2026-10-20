import type { ContentSignals } from '@spatula/core';
import { and, desc, eq, inArray, isNotNull, notInArray, or, sql } from 'drizzle-orm';
import type { Executor } from './client';
import { captures, fetches, items, sources, statements } from './schema';

/*
 * The page archive (ADR 0008). A capture is a page as a fetch found it: its body, kept once under its
 * hash; what Spatula read from it; and how it was fetched. Retention keeps a page's latest capture,
 * every capture a current statement cites, and earlier ones while they are both among the page's
 * ten latest and less than a year old. A run's cleanup deletes the rest, and a purge deletes a
 * source's. A body's file is shared by every capture and page with its hash, in any dataset, so it
 * goes only once none holds it.
 */

/** How long earlier captures are kept, and how many of a page's at most. */
export const CAPTURE_KEEP_DAYS = 365;
export const CAPTURE_KEEP_EARLIER = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CaptureRow {
  id: string;
  datasetId: string;
  itemId: string;
  sourceId: string;
  fetchId: string;
  url: string;
  finalUrl: string;
  httpStatus: number | null;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: Date;
  contentHash: string;
  bytes: number | null;
  storedBytes: number | null;
  signals: ContentSignals | null;
  readKey: string | null;
  reader: number | null;
}

/** A capture as a fetch records it, before anything has read it. */
export type NewCapture = Omit<CaptureRow, 'readKey' | 'reader'>;

const CAPTURE = {
  id: captures.id,
  datasetId: captures.datasetId,
  itemId: captures.itemId,
  sourceId: captures.sourceId,
  fetchId: captures.fetchId,
  url: captures.url,
  finalUrl: captures.finalUrl,
  httpStatus: captures.httpStatus,
  etag: captures.etag,
  lastModified: captures.lastModified,
  fetchedAt: captures.fetchedAt,
  contentHash: captures.contentHash,
  bytes: captures.bytes,
  storedBytes: captures.storedBytes,
  signals: captures.signals,
  readKey: captures.readKey,
  reader: captures.reader,
};

/** Records a capture, once: a step that runs again gets back the capture it recorded. */
export async function recordCapture(db: Executor, capture: NewCapture): Promise<CaptureRow> {
  await db.insert(captures).values(capture).onConflictDoNothing({ target: captures.id });
  const row = await captureById(db, capture.id);
  if (row === null) throw new Error(`Capture ${capture.id} could not be recorded`);
  return row;
}

export async function captureById(db: Executor, id: string): Promise<CaptureRow | null> {
  const [row] = await db.select(CAPTURE).from(captures).where(eq(captures.id, id));
  return row ?? null;
}

/** The page's latest capture: the last one fetched, and of two fetched together, the greater ID. */
export async function latestCapture(db: Executor, itemId: string): Promise<CaptureRow | null> {
  const [row] = await db
    .select(CAPTURE)
    .from(captures)
    .where(eq(captures.itemId, itemId))
    .orderBy(desc(captures.fetchedAt), desc(captures.id))
    .limit(1);
  return row ?? null;
}

/** These pages' latest captures, by page. A page without a capture is left out. */
export async function latestCaptures(
  db: Executor,
  itemIds: readonly string[],
): Promise<Map<string, CaptureRow>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([captures.itemId], CAPTURE)
    .from(captures)
    .where(inArray(captures.itemId, [...itemIds]))
    .orderBy(captures.itemId, desc(captures.fetchedAt), desc(captures.id));
  return new Map(rows.map((row) => [row.itemId, row]));
}

/**
 * Notes where what Spatula read from a capture is kept, and the version that read it. Returns how
 * many captures it noted that on: none when the capture has been deleted.
 */
export async function setCaptureRead(
  db: Executor,
  input: { id: string; readKey: string; reader: number },
): Promise<number> {
  const rows = await db
    .update(captures)
    .set({ readKey: input.readKey, reader: input.reader })
    .where(eq(captures.id, input.id))
    .returning({ id: captures.id });
  return rows.length;
}

/**
 * The dataset's captures that retention no longer keeps, oldest first, at most `limit`. A page's
 * latest capture is kept. Of its earlier ones, a capture of the same body as the latest is a copy of
 * it and goes, and the others are kept while they are among the ten latest and less than a year
 * older than `now`. A capture that a current statement cites is kept, whatever its age: it is that
 * statement's evidence. A Date can't go into a raw sql template (see `dueItems`), so `now` goes in as
 * its ISO text, cast.
 */
export async function prunableCaptures(
  db: Executor,
  input: { datasetId: string; now: Date; limit: number },
): Promise<string[]> {
  const cutoff = new Date(input.now.getTime() - CAPTURE_KEEP_DAYS * DAY_MS);
  const rows = await db.execute<{ id: string }>(sql`
    with ordered as (
      select
        ${captures.id} as id,
        ${captures.itemId} as item_id,
        ${captures.contentHash} as content_hash,
        ${captures.fetchedAt} as fetched_at,
        row_number() over latest as n,
        first_value(${captures.contentHash}) over latest as latest_hash
      from ${captures}
      where ${captures.datasetId} = ${input.datasetId}
      window latest as (partition by ${captures.itemId} order by ${captures.fetchedAt} desc, ${captures.id} desc)
    ),
    earlier as (
      select
        id,
        fetched_at,
        content_hash = latest_hash as copy,
        row_number() over (
          partition by item_id, content_hash = latest_hash
          order by fetched_at desc, id desc
        ) as k
      from ordered
      where n > 1
    )
    select id from earlier
    where (
      copy
      or k > ${CAPTURE_KEEP_EARLIER}
      or fetched_at < ${cutoff.toISOString()}::timestamptz
    )
    and not exists (
      select 1 from ${statements}
      where ${statements.captureId} = earlier.id and ${statements.withdrawnAt} is null
    )
    order by fetched_at, id
    limit ${input.limit}
  `);
  return rows.map((row) => row.id);
}

/**
 * What deleting these captures would free: the hashes of the bodies that no other capture and no
 * page holds, in any dataset, and the captures' reads. It deletes nothing, so a cleanup can delete
 * the files first and the rows after, and a step that runs again finds the same rows.
 */
export async function freedKeys(
  db: Executor,
  captureIds: readonly string[],
): Promise<{ hashes: string[]; reads: string[] }> {
  if (captureIds.length === 0) return { hashes: [], reads: [] };
  const ids = [...captureIds];
  const going = await db
    .select({ contentHash: captures.contentHash, readKey: captures.readKey })
    .from(captures)
    .where(inArray(captures.id, ids));
  const reads = going.flatMap((row) => (row.readKey === null ? [] : [row.readKey])).sort();
  const hashes = [...new Set(going.map((row) => row.contentHash))];
  if (hashes.length === 0) return { hashes: [], reads };
  const heldByCaptures = await db
    .selectDistinct({ hash: captures.contentHash })
    .from(captures)
    .where(and(inArray(captures.contentHash, hashes), notInArray(captures.id, ids)));
  const heldByPages = await db
    .selectDistinct({ hash: items.contentHash })
    .from(items)
    .where(inArray(items.contentHash, hashes));
  const held = new Set([
    ...heldByCaptures.map((row) => row.hash),
    ...heldByPages.flatMap((row) => (row.hash === null ? [] : [row.hash])),
  ]);
  return { hashes: hashes.filter((hash) => !held.has(hash)).sort(), reads };
}

/** Deletes these captures. A statement that cited one keeps its history and cites none. */
export async function deleteCaptures(db: Executor, captureIds: readonly string[]): Promise<number> {
  if (captureIds.length === 0) return 0;
  const rows = await db
    .delete(captures)
    .where(inArray(captures.id, [...captureIds]))
    .returning({ id: captures.id });
  return rows.length;
}

/**
 * What purging a source would delete (ADR 0008): the hashes of the page bodies that only its
 * captures and its pages hold, and its captures' reads. A source's captures are those of the pages
 * it holds now, and those taken under it while a page belonged to it (pages move, ADR 0006). Its
 * pages' bodies are their stored copies, and every body their fetches stored, which before the
 * archive was a raw copy per changed fetch that no capture names. Null when the dataset never had
 * the source; a removed source has rows still. It deletes nothing, so a purge can delete the files
 * first.
 */
export async function purgeKeys(
  db: Executor,
  input: { datasetId: string; sourceId: string },
): Promise<{ hashes: string[]; reads: string[] } | null> {
  const [source] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.datasetId, input.datasetId), eq(sources.id, input.sourceId)));
  if (source === undefined) return null;
  const rows = await db.execute<{ kind: 'body' | 'read'; key: string }>(sql`
    with pages as (
      select ${items.id} as id, ${items.contentHash} as content_hash
      from ${items}
      where ${items.datasetId} = ${input.datasetId} and ${items.sourceId} = ${input.sourceId}
    ),
    purged as (
      select ${captures.id} as id, ${captures.contentHash} as content_hash, ${captures.readKey} as read_key
      from ${captures}
      where ${captures.datasetId} = ${input.datasetId}
        and (${captures.sourceId} = ${input.sourceId} or ${captures.itemId} in (select id from pages))
    ),
    hashes as (
      select content_hash as hash from purged
      union
      select content_hash from pages where content_hash is not null
      union
      select ${fetches.contentHash} from ${fetches}
      where ${fetches.itemId} in (select id from pages) and ${fetches.contentHash} is not null
    )
    select 'body' as kind, hash as key from hashes
    where not exists (
      select 1 from ${captures} as other
      where other.content_hash = hashes.hash and other.id not in (select id from purged)
    )
    and not exists (
      select 1 from ${items} as page
      where page.content_hash = hashes.hash and page.id not in (select id from pages)
    )
    union all
    select 'read' as kind, read_key as key from purged where read_key is not null
  `);
  const keys = (kind: 'body' | 'read') =>
    rows.flatMap((row) => (row.kind === kind ? [row.key] : [])).sort();
  return { hashes: keys('body'), reads: keys('read') };
}

/**
 * Purges a source (ADR 0008): deletes its captures, and forgets its pages' stored copies, their hash
 * and validators, so nothing points at a deleted file and each page's next fetch is unconditional.
 * For the same reason it forgets the hashes its pages' fetches logged, so a purge run again finds
 * nothing left. Its statements stay: they're facts, and their citations become null. Returns how
 * many captures went, and how many pages lost their copy.
 */
export async function purgeSource(
  db: Executor,
  input: { datasetId: string; sourceId: string },
): Promise<{ captures: number; pages: number }> {
  return db.transaction(async (tx) => {
    const pages = tx
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.datasetId, input.datasetId), eq(items.sourceId, input.sourceId)));
    const deleted = await tx
      .delete(captures)
      .where(
        and(
          eq(captures.datasetId, input.datasetId),
          or(eq(captures.sourceId, input.sourceId), inArray(captures.itemId, pages)),
        ),
      )
      .returning({ id: captures.id });
    const forgotten = await tx
      .update(items)
      .set({ contentHash: null, etag: null, lastModified: null })
      .where(
        and(
          eq(items.datasetId, input.datasetId),
          eq(items.sourceId, input.sourceId),
          isNotNull(items.contentHash),
        ),
      )
      .returning({ id: items.id });
    await tx
      .update(fetches)
      .set({ contentHash: null })
      .where(and(inArray(fetches.itemId, pages), isNotNull(fetches.contentHash)));
    return { captures: deleted.length, pages: forgotten.length };
  });
}

/**
 * Forgets one page's stored copy, its hash and validators, as a purge forgets a source's: for a
 * page whose copy's file has gone missing (ADR 0008), so its next fetch is unconditional and stores
 * the body again.
 */
export async function forgetStoredCopy(db: Executor, itemId: string): Promise<void> {
  await db
    .update(items)
    .set({ contentHash: null, etag: null, lastModified: null })
    .where(eq(items.id, itemId));
}
