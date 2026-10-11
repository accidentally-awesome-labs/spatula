import type { Excluded } from '@spatula/core';
import { and, desc, eq } from 'drizzle-orm';
import type { Executor } from './client';
import { datasets, snapshots } from './schema';

/** A published snapshot. The file is in R2 under `key`. */
export interface SnapshotRow {
  id: string;
  datasetId: string;
  generation: number;
  runId: string | null;
  recordCount: number;
  /** The hash of the records alone, to tell whether anything changed since the last snapshot. */
  recordsSha256: string;
  key: string;
  /** The hash of the whole file, which readers check. */
  sha256: string;
  bytes: number;
  publishedAt: string;
  report: { excluded: Excluded[] };
}

/**
 * Commits a snapshot whose file is already in R2: the head generation moves from the one before
 * it, compared and set, in the same transaction as the row. When another publisher got there
 * first, nothing changes, and the caller learns the head it lost to.
 */
export async function commitSnapshot(
  db: Executor,
  snapshot: SnapshotRow,
): Promise<{ committed: true } | { committed: false; headGeneration: number }> {
  return db.transaction(async (tx) => {
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
      const [dataset] = await tx
        .select({ headGeneration: datasets.headGeneration })
        .from(datasets)
        .where(eq(datasets.id, snapshot.datasetId));
      return { committed: false, headGeneration: dataset?.headGeneration ?? 0 };
    }
    await tx.insert(snapshots).values({ ...snapshot, publishedAt: new Date(snapshot.publishedAt) });
    return { committed: true };
  });
}

export async function latestSnapshot(db: Executor, datasetId: string): Promise<SnapshotRow | null> {
  const [row] = await db
    .select()
    .from(snapshots)
    .where(eq(snapshots.datasetId, datasetId))
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
    .where(and(eq(snapshots.datasetId, datasetId), eq(snapshots.generation, generation)));
  return row === undefined ? null : toRow(row);
}

function toRow(row: typeof snapshots.$inferSelect): SnapshotRow {
  return { ...row, publishedAt: row.publishedAt.toISOString() };
}
