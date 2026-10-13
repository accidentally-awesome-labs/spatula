import { newId, type PagesSource } from '@spatula/core';
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { fetchOf, seedDataset, T } from '../test/seed';
import type { Executor } from './client';
import { applyDefinition, listLiveItems, type ItemRef } from './datasets';
import {
  latestFetchId,
  recordExtraction,
  recordFetch,
  setExtractedWith,
  setItemStatus,
  type FetchInput,
} from './fetches';
import { testDefinition } from './fixtures';
import { fetches, items } from './schema';

function attempt(runId: string, item: ItemRef, overrides: Partial<FetchInput>): FetchInput {
  return {
    id: newId('fe'),
    runId,
    itemId: item.id,
    url: item.locator,
    finalUrl: null,
    policy: 'allowed',
    policyReason: null,
    method: 'http',
    outcome: 'failed',
    httpStatus: null,
    bytes: null,
    signals: null,
    startedAt: T(1),
    durationMs: 50,
    error: null,
    ...overrides,
  };
}

const itemRow = async (db: Executor, id: string) =>
  (await db.select().from(items).where(eq(items.id, id)))[0]!;

describe('recordFetch', () => {
  it('logs a fetch, and keeps a fresh page’s hash and validators', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const fetch = attempt(runId, a1!, {
        outcome: 'changed',
        httpStatus: 200,
        finalUrl: a1!.locator,
        bytes: 2048,
        signals: { search: 'yes' },
        page: { contentHash: 'h1', etag: '"v1"', lastModified: 'Fri, 09 Oct 2026 10:00:00 GMT' },
      });
      expect(await recordFetch(db, fetch)).toEqual({ itemStatus: 'live' });
      expect((await listLiveItems(db, 'test-products'))[0]).toMatchObject({
        contentHash: 'h1',
        etag: '"v1"',
        lastModified: 'Fri, 09 Oct 2026 10:00:00 GMT',
      });
      const [logged] = await db.select().from(fetches).where(eq(fetches.id, fetch.id));
      expect(logged).toMatchObject({
        outcome: 'changed',
        contentHash: 'h1',
        bytes: 2048,
        signals: { search: 'yes' },
      });
    }));

  it('keeps the stored page when a fetch fails or is blocked', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      await recordFetch(
        db,
        attempt(runId, a1!, {
          outcome: 'changed',
          page: { contentHash: 'h1', etag: null, lastModified: null },
        }),
      );
      await recordFetch(
        db,
        attempt(runId, a1!, { outcome: 'failed', httpStatus: 503, error: 'HTTP 503' }),
      );
      await recordFetch(
        db,
        attempt(runId, a1!, {
          outcome: 'blocked',
          policy: 'denied',
          policyReason: 'robots.txt disallows /products/a1',
        }),
      );
      expect(await itemRow(db, a1!.id)).toMatchObject({
        status: 'live',
        contentHash: 'h1',
        lastOutcome: 'blocked',
        outcomeStreak: 1,
      });
    }));

  it('calls a page gone after two 404s in a row, and only in a row', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const gone = () => attempt(runId, a1!, { outcome: 'gone', httpStatus: 404 });
      expect(await recordFetch(db, gone())).toEqual({ itemStatus: 'live' });
      await recordFetch(db, attempt(runId, a1!, { outcome: 'failed', httpStatus: 503 }));
      expect(await recordFetch(db, gone())).toEqual({ itemStatus: 'live' });
      expect(await recordFetch(db, gone())).toEqual({ itemStatus: 'gone' });
      expect((await listLiveItems(db, 'test-products')).map((item) => item.id)).not.toContain(
        a1!.id,
      );
    }));

  it('calls a page refused after three blocks in a row', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const blocked = () => attempt(runId, a1!, { outcome: 'blocked', httpStatus: 403 });
      await recordFetch(db, blocked());
      await recordFetch(db, blocked());
      expect(await recordFetch(db, blocked())).toEqual({ itemStatus: 'refused' });
    }));

  it('keeps a page the definition no longer lists excluded, however its streak runs', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
        runId,
      } = await seedDataset(db);
      // Leaving a1 out of the definition excludes it.
      const full = testDefinition();
      await applyDefinition(db, {
        ...full,
        sources: [{ ...(full.sources[0] as PagesSource), pages: [a2!.locator] }, full.sources[1]!],
      });
      const gone = () => attempt(runId, a1!, { outcome: 'gone', httpStatus: 404 });
      expect(await recordFetch(db, gone())).toEqual({ itemStatus: 'excluded' });
      expect(await recordFetch(db, gone())).toEqual({ itemStatus: 'excluded' });
      expect(await itemRow(db, a1!.id)).toMatchObject({
        status: 'excluded',
        lastOutcome: 'gone',
        outcomeStreak: 2,
      });
    }));

  it('writes a fetch once, however often its step runs again', () =>
    withRollback(async (tx) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(tx);
      const input = {
        id: 'fe_replayed00000000000000',
        runId,
        itemId: a1!.id,
        url: a1!.locator,
        finalUrl: a1!.locator,
        policy: 'allowed' as const,
        policyReason: null,
        method: 'http',
        outcome: 'blocked' as const,
        httpStatus: 403,
        bytes: null,
        signals: {},
        startedAt: T(1),
        durationMs: 100,
        error: 'HTTP 403',
      };
      await recordFetch(tx, input);
      await recordFetch(tx, input);
      await recordFetch(tx, input);
      const [logged] = await tx
        .select({ n: count() })
        .from(fetches)
        .where(eq(fetches.id, input.id));
      expect(logged!.n).toBe(1);
      const [item] = await tx
        .select({ streak: items.outcomeStreak, status: items.status })
        .from(items)
        .where(eq(items.id, a1!.id));
      // Three replays of one block are one block, not the three that would refuse the page.
      expect(item).toEqual({ streak: 1, status: 'live' });
    }));

  it('marks a changed page’s statements as not current in the fetch’s own transaction', () =>
    withRollback(async (tx) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(tx);
      await recordFetch(tx, {
        id: 'fe_changedpage00000000000',
        runId,
        itemId: a1!.id,
        url: a1!.locator,
        finalUrl: a1!.locator,
        policy: 'allowed',
        policyReason: null,
        method: 'http',
        outcome: 'changed',
        httpStatus: 200,
        bytes: 10,
        signals: {},
        startedAt: T(2),
        durationMs: 100,
        error: null,
        page: { contentHash: 'hash-new', etag: null, lastModified: null },
        extractedWith: 'r1.v1.retry',
        llm: 'skipped: not read yet',
      });
      const [item] = await tx
        .select({ extractedWith: items.extractedWith, contentHash: items.contentHash })
        .from(items)
        .where(eq(items.id, a1!.id));
      expect(item).toEqual({ extractedWith: 'r1.v1.retry', contentHash: 'hash-new' });
      const [fetch] = await tx
        .select({ llm: fetches.llm })
        .from(fetches)
        .where(eq(fetches.id, 'fe_changedpage00000000000'));
      expect(fetch!.llm).toBe('skipped: not read yet');
    }));

  it('keeps at most 500 characters of what it says about the LLM step', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const fetch = attempt(runId, a1!, { llm: `${'a'.repeat(500)}${'b'.repeat(100)}` });
      await recordFetch(db, fetch);
      const [logged] = await db.select().from(fetches).where(eq(fetches.id, fetch.id));
      expect(logged!.llm).toBe('a'.repeat(500));
    }));

  it('keeps an ETag or Last-Modified of 512 characters, and stores a longer one as null', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const stored = async (page: { contentHash: string; etag: string; lastModified: string }) => {
        await recordFetch(db, attempt(runId, a1!, { outcome: 'changed', page }));
        const { contentHash, etag, lastModified } = await itemRow(db, a1!.id);
        return { contentHash, etag, lastModified };
      };
      const fits = 'x'.repeat(512);
      const tooLong = 'x'.repeat(513);

      expect(await stored({ contentHash: 'h1', etag: fits, lastModified: fits })).toEqual({
        contentHash: 'h1',
        etag: fits,
        lastModified: fits,
      });
      // A longer one is dropped, never cut: a cut validator would revalidate wrongly. The page is
      // stored all the same, and the other validator is judged on its own.
      expect(await stored({ contentHash: 'h2', etag: tooLong, lastModified: fits })).toEqual({
        contentHash: 'h2',
        etag: null,
        lastModified: fits,
      });
      expect(await stored({ contentHash: 'h3', etag: fits, lastModified: tooLong })).toEqual({
        contentHash: 'h3',
        etag: fits,
        lastModified: null,
      });
    }));
});

describe('recordExtraction', () => {
  it('notes what the statements came from, and what the LLM cost', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const fetch = attempt(runId, a1!, {
        outcome: 'changed',
        page: { contentHash: 'h1', etag: null, lastModified: null },
      });
      await recordFetch(db, fetch);
      await recordExtraction(db, {
        itemId: a1!.id,
        fetchId: fetch.id,
        extractedWith: 'r1.v1',
        extractInputHash: 'llm-hash',
        llm: 'ran',
        usage: { inputTokens: 1200, outputTokens: 80 },
      });
      expect(await itemRow(db, a1!.id)).toMatchObject({
        extractedWith: 'r1.v1',
        extractInputHash: 'llm-hash',
      });
      const [logged] = await db.select().from(fetches).where(eq(fetches.id, fetch.id));
      expect(logged).toMatchObject({ llm: 'ran', llmInputTokens: 1200, llmOutputTokens: 80 });

      // Leaving the hash out keeps it; null clears it.
      await recordExtraction(db, {
        itemId: a1!.id,
        fetchId: fetch.id,
        extractedWith: 'r1.v1',
        llm: 'skipped: no LLM is configured',
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      expect((await itemRow(db, a1!.id)).extractInputHash).toBe('llm-hash');
      await recordExtraction(db, {
        itemId: a1!.id,
        fetchId: fetch.id,
        extractedWith: 'r1.v1',
        extractInputHash: null,
        llm: 'skipped: the site says ai-input=no',
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      expect((await itemRow(db, a1!.id)).extractInputHash).toBeNull();
    }));

  it('keeps at most 500 characters of what the LLM step did, as recordFetch does', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const fetch = attempt(runId, a1!, {});
      await recordFetch(db, fetch);
      await recordExtraction(db, {
        itemId: a1!.id,
        fetchId: fetch.id,
        extractedWith: 'r1.v1',
        llm: `${'a'.repeat(500)}${'b'.repeat(100)}`,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      const [logged] = await db.select().from(fetches).where(eq(fetches.id, fetch.id));
      expect(logged!.llm).toBe('a'.repeat(500));
    }));
});

describe('latestFetchId', () => {
  it('names the item’s newest fetch, and none for an item never fetched', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
        runId,
      } = await seedDataset(db);
      expect(await latestFetchId(db, a1!.id)).toBeNull();
      const older = await fetchOf(db, runId, a1!, T(1));
      const newer = await fetchOf(db, runId, a1!, T(2));
      // Another item's fetch is never this item's, however recent.
      const other = await fetchOf(db, runId, a2!, T(3));
      expect(older).not.toBe(newer);
      expect(await latestFetchId(db, a1!.id)).toBe(newer);
      expect(await latestFetchId(db, a2!.id)).toBe(other);
    }));

  it('breaks a tie between fetches that started together by the greater ID', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
        runId,
      } = await seedDataset(db);
      const startedTogether = async (item: ItemRef, ids: string[]) => {
        for (const id of ids) await recordFetch(db, attempt(runId, item, { id, startedAt: T(1) }));
      };
      // Whichever was logged first, the greater ID is the latest: a tie is never left to the database.
      await startedTogether(a1!, ['fe_tie_a', 'fe_tie_b']);
      await startedTogether(a2!, ['fe_tie_d', 'fe_tie_c']);
      expect(await latestFetchId(db, a1!.id)).toBe('fe_tie_b');
      expect(await latestFetchId(db, a2!.id)).toBe('fe_tie_d');
    }));
});

describe('setItemStatus', () => {
  it('sets one item’s status, which takes an irrelevant page out of the live items', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
      } = await seedDataset(db);
      await setItemStatus(db, a1!.id, 'irrelevant');
      expect((await itemRow(db, a1!.id)).status).toBe('irrelevant');
      expect((await itemRow(db, a2!.id)).status).toBe('live');
      expect((await listLiveItems(db, 'test-products')).map((item) => item.id)).not.toContain(
        a1!.id,
      );
    }));
});

describe('setExtractedWith', () => {
  it('marks one item’s statements as from other code, and changes nothing else', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
        runId,
      } = await seedDataset(db);
      await fetchOf(db, runId, a1!, T(1));
      await recordExtraction(db, {
        itemId: a1!.id,
        fetchId: (await latestFetchId(db, a1!.id))!,
        extractedWith: 'r1.v2',
        extractInputHash: 'hash-1',
        llm: 'ran',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const before = await itemRow(db, a1!.id);
      await setExtractedWith(db, a1!.id, 'r1.v2.retry');
      expect(await itemRow(db, a1!.id)).toEqual({ ...before, extractedWith: 'r1.v2.retry' });
      expect((await itemRow(db, a2!.id)).extractedWith).toBeNull();
      // Written again, it says what it said before, which a step that runs again does.
      await setExtractedWith(db, a1!.id, 'r1.v2');
      await setExtractedWith(db, a1!.id, 'r1.v2');
      expect((await itemRow(db, a1!.id)).extractedWith).toBe('r1.v2');
    }));
});
