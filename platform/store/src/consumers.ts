import { stableId } from '@spatula/core';
import { and, desc, eq } from 'drizzle-orm';
import type { Executor } from './client';
import { acknowledgments, type AckOutcome } from './schema';

/*
 * Consumers' acknowledgments (ADR 0004): which generation each consumer applied or refused, and
 * when. The Worker checks each one's signature before it gets here.
 */

export interface NewAcknowledgment {
  datasetId: string;
  consumer: string;
  generation: number;
  snapshotId: string;
  outcome: AckOutcome;
  detail: string | null;
  counts: Record<string, number> | null;
  sentAt: Date;
  receivedAt: Date;
  bodySha256: string;
}

/** Records an acknowledgment once: the same body again is a repeat, and another is a conflict. */
export async function recordAcknowledgment(
  db: Executor,
  ack: NewAcknowledgment,
): Promise<'recorded' | 'repeated' | 'conflict'> {
  const id = await stableId('ak', ack.datasetId, ack.consumer, ack.generation);
  const inserted = await db
    .insert(acknowledgments)
    .values({ id, ...ack })
    .onConflictDoNothing()
    .returning({ id: acknowledgments.id });
  if (inserted.length > 0) return 'recorded';
  const [kept] = await db
    .select({ bodySha256: acknowledgments.bodySha256 })
    .from(acknowledgments)
    .where(
      and(
        eq(acknowledgments.datasetId, ack.datasetId),
        eq(acknowledgments.consumer, ack.consumer),
        eq(acknowledgments.generation, ack.generation),
      ),
    );
  return kept?.bodySha256 === ack.bodySha256 ? 'repeated' : 'conflict';
}

/** Each consumer's latest acknowledgment of the dataset. */
export async function latestAcknowledgments(
  db: Executor,
  datasetId: string,
): Promise<{ consumer: string; generation: number; outcome: AckOutcome; receivedAt: string }[]> {
  const rows = await db
    .selectDistinctOn([acknowledgments.consumer], {
      consumer: acknowledgments.consumer,
      generation: acknowledgments.generation,
      outcome: acknowledgments.outcome,
      receivedAt: acknowledgments.receivedAt,
    })
    .from(acknowledgments)
    .where(eq(acknowledgments.datasetId, datasetId))
    .orderBy(acknowledgments.consumer, desc(acknowledgments.generation));
  return rows.map((row) => ({ ...row, receivedAt: row.receivedAt.toISOString() }));
}
