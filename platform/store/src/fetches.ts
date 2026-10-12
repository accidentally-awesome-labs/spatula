import type { ContentSignals, Outcome } from '@spatula/core';
import { eq, sql } from 'drizzle-orm';
import type { Executor } from './client';
import { fetches, items, type ItemStatus } from './schema';

/** Two 404s or 410s in a row make a page gone; three blocks in a row make it refused. */
export const GONE_AFTER = 2;
export const REFUSED_AFTER = 3;

/** The most code units of what the LLM step did that the fetch log keeps. */
const MAX_LLM_DETAIL = 500;

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
  /**
   * The item's extraction mark, written in this fetch's transaction. A changed page sets one that
   * isn't current, so the page is read again even if the run stops before its extract step.
   */
  extractedWith?: string;
  /**
   * What the fetch log says about the LLM step, when the fetch already knows. `recordFetch` keeps
   * only its first `MAX_LLM_DETAIL` (500) characters.
   */
  llm?: string;
}

/**
 * Logs a fetch and moves its page's streak. It writes nothing when a fetch with the same ID is
 * already logged, so a step that runs again after a crash logs its fetch once. A page is gone after
 * two 404s or 410s in a row, and refused after three blocks in a row. Only a live page can become
 * gone or refused: an excluded page keeps its status however its streak runs. A page that's gone or
 * refused leaves the live items, so it isn't fetched again until it leaves the definition and is
 * listed again. Only a fresh page moves the stored hash and validators: a failed or blocked fetch
 * leaves them, like every value, as they were.
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
    // A fetch's ID comes from its run, item, and attempt, so a step that runs again after a crash
    // logs the same fetch. It was recorded the first time, and nothing moves twice. The step that
    // runs again still returns its own answer, which may differ from the one logged the first time.
    // The item's stored hash and validators stay as the logged answer set them, so the next run
    // reads the page again if the page differs from them, and a failed fetch still never changes a
    // value. A replayed changed answer's extract step can still set the extraction mark.
    const [already] = await tx
      .select({ id: fetches.id })
      .from(fetches)
      .where(eq(fetches.id, input.id));
    if (already !== undefined) return { itemStatus: item.status };
    const streak = item.lastOutcome === input.outcome ? item.outcomeStreak + 1 : 1;
    // Only a live page can become gone or refused. An excluded page keeps its status, though its
    // streak still counts.
    const live = item.status === 'live';
    const status: ItemStatus =
      live && input.outcome === 'gone' && streak >= GONE_AFTER
        ? 'gone'
        : live && input.outcome === 'blocked' && streak >= REFUSED_AFTER
          ? 'refused'
          : item.status;
    const { page, extractedWith, llm, ...logged } = input;
    await tx.insert(fetches).values({
      ...logged,
      contentHash: page?.contentHash ?? null,
      llm: llm?.slice(0, MAX_LLM_DETAIL),
    });
    await tx
      .update(items)
      .set({
        lastOutcome: input.outcome,
        outcomeStreak: streak,
        status,
        lastFetchedAt: input.startedAt,
        // A page that was read confirms the lastmod it was listed with; one that wasn't, doesn't.
        ...(input.outcome === 'changed' || input.outcome === 'unchanged'
          ? { fetchedLastmod: sql`${items.listedLastmod}` }
          : {}),
        ...(page ?? {}),
        ...(extractedWith === undefined ? {} : { extractedWith }),
      })
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
      llm: input.llm.slice(0, MAX_LLM_DETAIL),
      llmInputTokens: input.usage.inputTokens,
      llmOutputTokens: input.usage.outputTokens,
    })
    .where(eq(fetches.id, input.fetchId));
}
