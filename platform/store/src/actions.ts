import { newId, type ActorRecord, type ReviewAction, type ReviewActionKind } from '@spatula/core';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Executor } from './client';
import { reviewActions } from './schema';

/*
 * The review log (ADR 0009): every write through the review API, and each change Spatula applies to
 * a taxonomy on its own (ruling 14), with who made it. A run's ordinary decisions stay in their
 * decision records. Rows are only ever added.
 */

/** The most writes a page of the log holds, beside the rest of its last moment. */
export const MAX_ACTIONS = 500;

/** Records a write. Returns its ID. */
export async function logAction(
  db: Executor,
  input: {
    datasetId: string;
    action: ReviewActionKind;
    subject: string;
    actor: ActorRecord;
    detail: Record<string, unknown>;
    at: Date;
  },
): Promise<string> {
  const id = newId('ra');
  await db.insert(reviewActions).values({ id, ...input });
  return id;
}

/**
 * The log, newest first: `limit` writes (100 unless asked, at most MAX_ACTIONS) from before
 * `before`. A page never splits a moment: the writes made at the same time as its last one are all
 * on it, so the next page, from before that time, misses none.
 */
export async function listActions(
  db: Executor,
  datasetId: string,
  options: { limit?: number; before?: Date } = {},
): Promise<ReviewAction[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), MAX_ACTIONS);
  const scope = () =>
    and(
      eq(reviewActions.datasetId, datasetId),
      options.before === undefined ? undefined : lt(reviewActions.at, options.before),
    );
  const rows = await db
    .select()
    .from(reviewActions)
    .where(scope())
    .orderBy(desc(reviewActions.at), desc(reviewActions.id))
    .limit(limit);
  const last = rows.at(-1);
  if (last !== undefined && rows.length === limit) {
    rows.push(
      ...(await db
        .select()
        .from(reviewActions)
        .where(and(scope(), eq(reviewActions.at, last.at), lt(reviewActions.id, last.id)))
        .orderBy(desc(reviewActions.id))),
    );
  }
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    subject: row.subject,
    actor: row.actor,
    detail: row.detail,
    at: row.at.toISOString(),
  }));
}
