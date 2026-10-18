import { newId, type EvalScores, type EvalView } from '@spatula/core';
import { desc, eq } from 'drizzle-orm';
import type { Executor } from './client';
import { evals } from './schema';

/** Keeps a score against the golden set. */
export async function saveEval(
  db: Executor,
  input: {
    datasetId: string;
    generation: number;
    goldenVersion: number;
    scores: EvalScores;
    at: Date;
  },
): Promise<EvalView> {
  const { at, ...score } = input;
  const [row] = await db
    .insert(evals)
    .values({ id: newId('ev'), ...score, createdAt: at })
    .returning();
  if (row === undefined) throw new Error('The score could not be saved');
  return viewOf(row);
}

/** The dataset's scores, newest first: at most 50. */
export async function listEvals(db: Executor, datasetId: string): Promise<EvalView[]> {
  const rows = await db
    .select()
    .from(evals)
    .where(eq(evals.datasetId, datasetId))
    .orderBy(desc(evals.createdAt), desc(evals.id))
    .limit(50);
  return rows.map(viewOf);
}

function viewOf(row: typeof evals.$inferSelect): EvalView {
  return {
    id: row.id,
    generation: row.generation,
    goldenVersion: row.goldenVersion,
    scores: row.scores,
    createdAt: row.createdAt.toISOString(),
  };
}
