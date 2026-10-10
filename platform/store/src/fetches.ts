import type { ContentSignals, Outcome } from '@spatula/core';
import { eq } from 'drizzle-orm';
import type { Executor } from './client';
import { fetches, items, type ItemStatus } from './schema';

/** Two 404s or 410s in a row make a page gone; three blocks in a row make it refused. */
export const GONE_AFTER = 2;
export const REFUSED_AFTER = 3;

export interface FetchInput {
  id: string;
  runId: string;
  itemId: string;
  url: string;
  finalUrl: string | null;
  policy: 'allowed' | 'denied';
  policyReason: string | null;
  /** How the page was fetched: `http` in slice 0. */
  method: string;
  outcome: Outcome;
  httpStatus: number | null;
  bytes: number | null;
  signals: ContentSignals | null;
  startedAt: Date;
  durationMs: number;
  error: string | null;
  /** A full page's hash and validators. Absent when no page arrived, as after a 304 or a failure. */
  page?: { contentHash: string; etag: string | null; lastModified: string | null };
}

/**
 * Logs a fetch and moves its page's streak. A page is gone after two 404s or 410s in a row, and
 * refused after three blocks in a row. A page that's gone or refused leaves the live items, so it
 * isn't fetched again until it leaves the definition and is listed again. Only a fresh page moves
 * the stored hash and validators: a failed or blocked fetch leaves them, like every value, as they
 * were.
 */
export async function recordFetch(
  db: Executor,
  input: FetchInput,
): Promise<{ itemStatus: ItemStatus }> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({
        status: items.status,
        lastOutcome: items.lastOutcome,
        outcomeStreak: items.outcomeStreak,
      })
      .from(items)
      .where(eq(items.id, input.itemId))
      .for('update');
    if (item === undefined) throw new Error(`Item ${input.itemId} doesn't exist`);
    const streak = item.lastOutcome === input.outcome ? item.outcomeStreak + 1 : 1;
    const status: ItemStatus =
      input.outcome === 'gone' && streak >= GONE_AFTER
        ? 'gone'
        : input.outcome === 'blocked' && streak >= REFUSED_AFTER
          ? 'refused'
          : item.status;
    const { page, ...logged } = input;
    await tx.insert(fetches).values({ ...logged, contentHash: page?.contentHash ?? null });
    await tx
      .update(items)
      .set({ lastOutcome: input.outcome, outcomeStreak: streak, status, ...(page ?? {}) })
      .where(eq(items.id, input.itemId));
    return { itemStatus: status };
  });
}

/**
 * Notes which definition revision and extraction version the item's statements came from, and
 * what the LLM step did and cost. Leaving out `extractInputHash` keeps the stored one; null
 * clears it, so the LLM is asked again next time.
 */
export async function recordExtraction(
  db: Executor,
  input: {
    itemId: string;
    fetchId: string;
    extractedWith: string;
    extractInputHash?: string | null;
    llm: string;
    usage: { inputTokens: number; outputTokens: number };
  },
): Promise<void> {
  await db
    .update(items)
    .set({
      extractedWith: input.extractedWith,
      ...(input.extractInputHash === undefined ? {} : { extractInputHash: input.extractInputHash }),
    })
    .where(eq(items.id, input.itemId));
  await db
    .update(fetches)
    .set({
      llm: input.llm.slice(0, 500),
      llmInputTokens: input.usage.inputTokens,
      llmOutputTokens: input.usage.outputTokens,
    })
    .where(eq(fetches.id, input.fetchId));
}
