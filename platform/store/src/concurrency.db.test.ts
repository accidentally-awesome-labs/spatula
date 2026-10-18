import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { noneOfThese, T } from '../test/seed';
import { createDatabase, type Executor } from './client';
import { applyDefinition, listLiveItems, reviveItems } from './datasets';
import {
  closeReview,
  findDecision,
  getReview,
  lockPageVerdicts,
  openReview,
  saveDecision,
  type NewDecision,
} from './decisions';
import { setItemStatus } from './fetches';
import { testDefinition } from './fixtures';
import { startRun, startRunAlone } from './runs';
import { datasets, decisionRecords, items, runs, snapshots } from './schema';
import {
  commitSnapshot,
  discardHeld,
  headGenerationOf,
  holdSnapshot,
  publishHeld,
  snapshotById,
  supersedeHeld,
  unlessNewerRun,
} from './snapshots';

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

/**
 * Resolves once `work` has finished, or once another client's session in this database is waiting
 * for a lock. Postgres's own background workers, such as autovacuum, can wait for locks too, and
 * aren't the work the test is waiting on.
 */
async function settledOrWaiting(work: Promise<unknown>): Promise<void> {
  let settled = false;
  void work.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let tries = 0; tries < 500 && !settled; tries += 1) {
    const [row] = await pool.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and backend_type = 'client backend' and pid <> pg_backend_pid()`,
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

/** A snapshot held for the owner's review, in a dataset these tests made. */
const heldIn = (datasetId: string, id: string, at: Date) => ({
  id,
  datasetId,
  runId: null,
  revision: 1,
  recordCount: 3,
  recordsSha256: `records-${id}`,
  key: `datasets/${datasetId}/held/${id}.json`,
  sha256: `file-${id}`,
  bytes: 100,
  heldReason: 'it’s the dataset’s first publication',
  report: { excluded: [] },
  at,
  review: {
    id: `rv_${id}`,
    question: {
      type: 'choice' as const,
      prompt: 'Publish this held snapshot?',
      options: ['publish', 'discard'],
    },
    context: { snapshotId: id },
  },
});

/** A snapshot a run publishes itself, at a generation. */
const directIn = (datasetId: string, generation: number) => ({
  id: `sn_direct_${generation}`,
  datasetId,
  generation,
  runId: null,
  revision: 1,
  recordCount: 3,
  recordsSha256: `direct-${generation}`,
  key: `datasets/${datasetId}/snapshots/direct-${generation}.json`,
  sha256: `direct-${generation}`,
  bytes: 100,
  publishedAt: T(10 + generation).toISOString(),
  report: { excluded: [] },
});

/** The owner's publication of a held snapshot, once its final file is written. */
const publishing = (datasetId: string, snapshotId: string, generation: number) => ({
  datasetId,
  snapshotId,
  generation,
  key: `datasets/${datasetId}/snapshots/${snapshotId}.json`,
  sha256: 'final',
  bytes: 120,
  publishedAt: T(20).toISOString(),
});

/**
 * A session that holds a row until it's let go, as a change to a snapshot's state does. `lock` is
 * the session's first statement, so it has the row by the time this returns.
 */
async function holdingRow(lock: (tx: Executor) => PromiseLike<unknown>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let taken!: () => void;
  const locked = new Promise<void>((resolve) => (taken = resolve));
  const session = pool.transaction(async (tx) => {
    await lock(tx);
    taken();
    await released;
  });
  await Promise.race([locked, session]);
  return { release, done: session };
}

const holdingSnapshot = (snapshotId: string) =>
  holdingRow((tx) =>
    tx
      .select({ id: snapshots.id })
      .from(snapshots)
      .where(eq(snapshots.id, snapshotId))
      .for('update'),
  );

const holdingDataset = (datasetId: string) =>
  holdingRow((tx) =>
    tx
      .select({ id: datasets.id })
      .from(datasets)
      .where(eq(datasets.id, datasetId))
      .for('no key update'),
  );

/**
 * How many rows the sessions waiting for a lock have written or locked in the tables of snapshots
 * and of questions. A session that has only read them, or taken the dataset's row, has none.
 */
async function writtenWhileWaiting(): Promise<number> {
  const [row] = await pool.execute<{ n: number }>(
    sql`select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid where a.datname = current_database() and a.wait_event_type = 'Lock' and a.backend_type = 'client backend' and l.granted and l.locktype = 'relation' and l.relation in ('snapshots'::regclass, 'review_items'::regclass) and l.mode in ('RowExclusiveLock', 'RowShareLock')`,
  );
  return row?.n ?? 0;
}

/** Whether another session holds the dataset's row: a lock that mustn't wait finds it taken. */
async function datasetRowIsTaken(datasetId: string): Promise<boolean> {
  try {
    await pool.transaction(async (tx) => {
      await tx
        .select({ id: datasets.id })
        .from(datasets)
        .where(eq(datasets.id, datasetId))
        .for('no key update', { noWait: true });
    });
    return false;
  } catch (error) {
    // 55P03: the lock was not available.
    const code = (error as { code?: string; cause?: { code?: string } }).code;
    const causeCode = (error as { cause?: { code?: string } }).cause?.code;
    if (code === '55P03' || causeCode === '55P03') return true;
    throw error;
  }
}

/**
 * Rejects if `work` hasn't finished in `ms`, so a statement that waits fails the test instead of
 * hanging it.
 */
const within = <T>(ms: number, work: Promise<T>): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms),
    ),
  ]);

describe('changing a snapshot’s state while another session does', () => {
  it('finishes a publish and a commit that race for one generation, the publish first', () =>
    inDataset('publish-first', async (datasetId) => {
      await holdSnapshot(pool, heldIn(datasetId, 'sn_held', T(1)));
      let commit: Promise<unknown> = Promise.resolve();
      try {
        const published = await publishHeld(
          racing(pool, async () => {
            // A run publishes generation 1 itself once the publish has begun, before the publish
            // moves the head. If the publish held the snapshot's row and then wanted the dataset's,
            // while the commit held the dataset's and then wanted the snapshot's, Postgres would
            // end one of them with "deadlock detected".
            commit = commitSnapshot(pool, directIn(datasetId, 1));
            await settledOrWaiting(commit);
          }),
          publishing(datasetId, 'sn_held', 1),
        );
        expect(published).toEqual({ committed: true });
        expect(await commit).toEqual({ committed: false, headGeneration: 1 });
        expect((await snapshotById(pool, 'sn_held'))?.state).toBe('published');
        expect(await headGenerationOf(pool, datasetId)).toBe(1);
      } finally {
        // Let the commit end before the dataset goes, whatever the test found.
        await commit.catch(() => undefined);
      }
    }));

  it('finishes a commit and a publish that race for one generation, the commit first', () =>
    inDataset('commit-first', async (datasetId) => {
      await holdSnapshot(pool, heldIn(datasetId, 'sn_held', T(1)));
      let publish: Promise<unknown> = Promise.resolve();
      try {
        const committed = await commitSnapshot(
          racing(pool, async () => {
            publish = publishHeld(pool, publishing(datasetId, 'sn_held', 1));
            await settledOrWaiting(publish);
          }),
          directIn(datasetId, 1),
        );
        expect(committed).toEqual({ committed: true });
        // The commit superseded what was held, so the publish finds it stale.
        expect(await publish).toEqual({ stale: 'superseded' });
        expect((await snapshotById(pool, 'sn_held'))?.state).toBe('superseded');
        expect(await headGenerationOf(pool, datasetId)).toBe(1);
      } finally {
        await publish.catch(() => undefined);
      }
    }));

  const changes: [string, (datasetId: string) => Promise<unknown>][] = [
    ['commit', (datasetId) => commitSnapshot(pool, directIn(datasetId, 1))],
    ['hold', (datasetId) => holdSnapshot(pool, heldIn(datasetId, 'sn_newer', T(2)))],
    ['publish', (datasetId) => publishHeld(pool, publishing(datasetId, 'sn_held', 1))],
    ['discard', () => discardHeld(pool, { snapshotId: 'sn_held', at: T(2) })],
    ['supersede', (datasetId) => supersedeHeld(pool, { datasetId, at: T(2) })],
  ];
  it.each(changes)('%s writes nothing before it has the dataset’s row', (name, change) =>
    inDataset(`first-${name}`, async (datasetId) => {
      await holdSnapshot(pool, heldIn(datasetId, 'sn_held', T(1)));
      // Another session has the dataset's row, so the change waits for it, and so far it has
      // written no snapshot and no question. A change that wrote its own snapshot first, as a
      // hold does, would hold it while it waits.
      const lock = await holdingDataset(datasetId);
      let finished = false;
      const changing = change(datasetId);
      void changing.then(
        () => (finished = true),
        () => (finished = true),
      );
      try {
        await settledOrWaiting(changing);
        expect(finished).toBe(false);
        expect(await writtenWhileWaiting()).toBe(0);
      } finally {
        lock.release();
        await lock.done;
        await changing.catch(() => undefined);
      }
      await changing;
    }),
  );

  it.each(changes)('%s takes the dataset’s row before the snapshot’s', (name, change) =>
    inDataset(`order-${name}`, async (datasetId) => {
      await holdSnapshot(pool, heldIn(datasetId, 'sn_held', T(1)));
      // Another session has the held snapshot's row, so the change waits for it.
      const lock = await holdingSnapshot('sn_held');
      let finished = false;
      const changing = change(datasetId);
      void changing.then(
        () => (finished = true),
        () => (finished = true),
      );
      try {
        await settledOrWaiting(changing);
        expect(finished).toBe(false);
        // It already has the dataset's row. Changes that took the snapshot's row first and the
        // dataset's second would deadlock with one that took them the other way.
        expect(await datasetRowIsTaken(datasetId)).toBe(true);
        // That lock is the weaker one: a run starting while a snapshot changes isn't held up.
        await within(2000, startRun(pool, { id: `${datasetId}-202610100005`, datasetId }));
      } finally {
        lock.release();
        await lock.done;
        // Let the change end before the dataset goes, whatever the test found.
        await changing.catch(() => undefined);
      }
      await changing;
    }),
  );
});

describe('an older run’s change while a newer run holds its snapshot', () => {
  it('waits for the dataset’s row, and then changes nothing, having seen the newer snapshot', () =>
    inDataset('newer-race', async (datasetId) => {
      const older = `${datasetId}-older`;
      const newer = `${datasetId}-newer`;
      for (const [id, at] of [
        [older, T(1)],
        [newer, T(2)],
      ] as const) {
        await startRun(pool, { id, datasetId });
        await pool.update(runs).set({ startedAt: at }).where(eq(runs.id, id));
      }
      // The newer run is holding its snapshot: it has the dataset's row, and hasn't committed.
      const session = await holdingRow((tx) =>
        holdSnapshot(tx, { ...heldIn(datasetId, 'sn_newer', T(3)), runId: newer }),
      );
      let finished = false;
      let changing: Promise<unknown> = Promise.resolve();
      try {
        changing = unlessNewerRun(pool, { datasetId, runId: older }, (tx) =>
          supersedeHeld(tx, { datasetId, at: T(4) }),
        );
        void changing.then(
          () => (finished = true),
          () => (finished = true),
        );
        await settledOrWaiting(changing);
        expect(finished).toBe(false);
      } finally {
        session.release();
        await session.done;
        await changing.catch(() => undefined);
      }
      // It looked only once it had the row, so it saw the snapshot that committed while it
      // waited. Had it looked first, it would have superseded that snapshot.
      expect(await changing).toEqual({ newer: { runId: newer, snapshotId: 'sn_newer' } });
      expect((await snapshotById(pool, 'sn_newer'))?.state).toBe('held');
    }));
});

describe('lockPageVerdicts', () => {
  it('holds back another answer about the same page until its transaction ends, and none about another', async () => {
    // The lock is held by a session of its own, as an answer in progress would hold it.
    const lock = await holdingRow((tx) => lockPageVerdicts(tx, 'it_page_one'));
    let finished = false;
    const answering = pool.transaction((tx) => lockPageVerdicts(tx, 'it_page_one'));
    void answering.then(
      () => (finished = true),
      () => (finished = true),
    );
    try {
      await settledOrWaiting(answering);
      expect(finished).toBe(false);
      // An answer about another page isn't held up by it.
      await within(
        2000,
        pool.transaction((tx) => lockPageVerdicts(tx, 'it_page_two')),
      );
    } finally {
      lock.release();
      await lock.done;
      await answering.catch(() => undefined);
    }
    await within(2000, answering);
    expect(finished).toBe(true);
  });
});

describe('startRunAlone while another session starts a run', () => {
  const runIds = async (datasetId: string) =>
    (
      await pool
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.datasetId, datasetId))
        .orderBy(runs.id)
    ).map((row) => row.id);

  it('waits for the session that has the dataset’s row, and then finds that session’s run', () =>
    inDataset('start-wait', async (datasetId) => {
      const first = `${datasetId}-202610100000`;
      const second = `${datasetId}-202610100005`;
      // The first start has the dataset's row and has recorded its run, and hasn't committed.
      const session = await holdingRow((tx) => startRunAlone(tx, { id: first, datasetId }));
      let finished = false;
      const starting = startRunAlone(pool, { id: second, datasetId });
      void starting.then(
        () => (finished = true),
        () => (finished = true),
      );
      try {
        await settledOrWaiting(starting);
        // Without the row it would have looked at once, seen no run that has committed, and started
        // its own.
        expect(finished).toBe(false);
      } finally {
        session.release();
        await session.done;
        await starting.catch(() => undefined);
      }
      // It looks only once it has the row, so it sees the run the first start committed, and
      // records none of its own.
      expect(await starting).toMatchObject({ running: { id: first } });
      expect(await runIds(datasetId)).toEqual([first]);
    }));

  it('gives exactly one run to two starts made at once', () =>
    inDataset('start-both', async (datasetId) => {
      const ids = [`${datasetId}-202610100000`, `${datasetId}-202610100005`];
      const results = await Promise.all(ids.map((id) => startRunAlone(pool, { id, datasetId })));
      const started = results.filter((result) => 'created' in result);
      const refused = results.filter((result) => 'running' in result);
      expect(started).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(await runIds(datasetId)).toEqual([started[0]!.run.id]);
      expect(refused[0]!.running.id).toBe(started[0]!.run.id);
    }));
});
