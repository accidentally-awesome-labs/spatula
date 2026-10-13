import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { noneOfThese, T } from '../test/seed';
import { createDatabase, type Executor } from './client';
import { applyDefinition, listLiveItems, reviveItems } from './datasets';
import {
  closeReview,
  findDecision,
  getReview,
  openReview,
  saveDecision,
  type NewDecision,
} from './decisions';
import { setItemStatus } from './fetches';
import { testDefinition } from './fixtures';
import { datasets, decisionRecords, items } from './schema';

/*
 * What only several connections can show. Every other test here runs in one transaction that is
 * rolled back, so nothing it does is seen by a second connection, and no commit can fall between
 * two of its statements. These tests commit, each under a dataset of its own that it deletes.
 */

const { db: pool, close } = createDatabase(inject('databaseUrl'), { max: 4 });
afterAll(close);

/** Runs `test` in a committed dataset of its own, and deletes the dataset afterwards. */
async function inDataset(name: string, test: (datasetId: string) => Promise<void>): Promise<void> {
  const datasetId = `${name}-${Date.now().toString(36)}`;
  await applyDefinition(pool, testDefinition(datasetId));
  try {
    await test(datasetId);
  } finally {
    await pool.delete(datasets).where(eq(datasets.id, datasetId));
  }
}

/**
 * A query builder that waits for `after` once its query has run, before its caller gets the rows.
 * Drizzle's builders are thenables, and their chain methods return the builder or the next one.
 */
function afterRun<B extends object>(builder: B, after: () => Promise<void>): B {
  const proxy: B = new Proxy(builder, {
    get(target, key) {
      if (key === 'then') {
        return (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) =>
          (target as unknown as PromiseLike<unknown>)
            .then(async (rows) => {
              await after();
              return rows;
            })
            .then(onFulfilled, onRejected);
      }
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result: unknown = value.apply(target, args);
        if (result === target) return proxy;
        return typeof result === 'object' && result !== null && 'then' in result
          ? afterRun(result, after)
          : result;
      };
    },
  });
  return proxy;
}

/**
 * `db`, but each transaction it opens runs `between` once, as soon as the transaction's first read
 * has returned and before it sends another statement: the moment a run can commit in the middle of
 * a revive. The statements the function under test sends are unchanged.
 */
function racing(db: Executor, between: () => Promise<void>): Executor {
  const transaction = <R>(run: (tx: Executor) => Promise<R>): Promise<R> =>
    db.transaction((tx) => {
      let fired = false;
      const once = async () => {
        if (fired) return;
        fired = true;
        await between();
      };
      return run(
        new Proxy(tx, {
          get(target, key) {
            const value: unknown = Reflect.get(target, key, target);
            if (key === 'select') {
              return (...args: unknown[]) =>
                afterRun((value as (...a: unknown[]) => object).apply(target, args), once);
            }
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      );
    });
  return { transaction } as unknown as Executor;
}

/** Resolves once `work` has finished, or once a session in this database is waiting for a lock. */
async function settledOrWaiting(work: Promise<unknown>): Promise<void> {
  let settled = false;
  void work.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let tries = 0; tries < 500 && !settled; tries += 1) {
    const [row] = await pool.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((row?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const stateOf = async (id: string) =>
  (
    await pool
      .select({ status: items.status, extractedWith: items.extractedWith })
      .from(items)
      .where(eq(items.id, id))
  )[0];

describe('reviveItems while a run commits', () => {
  it('leaves a page alone that a run made irrelevant after the revive read the pages', () =>
    inDataset('revive-race', async (datasetId) => {
      const [page] = await listLiveItems(pool, datasetId);
      await pool.update(items).set({ extractedWith: 'r1.v1' }).where(eq(items.id, page!.id));
      const none = noneOfThese(datasetId, page!.id);
      const revived = await reviveItems(
        racing(pool, async () => {
          // A run reads the page, answers "None of these", and commits, between the revive's read
          // and its write.
          await saveDecision(pool, none);
          await setItemStatus(pool, page!.id, 'irrelevant');
        }),
        { datasetId, pages: [page!.locator] },
      );
      // The page was live when the revive read it, so it is not the revive's. Reviving it now
      // would leave its answer current and its mark set, so no run would read or ask again, and
      // it could not be revived again either, being live.
      expect(revived).toBe(0);
      expect(await stateOf(page!.id)).toEqual({ status: 'irrelevant', extractedWith: 'r1.v1' });
      expect(
        await findDecision(pool, {
          datasetId,
          subjectKey: none.subjectKey,
          stateHash: none.stateHash,
          criteriaVersion: none.criteriaVersion,
        }),
      ).toMatchObject({ id: none.id });
    }));

  it('holds the pages it revives, so a page the definition drops waits and stays out', () =>
    inDataset('revive-hold', async (datasetId) => {
      const [page] = await listLiveItems(pool, datasetId);
      await pool
        .update(items)
        .set({ status: 'irrelevant', extractedWith: 'r1.v1' })
        .where(eq(items.id, page!.id));
      await saveDecision(pool, noneOfThese(datasetId, page!.id));
      let exclusion: Promise<void> = Promise.resolve();
      const revived = await reviveItems(
        racing(pool, async () => {
          // The definition drops the page just after the revive read it. Whether the exclusion
          // commits now or waits for the revive decides what the page is afterwards.
          exclusion = setItemStatus(pool, page!.id, 'excluded');
          await settledOrWaiting(exclusion);
        }),
        { datasetId, pages: [page!.locator] },
      );
      await exclusion;
      expect(revived).toBe(1);
      // The revive finished first and the exclusion came after it, so the page is out. A revive
      // that didn't hold the page would bring back a page the definition no longer lists.
      expect((await stateOf(page!.id))?.status).toBe('excluded');
    }));

  it('lets a run file a question about a page it holds, which only needs the page to stay', () =>
    inDataset('revive-refer', async (datasetId) => {
      const [page] = await listLiveItems(pool, datasetId);
      await pool
        .update(items)
        .set({ status: 'irrelevant', extractedWith: 'r1.v1' })
        .where(eq(items.id, page!.id));
      let filed = false;
      let filedWhileReviving: boolean | undefined;
      let filing: Promise<unknown> = Promise.resolve();
      await reviveItems(
        racing(pool, async () => {
          filing = openReview(pool, {
            id: 'rv_refers_to_the_page',
            datasetId,
            kind: 'classify',
            subject: page!.id,
            itemId: page!.id,
            question: noneOfThese(datasetId, page!.id).question,
            context: {},
            at: T(1),
          });
          void filing.then(
            () => (filed = true),
            () => undefined,
          );
          await settledOrWaiting(filing);
          filedWhileReviving = filed;
        }),
        { datasetId, pages: [page!.locator] },
      );
      await filing;
      // The lock a revive takes is the weaker one, which doesn't stop an insert that refers to the
      // row. If it were the stronger, the question would wait for the revive to end, and be filed
      // only after it.
      expect(filedWhileReviving).toBe(true);
    }));
});

/**
 * Two saves that overlap. The first runs in a transaction that has saved and hasn't committed; the
 * second starts on another connection, and has to wait for the first or, without a lock, finishes
 * at once. Returns what each gave back.
 */
async function overlappingSaves(first: NewDecision, second: NewDecision) {
  let firstSaved!: () => void;
  const saved = new Promise<void>((resolve) => (firstSaved = resolve));
  let firstMayCommit!: () => void;
  const mayCommit = new Promise<void>((resolve) => (firstMayCommit = resolve));
  const firstRun = pool.transaction(async (tx) => {
    const row = await saveDecision(tx, first);
    firstSaved();
    await mayCommit;
    return row;
  });
  try {
    await Promise.race([saved, firstRun]);
    const secondRun = saveDecision(pool, second);
    await settledOrWaiting(secondRun);
    firstMayCommit();
    const [gave, secondGave] = await Promise.all([firstRun, secondRun]);
    return { first: gave, second: secondGave };
  } finally {
    firstMayCommit();
    await firstRun.catch(() => undefined);
  }
}

describe('saveDecision while another run saves', () => {
  const decisionOf = (datasetId: string): NewDecision => ({
    ...noneOfThese(datasetId, 'it_overlapping'),
    id: 'dc_overlap_first00000',
    stateHash: 'hash-a',
    decidedAt: T(1),
  });
  const currentIds = async (datasetId: string) =>
    (
      await pool
        .select({ id: decisionRecords.id })
        .from(decisionRecords)
        .where(and(eq(decisionRecords.datasetId, datasetId), isNull(decisionRecords.supersededAt)))
    ).map((row) => row.id);

  it('serializes saves about one subject, so only the later one stays current', () =>
    inDataset('save-race', async (datasetId) => {
      const first = decisionOf(datasetId);
      const second = {
        ...first,
        id: 'dc_overlap_second0000',
        stateHash: 'hash-b',
        decidedAt: T(2),
      };
      await overlappingSaves(first, second);
      expect(await currentIds(datasetId)).toEqual([second.id]);
    }));

  it('gives a save of a decision that is being saved the record the first save made', () =>
    inDataset('save-twice', async (datasetId) => {
      const first = decisionOf(datasetId);
      // The same step, run twice at once: its second run must not retire or repeat the first's.
      const saves = await overlappingSaves(first, { ...first, answer: 'Headphones' });
      expect(saves.second).toEqual(saves.first);
      expect(saves.second.answer).toBe('None of these');
      expect(await currentIds(datasetId)).toEqual([first.id]);
    }));
});

describe('openReview while an answer closes the review', () => {
  it('waits for the answer when it has seen the review open, and then finds it closed', () =>
    inDataset('open-race', async (datasetId) => {
      const [page] = await listLiveItems(pool, datasetId);
      const none = noneOfThese(datasetId, page!.id);
      const ask = {
        id: 'rv_replayed_while_answered',
        datasetId,
        kind: 'classify' as const,
        subject: page!.id,
        itemId: page!.id,
        question: none.question,
        context: { proposed: 'None of these' },
        at: T(1),
      };
      await openReview(pool, ask);
      let closing: Promise<unknown> = Promise.resolve();
      // The step runs again just as a person answers: the answer commits after the step has seen
      // the review open and before it writes.
      const id = await openReview(
        racing(pool, async () => {
          closing = closeReview(pool, {
            id: ask.id,
            status: 'decided',
            answer: 'None of these',
            at: T(2),
          });
          await settledOrWaiting(closing);
        }),
        ask,
      );
      await closing;
      expect(id).toBe(ask.id);
      expect(await getReview(pool, ask.id)).toMatchObject({
        status: 'decided',
        answer: 'None of these',
      });
    }));
});
