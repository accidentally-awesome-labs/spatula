import type { RunSummary, RunView } from '@spatula/core';
import { and, desc, eq, gt, ne } from 'drizzle-orm';
import type { Executor } from './client';
import { runs } from './schema';
import { lockDataset } from './snapshots';

/**
 * A run still marked running this long after it started is taken as dead, so it can't hold its
 * dataset for good.
 */
export const RUN_STALE_MS = 6 * 60 * 60 * 1000;

/** Starts a run, unless one with this ID exists: then it's returned, and `created` is false. */
export async function startRun(
  db: Executor,
  run: { id: string; datasetId: string },
): Promise<{ created: boolean; run: RunView }> {
  const inserted = await db
    .insert(runs)
    .values({ id: run.id, datasetId: run.datasetId, status: 'running' })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0] ?? (await db.select().from(runs).where(eq(runs.id, run.id)))[0];
  if (row === undefined) throw new Error(`Run ${run.id} could not be started or found`);
  return { created: inserted.length > 0, run: toView(row) };
}

/**
 * Starts a run unless another run of the dataset is going: then that run is returned, as `running`,
 * and nothing is recorded. A run is going while its row says `running` and it started less than
 * RUN_STALE_MS before `at`. A run with the same ID isn't another: it's this one asked for again,
 * and `startRun` finds it. The dataset's row is taken first, as every change to its snapshots
 * takes it, so two starts at once go one at a time, and the second looks only after the first has
 * committed.
 */
export async function startRunAlone(
  db: Executor,
  run: { id: string; datasetId: string; at: Date },
): Promise<{ created: boolean; run: RunView } | { running: RunView }> {
  return db.transaction(async (tx) => {
    await lockDataset(tx, run.datasetId);
    const [going] = await tx
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.datasetId, run.datasetId),
          ne(runs.id, run.id),
          eq(runs.status, 'running'),
          gt(runs.startedAt, new Date(run.at.getTime() - RUN_STALE_MS)),
        ),
      )
      .orderBy(desc(runs.startedAt))
      .limit(1);
    if (going !== undefined) return { running: toView(going) };
    return startRun(tx, { id: run.id, datasetId: run.datasetId });
  });
}

/**
 * Records how a run ended. A run finishes once: only a row that is still `running` changes, so a
 * result that comes late, such as a Workflow completing a run that a start of the next one had
 * already recorded as lost, can't overwrite the first.
 */
export async function finishRun(
  db: Executor,
  id: string,
  result: { status: 'complete'; summary: RunSummary } | { status: 'failed'; error: string },
): Promise<void> {
  const finishedAt = new Date();
  await db
    .update(runs)
    .set(
      result.status === 'complete'
        ? { status: 'complete', summary: result.summary, finishedAt }
        : { status: 'failed', error: result.error.slice(0, 2000), finishedAt },
    )
    .where(and(eq(runs.id, id), eq(runs.status, 'running')));
}

export async function getRun(db: Executor, id: string): Promise<RunView | null> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id));
  return row === undefined ? null : toView(row);
}

function toView(row: typeof runs.$inferSelect): RunView {
  return {
    id: row.id,
    datasetId: row.datasetId,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    summary: row.summary ?? null,
    error: row.error ?? null,
  };
}
