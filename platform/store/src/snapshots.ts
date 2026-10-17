import type { Question } from '@spatula/core';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { Executor } from './client';
import { decideReviews, dismissReviews, openReview } from './decisions';
import { datasets, snapshots, type SnapshotReport, type SnapshotState } from './schema';

/*
 * Snapshots (ADR 0004). A published one has a generation, which moves the dataset's head compared
 * and set. A held one waits for the owner with none, and is published, discarded, or superseded
 * by a newer run's records; its question closes with it.
 *
 * One lock order. A publication moves the dataset's head and changes a snapshot's state, and a run
 * that commits supersedes what is held. If one took the snapshot's row first and the dataset's
 * second, and the other the dataset's first, two that raced for one generation would each hold what
 * the other wanted next, and Postgres would end one with "deadlock detected". So every function
 * here that changes a snapshot's state takes the dataset's row first (`lockDataset`), and the
 * snapshot rows after, which also makes the changes to one dataset's snapshots go one at a time.
 */

/** A published snapshot. The file is in R2 under `key`. */
export interface SnapshotRow {
  id: string;
  datasetId: string;
  generation: number;
  runId: string | null;
  /** The definition revision its records came from; null before slice 1. */
  revision: number | null;
  recordCount: number;
  /** The hash of the records alone, to tell whether anything changed since the last snapshot. */
  recordsSha256: string;
  key: string;
  /** The hash of the whole file, which readers check. */
  sha256: string;
  bytes: number;
  publishedAt: string;
  report: SnapshotReport;
}

/** A snapshot in any state. A held one has no generation and no publication time. */
export interface StoredSnapshot extends Omit<SnapshotRow, 'generation' | 'publishedAt'> {
  state: SnapshotState;
  generation: number | null;
  publishedAt: string | null;
  heldReason: string | null;
  createdAt: string;
}

/**
 * Takes the dataset's row, which a change to a snapshot's state takes before any snapshot's. It's
 * the lock an UPDATE of the row takes (`for no key update`), not `for update`. The stronger one
 * would hold up every insert that refers to the dataset, such as a run's, and two sessions that had
 * each inserted such a row, which takes a share of the dataset's row, would deadlock asking for it.
 */
async function lockDataset(tx: Executor, datasetId: string): Promise<void> {
  await tx
    .select({ id: datasets.id })
    .from(datasets)
    .where(eq(datasets.id, datasetId))
    .for('no key update');
}

/** The dataset's latest published generation, without reading its definition. */
export async function headGenerationOf(db: Executor, datasetId: string): Promise<number> {
  const [dataset] = await db
    .select({ headGeneration: datasets.headGeneration })
    .from(datasets)
    .where(eq(datasets.id, datasetId));
  return dataset?.headGeneration ?? 0;
}

/**
 * Commits a snapshot whose file is already in R2: the head generation moves from the one before
 * it, compared and set, in the same transaction as the row. When another publisher got there
 * first, nothing changes, and the caller learns the head it lost to. Whatever was held is
 * superseded: it's older than what just published.
 */
export async function commitSnapshot(
  db: Executor,
  snapshot: Omit<SnapshotRow, 'revision'> & { revision?: number | null },
): Promise<{ committed: true } | { committed: false; headGeneration: number }> {
  return db.transaction(async (tx) => {
    await lockDataset(tx, snapshot.datasetId);
    const moved = await tx
      .update(datasets)
      .set({ headGeneration: snapshot.generation })
      .where(
        and(
          eq(datasets.id, snapshot.datasetId),
          eq(datasets.headGeneration, snapshot.generation - 1),
        ),
      )
      .returning({ id: datasets.id });
    if (moved.length === 0) {
      return { committed: false, headGeneration: await headGenerationOf(tx, snapshot.datasetId) };
    }
    await tx.insert(snapshots).values({
      ...snapshot,
      revision: snapshot.revision ?? null,
      state: 'published',
      publishedAt: new Date(snapshot.publishedAt),
    });
    await supersedeHeld(tx, { datasetId: snapshot.datasetId, at: new Date(snapshot.publishedAt) });
    return { committed: true };
  });
}

export async function latestSnapshot(db: Executor, datasetId: string): Promise<SnapshotRow | null> {
  const [row] = await db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.datasetId, datasetId), eq(snapshots.state, 'published')))
    .orderBy(desc(snapshots.generation))
    .limit(1);
  return row === undefined ? null : toRow(row);
}

export async function getSnapshot(
  db: Executor,
  datasetId: string,
  generation: number,
): Promise<SnapshotRow | null> {
  const [row] = await db
    .select()
    .from(snapshots)
    .where(
      and(
        eq(snapshots.datasetId, datasetId),
        eq(snapshots.generation, generation),
        eq(snapshots.state, 'published'),
      ),
    );
  return row === undefined ? null : toRow(row);
}

/** The snapshot a run made, published or held, if it made one. */
export async function snapshotOfRun(db: Executor, runId: string): Promise<StoredSnapshot | null> {
  const [row] = await db.select().from(snapshots).where(eq(snapshots.runId, runId));
  return row === undefined ? null : toStored(row);
}

export async function snapshotById(db: Executor, id: string): Promise<StoredSnapshot | null> {
  const [row] = await db.select().from(snapshots).where(eq(snapshots.id, id));
  return row === undefined ? null : toStored(row);
}

/** The snapshot waiting for the owner, if one is. */
export async function heldSnapshot(
  db: Executor,
  datasetId: string,
): Promise<StoredSnapshot | null> {
  const [row] = await db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.datasetId, datasetId), eq(snapshots.state, 'held')))
    .orderBy(desc(snapshots.createdAt))
    .limit(1);
  return row === undefined ? null : toStored(row);
}

/**
 * Holds a snapshot whose file is already in R2, and asks the owner about it. Whatever the dataset
 * held before is superseded: the newest held snapshot is the only one that can be published.
 *
 * The row goes in first. A snapshot that is already stored, because the step that holds it ran
 * again or because a newer run has superseded it since, changes nothing: it must not supersede the
 * snapshot that replaced it, or ask its question again. With the dataset's row taken, only one hold
 * runs at a time, so a dataset has at most one held snapshot without a unique index to say so.
 */
export async function holdSnapshot(
  db: Executor,
  input: Omit<SnapshotRow, 'generation' | 'publishedAt' | 'revision'> & {
    revision: number;
    heldReason: string;
    at: Date;
    review: { id: string; question: Question; context: Record<string, unknown> };
  },
): Promise<void> {
  const { at, review, ...snapshot } = input;
  await db.transaction(async (tx) => {
    await lockDataset(tx, snapshot.datasetId);
    const inserted = await tx
      .insert(snapshots)
      .values({ ...snapshot, state: 'held', createdAt: at })
      .onConflictDoNothing()
      .returning({ id: snapshots.id });
    if (inserted.length === 0) return;
    await supersedeHeld(tx, { datasetId: snapshot.datasetId, keep: snapshot.id, at });
    await openReview(tx, {
      id: review.id,
      datasetId: snapshot.datasetId,
      kind: 'publication',
      subject: snapshot.id,
      question: review.question,
      context: review.context,
      at,
    });
  });
}

/**
 * Publishes a held snapshot whose final file is in R2: the head generation moves from the one
 * before it, compared and set, in the same transaction as the row and its question's answer. A
 * snapshot that isn't held any more is stale; a head that moved meanwhile is named, so the caller
 * can try the next generation.
 */
export async function publishHeld(
  db: Executor,
  input: {
    datasetId: string;
    snapshotId: string;
    generation: number;
    key: string;
    sha256: string;
    bytes: number;
    publishedAt: string;
  },
): Promise<
  | { committed: true }
  | { committed: false; headGeneration: number }
  | { stale: SnapshotState | 'missing' }
> {
  return db.transaction(async (tx) => {
    await lockDataset(tx, input.datasetId);
    const [row] = await tx
      .select({ state: snapshots.state, datasetId: snapshots.datasetId })
      .from(snapshots)
      .where(eq(snapshots.id, input.snapshotId))
      .for('update');
    if (row === undefined || row.datasetId !== input.datasetId)
      return { stale: 'missing' as const };
    if (row.state !== 'held') return { stale: row.state };
    const moved = await tx
      .update(datasets)
      .set({ headGeneration: input.generation })
      .where(
        and(eq(datasets.id, input.datasetId), eq(datasets.headGeneration, input.generation - 1)),
      )
      .returning({ id: datasets.id });
    if (moved.length === 0) {
      return {
        committed: false as const,
        headGeneration: await headGenerationOf(tx, input.datasetId),
      };
    }
    const at = new Date(input.publishedAt);
    await tx
      .update(snapshots)
      .set({
        state: 'published',
        generation: input.generation,
        key: input.key,
        sha256: input.sha256,
        bytes: input.bytes,
        publishedAt: at,
      })
      .where(eq(snapshots.id, input.snapshotId));
    await decideReviews(tx, {
      datasetId: input.datasetId,
      kind: 'publication',
      subject: input.snapshotId,
      answer: 'publish',
      at,
    });
    return { committed: true as const };
  });
}

/**
 * Discards a held snapshot, as the owner asked, and closes its question. False if it wasn't held.
 */
export async function discardHeld(
  db: Executor,
  input: { snapshotId: string; at: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // A snapshot never changes its dataset, so it can be read before the dataset's row is taken.
    const [snapshot] = await tx
      .select({ datasetId: snapshots.datasetId })
      .from(snapshots)
      .where(eq(snapshots.id, input.snapshotId));
    if (snapshot === undefined) return false;
    await lockDataset(tx, snapshot.datasetId);
    const [row] = await tx
      .update(snapshots)
      .set({ state: 'discarded' })
      .where(and(eq(snapshots.id, input.snapshotId), eq(snapshots.state, 'held')))
      .returning({ datasetId: snapshots.datasetId });
    if (row === undefined) return false;
    await decideReviews(tx, {
      datasetId: row.datasetId,
      kind: 'publication',
      subject: input.snapshotId,
      answer: 'discard',
      at: input.at,
    });
    return true;
  });
}

/**
 * Supersedes the dataset's held snapshots, but `keep`, and dismisses the questions about them: a
 * newer run's records replace theirs. Returns how many it superseded.
 */
export async function supersedeHeld(
  db: Executor,
  input: { datasetId: string; keep?: string; at: Date },
): Promise<number> {
  return db.transaction(async (tx) => {
    await lockDataset(tx, input.datasetId);
    const superseded = await tx
      .update(snapshots)
      .set({ state: 'superseded' })
      .where(
        and(
          eq(snapshots.datasetId, input.datasetId),
          eq(snapshots.state, 'held'),
          input.keep === undefined ? undefined : ne(snapshots.id, input.keep),
        ),
      )
      .returning({ id: snapshots.id });
    for (const { id } of superseded) {
      await dismissReviews(tx, {
        datasetId: input.datasetId,
        kind: 'publication',
        subject: id,
        at: input.at,
      });
    }
    return superseded.length;
  });
}

function toRow(row: typeof snapshots.$inferSelect): SnapshotRow {
  if (row.generation === null || row.publishedAt === null) {
    throw new Error(`Snapshot ${row.id} is ${row.state}, not published`);
  }
  return {
    id: row.id,
    datasetId: row.datasetId,
    generation: row.generation,
    runId: row.runId,
    revision: row.revision,
    recordCount: row.recordCount,
    recordsSha256: row.recordsSha256,
    key: row.key,
    sha256: row.sha256,
    bytes: row.bytes,
    publishedAt: row.publishedAt.toISOString(),
    report: row.report,
  };
}

function toStored(row: typeof snapshots.$inferSelect): StoredSnapshot {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}
