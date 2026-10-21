import type { ContentSignals, Outcome } from '@spatula/core';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Executor } from './client';
import { fetches, items, type ItemStatus } from './schema';

/** Two 404s or 410s in a row make a page gone; three blocks in a row make it refused. */
export const GONE_AFTER = 2;
export const REFUSED_AFTER = 3;

/** The most code units of what the LLM step did that the fetch log keeps. */
const MAX_LLM_DETAIL = 500;
/** The longest ETag or Last-Modified kept: a host chooses them, and a step's result is capped. */
const MAX_VALIDATOR = 512;

/**
 * A validator as it's kept. One that's too long is dropped, not cut: a cut validator would
 * revalidate wrongly.
 */
function keptValidator(validator: string | null): string | null {
  return validator !== null && validator.length > MAX_VALIDATOR ? null : validator;
}

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
 * refused leaves the live items, so it isn't fetched again. A definition's own page comes back when
 * it leaves the definition and is listed again; a sitemap page that went after 404s stays gone
 * while its sitemap still lists it. Every fetch notes when its page was asked for
 * (`lastFetchedAt`), and one that read the page, `changed` or `unchanged`, notes the lastmod the
 * page was listed with (`fetchedLastmod`). Only a fresh page moves the stored hash and validators:
 * a failed or blocked fetch leaves them, like every value, as they were. A validator longer than
 * `MAX_VALIDATOR` (512) characters is stored as null.
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
        ...(page === undefined
          ? {}
          : {
              ...page,
              etag: keptValidator(page.etag),
              lastModified: keptValidator(page.lastModified),
            }),
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
    /**
     * The fetch whose log says what the LLM step did. Null for a page read again from its capture
     * (ADR 0008), which no fetch brought: its last fetch's log stays as it was.
     */
    fetchId: string | null;
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
  if (input.fetchId === null) return;
  await db
    .update(fetches)
    .set({
      llm: input.llm.slice(0, MAX_LLM_DETAIL),
      llmInputTokens: input.usage.inputTokens,
      llmOutputTokens: input.usage.outputTokens,
    })
    .where(eq(fetches.id, input.fetchId));
}

/**
 * The item's latest fetch, which a person's answer is recorded against. Of fetches that started
 * together, the one with the greater ID.
 */
export async function latestFetchId(db: Executor, itemId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: fetches.id })
    .from(fetches)
    .where(eq(fetches.itemId, itemId))
    .orderBy(desc(fetches.startedAt), desc(fetches.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The item's latest fetch that read its page, changed or unchanged, with the signals its site gave
 * and where it ended up: what a page read again from its capture counts as (ADR 0008). Of fetches
 * that started together, the one with the greater ID.
 */
export async function latestRead(
  db: Executor,
  itemId: string,
): Promise<{
  id: string;
  startedAt: Date;
  signals: ContentSignals | null;
  finalUrl: string | null;
} | null> {
  const [row] = await db
    .select({
      id: fetches.id,
      startedAt: fetches.startedAt,
      signals: fetches.signals,
      finalUrl: fetches.finalUrl,
    })
    .from(fetches)
    .where(and(eq(fetches.itemId, itemId), inArray(fetches.outcome, ['changed', 'unchanged'])))
    .orderBy(desc(fetches.startedAt), desc(fetches.id))
    .limit(1);
  return row ?? null;
}

/** Sets an item's status, as a decision does when it finds a page isn't one of the dataset's. */
export async function setItemStatus(
  db: Executor,
  itemId: string,
  status: ItemStatus,
): Promise<void> {
  await db.update(items).set({ status }).where(eq(items.id, itemId));
}

/**
 * Brings back a page a decision took out, when a person now places it (ADR 0007). A page that left
 * for another reason, gone or refused, stays as it is. Returns whether it came back.
 */
export async function liveIfIrrelevant(db: Executor, itemId: string): Promise<boolean> {
  const rows = await db
    .update(items)
    .set({ status: 'live' })
    .where(and(eq(items.id, itemId), eq(items.status, 'irrelevant')))
    .returning({ id: items.id });
  return rows.length > 0;
}

/**
 * Marks which code an item's statements came from, as a step does that reads a page without a
 * fetch of its own. The retry tag has the next run read the page again.
 */
export async function setExtractedWith(
  db: Executor,
  itemId: string,
  extractedWith: string,
): Promise<void> {
  await db.update(items).set({ extractedWith }).where(eq(items.id, itemId));
}

/** Whether a fetch's signals say its site refuses AI input. */
const refusesAiInput = (signals: ContentSignals | null) => signals?.['ai-input'] === 'no';

/**
 * Whether the latest fetch of any of these pages found its site saying ai-input=no. A question
 * that shows a decider what pages said needs every one of their sites' consent. Of fetches that
 * started together, the latest is the one with the greater ID, as `latestFetchId` has it, so a tie
 * is never left to the database.
 */
export async function anyRefusesAiInput(
  db: Executor,
  itemIds: readonly string[],
): Promise<boolean> {
  if (itemIds.length === 0) return false;
  const latest = await db
    .selectDistinctOn([fetches.itemId], { signals: fetches.signals })
    .from(fetches)
    .where(and(inArray(fetches.itemId, [...itemIds]), isNotNull(fetches.signals)))
    .orderBy(fetches.itemId, desc(fetches.startedAt), desc(fetches.id));
  return latest.some((row) => refusesAiInput(row.signals));
}

/**
 * The dataset's pages whose latest fetch found their site saying ai-input=no, as
 * `anyRefusesAiInput` reads it for any of them: what a lineup shows of a record needs the consent
 * of every page that record has.
 */
export async function pagesRefusingAiInput(db: Executor, datasetId: string): Promise<Set<string>> {
  const latest = await db
    .selectDistinctOn([fetches.itemId], { itemId: fetches.itemId, signals: fetches.signals })
    .from(fetches)
    .innerJoin(items, eq(items.id, fetches.itemId))
    .where(and(eq(items.datasetId, datasetId), isNotNull(fetches.signals)))
    .orderBy(fetches.itemId, desc(fetches.startedAt), desc(fetches.id));
  return new Set(
    latest.flatMap((row) =>
      row.itemId !== null && refusesAiInput(row.signals) ? [row.itemId] : [],
    ),
  );
}
