import type { RunSummary, RunView } from '@spatula/core';
import { eq } from 'drizzle-orm';
import type { Executor } from './client';
import { runs } from './schema';

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
    .where(eq(runs.id, id));
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
