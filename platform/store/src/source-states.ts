import { REFUSE_AFTER_RUNS, type SourceProbe, type SourceVerdict } from '@spatula/core';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Executor } from './client';
import type { ItemRef } from './datasets';
import { items, sources } from './schema';

/*
 * Each source's standing across runs (ADR 0006): how many runs in a row it was blocked, whether
 * that refused it, and what its last probe met. A run's last steps count its verdicts here, the
 * run plan leaves refused sources out, and a person can put a source back.
 */

export interface SourceState {
  id: string;
  blockedRuns: number;
  refusedAt: Date | null;
  lastProbeAt: Date | null;
  lastProbe: SourceProbe | null;
}

/** The standing of the dataset's sources, removed ones left out, by ID. */
export async function sourceStates(db: Executor, datasetId: string): Promise<SourceState[]> {
  return db
    .select({
      id: sources.id,
      blockedRuns: sources.blockedRuns,
      refusedAt: sources.refusedAt,
      lastProbeAt: sources.lastProbeAt,
      lastProbe: sources.lastProbe,
    })
    .from(sources)
    .where(and(eq(sources.datasetId, datasetId), isNull(sources.removedAt)))
    .orderBy(sources.id);
}

/** What a source looks like when it's live again: no blocked runs, no refusal, no probe. */
const LIVE = { blockedRuns: 0, refusedAt: null, lastProbe: null, lastProbeAt: null };

/**
 * Counts a run's verdicts. A source the run got through to starts again at zero, and is live. A
 * blocked one counts one more blocked run, and the third in a row refuses it. An untouched one keeps
 * its count. A refused source whose probe didn't get through keeps when it was probed and what the
 * probe met. Each source keeps the start of the run it counted last, so a step that runs again, or
 * an older run that ends after a newer one, counts nothing. Returns the sources this run blocked,
 * with their counts, and those it refused.
 */
export async function recordSourceRuns(
  db: Executor,
  input: {
    datasetId: string;
    at: Date;
    verdicts: Record<string, SourceVerdict>;
    probes: Record<string, SourceProbe>;
  },
): Promise<{ blocked: { id: string; blockedRuns: number }[]; refused: string[] }> {
  const ids = Object.keys(input.verdicts);
  if (ids.length === 0) return { blocked: [], refused: [] };
  return db.transaction(async (tx) => {
    // In a fixed order, so two runs that end together can't deadlock: one waits for the other.
    const rows = await tx
      .select({
        id: sources.id,
        blockedRuns: sources.blockedRuns,
        refusedAt: sources.refusedAt,
        countedAt: sources.countedAt,
      })
      .from(sources)
      .where(and(eq(sources.datasetId, input.datasetId), inArray(sources.id, ids)))
      .orderBy(sources.id)
      .for('update');
    const blocked: { id: string; blockedRuns: number }[] = [];
    const refused: string[] = [];
    for (const row of rows) {
      if (row.countedAt !== null && row.countedAt >= input.at) continue;
      const verdict = input.verdicts[row.id]!;
      const probe = input.probes[row.id];
      const blockedRuns = verdict === 'blocked' ? row.blockedRuns + 1 : row.blockedRuns;
      const refusedNow = row.refusedAt === null && blockedRuns >= REFUSE_AFTER_RUNS;
      await tx
        .update(sources)
        .set(
          verdict === 'through'
            ? { ...LIVE, countedAt: input.at }
            : {
                blockedRuns,
                ...(refusedNow ? { refusedAt: input.at } : {}),
                ...(probe === undefined ? {} : { lastProbe: probe, lastProbeAt: input.at }),
                countedAt: input.at,
              },
        )
        .where(and(eq(sources.datasetId, input.datasetId), eq(sources.id, row.id)));
      if (verdict === 'blocked') blocked.push({ id: row.id, blockedRuns });
      if (refusedNow) refused.push(row.id);
    }
    return { blocked, refused };
  });
}

/** Makes refused sources live again, as a probe that got through does. */
export async function liveAgain(
  db: Executor,
  input: { datasetId: string; sourceIds: string[] },
): Promise<void> {
  if (input.sourceIds.length === 0) return;
  await db
    .update(sources)
    .set(LIVE)
    .where(and(eq(sources.datasetId, input.datasetId), inArray(sources.id, input.sourceIds)));
}

/**
 * Puts sources back by hand (`spatula revive --source`): their blocked runs start again at zero,
 * and a refused one is live. Counts the sources it changed; one that wasn't blocked isn't counted.
 */
export async function reviveSources(
  db: Executor,
  input: { datasetId: string; sources: string[] },
): Promise<number> {
  if (input.sources.length === 0) return 0;
  const rows = await db
    .update(sources)
    .set(LIVE)
    .where(
      and(
        eq(sources.datasetId, input.datasetId),
        inArray(sources.id, input.sources),
        isNull(sources.removedAt),
        or(sql`${sources.blockedRuns} > 0`, isNotNull(sources.refusedAt)),
      ),
    )
    .returning({ id: sources.id });
  return rows.length;
}

/** The page a refused pages source is probed with: its least recently read live page. */
export async function probeItem(
  db: Executor,
  input: { datasetId: string; sourceId: string },
): Promise<ItemRef | null> {
  const [row] = await db
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
    .where(
      and(
        eq(items.datasetId, input.datasetId),
        eq(items.sourceId, input.sourceId),
        eq(items.status, 'live'),
      ),
    )
    .orderBy(sql`${items.lastFetchedAt} asc nulls first`, items.locator)
    .limit(1);
  return row ?? null;
}
