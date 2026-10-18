import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import type { Executor } from './client';
import { applyDefinition, listLiveItems } from './datasets';
import { testDefinition } from './fixtures';
import { dueItems } from './listing';
import { items, sources } from './schema';
import {
  liveAgain,
  probeItem,
  recordSourceRuns,
  reviveSources,
  sourceStates,
} from './source-states';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 20, 8);
/** The start of the nth run, a day apart. */
const runAt = (n: number) => new Date(START + n * DAY);

const standing = async (db: Executor, datasetId: string) =>
  Object.fromEntries(
    (await sourceStates(db, datasetId)).map((state) => [
      state.id,
      {
        blockedRuns: state.blockedRuns,
        refused: state.refusedAt?.toISOString() ?? null,
        lastProbe: state.lastProbe,
      },
    ]),
  );

/** One source's whole standing. */
const stateOf = async (db: Executor, datasetId: string, id: string) =>
  (await sourceStates(db, datasetId)).find((state) => state.id === id)!;

/** What a live source's standing is: no blocked runs, no refusal, no probe. */
const liveState = (id: string) => ({
  id,
  blockedRuns: 0,
  refusedAt: null,
  lastProbeAt: null,
  lastProbe: null,
});

/** The dataset's source rows as stored, every column, by ID. */
const storedSources = (db: Executor, datasetId: string) =>
  db.select().from(sources).where(eq(sources.datasetId, datasetId)).orderBy(sources.id);

/** Three blocked runs in a row refuse `maker-a`, the third at `runAt(3)`. */
async function refuseMakerA(db: Executor, datasetId: string) {
  for (const n of [1, 2, 3]) {
    await recordSourceRuns(db, {
      datasetId,
      at: runAt(n),
      verdicts: { 'maker-a': 'blocked' },
      probes: {},
    });
  }
}

/** Refuses `maker-a`, and keeps what a probe of it met at `runAt(4)`. */
async function refusedAndProbed(db: Executor, datasetId: string) {
  await applyDefinition(db, testDefinition(datasetId));
  await refuseMakerA(db, datasetId);
  await recordSourceRuns(db, {
    datasetId,
    at: runAt(4),
    verdicts: { 'maker-a': 'untouched' },
    probes: { 'maker-a': 'blocked' },
  });
  expect(await stateOf(db, datasetId, 'maker-a')).toMatchObject({
    blockedRuns: 3,
    lastProbe: 'blocked',
    lastProbeAt: runAt(4),
  });
}

describe('recordSourceRuns', () => {
  it('counts blocked runs, refuses a source at the third, and starts again once one gets through', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('standing'));
      const blocked = { 'maker-a': 'blocked', 'maker-b': 'through' } as const;
      expect(
        await recordSourceRuns(db, {
          datasetId: 'standing',
          at: runAt(1),
          verdicts: blocked,
          probes: {},
        }),
      ).toEqual({ blocked: [{ id: 'maker-a', blockedRuns: 1 }], refused: [] });
      await recordSourceRuns(db, {
        datasetId: 'standing',
        at: runAt(2),
        verdicts: blocked,
        probes: {},
      });
      expect(
        await recordSourceRuns(db, {
          datasetId: 'standing',
          at: runAt(3),
          verdicts: blocked,
          probes: {},
        }),
      ).toEqual({ blocked: [{ id: 'maker-a', blockedRuns: 3 }], refused: ['maker-a'] });
      expect(await standing(db, 'standing')).toEqual({
        'maker-a': { blockedRuns: 3, refused: runAt(3).toISOString(), lastProbe: null },
        'maker-b': { blockedRuns: 0, refused: null, lastProbe: null },
      });

      await recordSourceRuns(db, {
        datasetId: 'standing',
        at: runAt(4),
        verdicts: { 'maker-a': 'through', 'maker-b': 'through' },
        probes: {},
      });
      expect((await standing(db, 'standing'))['maker-a']).toEqual({
        blockedRuns: 0,
        refused: null,
        lastProbe: null,
      });
    }));

  it('keeps the count when a run leaves a source untouched', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('untouched'));
      await recordSourceRuns(db, {
        datasetId: 'untouched',
        at: runAt(1),
        verdicts: { 'maker-a': 'blocked' },
        probes: {},
      });
      await recordSourceRuns(db, {
        datasetId: 'untouched',
        at: runAt(2),
        verdicts: { 'maker-a': 'untouched' },
        probes: {},
      });
      await recordSourceRuns(db, {
        datasetId: 'untouched',
        at: runAt(3),
        verdicts: { 'maker-a': 'blocked' },
        probes: {},
      });
      expect((await standing(db, 'untouched'))['maker-a']!.blockedRuns).toBe(2);
    }));

  it('counts a run once, however often its step runs, and never an older run after a newer one', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('once'));
      const input = {
        datasetId: 'once',
        at: runAt(2),
        verdicts: { 'maker-a': 'blocked' as const },
        probes: {},
      };
      await recordSourceRuns(db, input);
      // The step runs again: it says what its first attempt said, and counts nothing more.
      expect(await recordSourceRuns(db, input)).toEqual({
        blocked: [{ id: 'maker-a', blockedRuns: 1 }],
        refused: [],
      });
      // A newer run has counted the source, so the older run has nothing to say.
      expect(await recordSourceRuns(db, { ...input, at: runAt(1) })).toEqual({
        blocked: [],
        refused: [],
      });
      expect((await standing(db, 'once'))['maker-a']!.blockedRuns).toBe(1);
    }));

  it('keeps what a refused source’s probe met', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('probes'));
      for (const n of [1, 2, 3]) {
        await recordSourceRuns(db, {
          datasetId: 'probes',
          at: runAt(n),
          verdicts: { 'maker-a': 'blocked' },
          probes: {},
        });
      }
      await recordSourceRuns(db, {
        datasetId: 'probes',
        at: runAt(4),
        verdicts: { 'maker-a': 'untouched' },
        probes: { 'maker-a': 'no answer' },
      });
      const [state] = (await sourceStates(db, 'probes')).filter((row) => row.id === 'maker-a');
      expect(state).toMatchObject({
        blockedRuns: 3,
        lastProbe: 'no answer',
        lastProbeAt: runAt(4),
      });
      expect(state!.refusedAt).toEqual(runAt(3));
    }));

  it('keeps a refused source at three blocked runs when a run is blocked on it again, and reports nothing', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('refused-stays'));
      await refuseMakerA(db, 'refused-stays');
      expect(
        await recordSourceRuns(db, {
          datasetId: 'refused-stays',
          at: runAt(4),
          verdicts: { 'maker-a': 'blocked' },
          probes: {},
        }),
      ).toEqual({ blocked: [], refused: [] });
      expect((await standing(db, 'refused-stays'))['maker-a']).toEqual({
        blockedRuns: 3,
        refused: runAt(3).toISOString(),
        lastProbe: null,
      });
    }));

  it('refuses a source only on a blocked run, however high its count stands', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('out-of-turn'));
      // The count of a refusal without the refusal. Nothing in the store writes such a row, so this
      // shows that the run's verdict decides, not the count.
      await db.update(sources).set({ blockedRuns: 3 }).where(eq(sources.datasetId, 'out-of-turn'));
      expect(
        await recordSourceRuns(db, {
          datasetId: 'out-of-turn',
          at: runAt(1),
          verdicts: { 'maker-a': 'untouched', 'maker-b': 'through' },
          probes: {},
        }),
      ).toEqual({ blocked: [], refused: [] });
      expect(await standing(db, 'out-of-turn')).toEqual({
        'maker-a': { blockedRuns: 3, refused: null, lastProbe: null },
        'maker-b': { blockedRuns: 0, refused: null, lastProbe: null },
      });
    }));

  it('keeps no probe for a source that was revived while the run that probed it was going', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('revived-mid-run'));
      await refuseMakerA(db, 'revived-mid-run');
      expect(await reviveSources(db, { datasetId: 'revived-mid-run', sources: ['maker-a'] })).toBe(
        1,
      );
      // The run began before the revive and probed the source then; it counts after.
      await recordSourceRuns(db, {
        datasetId: 'revived-mid-run',
        at: runAt(4),
        verdicts: { 'maker-a': 'untouched' },
        probes: { 'maker-a': 'blocked' },
      });
      expect(await stateOf(db, 'revived-mid-run', 'maker-a')).toEqual(liveState('maker-a'));
    }));

  it('forgets a kept probe when a run gets through', () =>
    withRollback(async (db) => {
      await refusedAndProbed(db, 'probe-through');
      await recordSourceRuns(db, {
        datasetId: 'probe-through',
        at: runAt(5),
        verdicts: { 'maker-a': 'through' },
        probes: {},
      });
      expect(await stateOf(db, 'probe-through', 'maker-a')).toEqual(liveState('maker-a'));
    }));
});

describe('a step that runs again', () => {
  it('reports a blocked run as its first attempt did, and leaves the rows as they were', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('replay-blocked'));
      const input = {
        datasetId: 'replay-blocked',
        at: runAt(1),
        verdicts: { 'maker-a': 'blocked' as const, 'maker-b': 'through' as const },
        probes: {},
      };
      const first = await recordSourceRuns(db, input);
      expect(first).toEqual({ blocked: [{ id: 'maker-a', blockedRuns: 1 }], refused: [] });
      const stored = await storedSources(db, 'replay-blocked');
      expect(await recordSourceRuns(db, input)).toEqual(first);
      expect(await storedSources(db, 'replay-blocked')).toEqual(stored);
    }));

  it('reports a refusal as its first attempt did, and leaves the rows as they were', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('replay-refused'));
      for (const n of [1, 2]) {
        await recordSourceRuns(db, {
          datasetId: 'replay-refused',
          at: runAt(n),
          verdicts: { 'maker-a': 'blocked' },
          probes: {},
        });
      }
      const third = {
        datasetId: 'replay-refused',
        at: runAt(3),
        verdicts: { 'maker-a': 'blocked' as const },
        probes: {},
      };
      const first = await recordSourceRuns(db, third);
      expect(first).toEqual({ blocked: [{ id: 'maker-a', blockedRuns: 3 }], refused: ['maker-a'] });
      const stored = await storedSources(db, 'replay-refused');
      expect(await recordSourceRuns(db, third)).toEqual(first);
      expect(await storedSources(db, 'replay-refused')).toEqual(stored);
    }));

  it('reports nothing for a blocked run on a source refused before the run, as its first attempt did', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('replay-before'));
      await refuseMakerA(db, 'replay-before');
      const fourth = {
        datasetId: 'replay-before',
        at: runAt(4),
        verdicts: { 'maker-a': 'blocked' as const },
        probes: {},
      };
      expect(await recordSourceRuns(db, fourth)).toEqual({ blocked: [], refused: [] });
      const stored = await storedSources(db, 'replay-before');
      expect(await recordSourceRuns(db, fourth)).toEqual({ blocked: [], refused: [] });
      expect(await storedSources(db, 'replay-before')).toEqual(stored);
    }));
});

describe('liveAgain and reviveSources', () => {
  it('makes a refused source live again when its probe gets through', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('live-again'));
      for (const n of [1, 2, 3]) {
        await recordSourceRuns(db, {
          datasetId: 'live-again',
          at: runAt(n),
          verdicts: { 'maker-a': 'blocked' },
          probes: {},
        });
      }
      await liveAgain(db, { datasetId: 'live-again', sourceIds: ['maker-a'] });
      expect((await standing(db, 'live-again'))['maker-a']).toEqual({
        blockedRuns: 0,
        refused: null,
        lastProbe: null,
      });
    }));

  it('revives blocked or refused sources by hand, and counts only those', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('revive-sources'));
      await recordSourceRuns(db, {
        datasetId: 'revive-sources',
        at: runAt(1),
        verdicts: { 'maker-a': 'blocked' },
        probes: {},
      });
      expect(
        await reviveSources(db, {
          datasetId: 'revive-sources',
          sources: ['maker-a', 'maker-b', 'nobody'],
        }),
      ).toBe(1);
      expect((await standing(db, 'revive-sources'))['maker-a']!.blockedRuns).toBe(0);
    }));

  it('forgets a kept probe when its source is live again', () =>
    withRollback(async (db) => {
      await refusedAndProbed(db, 'probe-live-again');
      await liveAgain(db, { datasetId: 'probe-live-again', sourceIds: ['maker-a'] });
      expect(await stateOf(db, 'probe-live-again', 'maker-a')).toEqual(liveState('maker-a'));
    }));

  it('revives a refused source, its probe and all, and leaves a removed source alone', () =>
    withRollback(async (db) => {
      const definition = testDefinition('revive-refused');
      await applyDefinition(db, definition);
      for (const n of [1, 2, 3]) {
        await recordSourceRuns(db, {
          datasetId: 'revive-refused',
          at: runAt(n),
          verdicts: { 'maker-a': 'blocked', 'maker-b': 'blocked' },
          probes: {},
        });
      }
      await recordSourceRuns(db, {
        datasetId: 'revive-refused',
        at: runAt(4),
        verdicts: { 'maker-a': 'untouched', 'maker-b': 'untouched' },
        probes: { 'maker-a': 'blocked', 'maker-b': 'no answer' },
      });
      // maker-b leaves the definition while it is still refused.
      await applyDefinition(db, {
        ...definition,
        sources: definition.sources.filter((source) => source.id === 'maker-a'),
      });
      const removed = (await storedSources(db, 'revive-refused')).find(
        (row) => row.id === 'maker-b',
      )!;
      expect(removed).toMatchObject({ blockedRuns: 3, lastProbe: 'no answer' });
      expect(removed.removedAt).not.toBeNull();

      expect(
        await reviveSources(db, {
          datasetId: 'revive-refused',
          sources: ['maker-a', 'maker-b'],
        }),
      ).toBe(1);
      expect(await sourceStates(db, 'revive-refused')).toEqual([liveState('maker-a')]);
      expect(
        (await storedSources(db, 'revive-refused')).find((row) => row.id === 'maker-b'),
      ).toEqual(removed);
    }));
});

describe('the run plan and probes', () => {
  it('leaves a refused source’s pages out of the plan, even when every page counts as due', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('plan-refused'));
      await db
        .update(sources)
        .set({ blockedRuns: 3, refusedAt: runAt(1) })
        .where(and(eq(sources.datasetId, 'plan-refused'), eq(sources.id, 'maker-a')));
      const live = await listLiveItems(db, 'plan-refused');
      const b1 = live.find((item) => item.sourceId === 'maker-b')!;
      for (const all of [false, true]) {
        const plan = await dueItems(db, {
          datasetId: 'plan-refused',
          now: runAt(2),
          maxAgeDays: 7,
          current: 'r1:x1',
          limit: 1000,
          all,
        });
        expect(plan.ids).toEqual([b1.id]);
        // Only maker-b's page is due, and the refused source's two pages are still live.
        expect(plan.due).toBe(1);
        expect(plan.live).toBe(3);
      }
    }));

  it('probes a refused pages source with its least recently read page', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('probe-item'));
      const live = await listLiveItems(db, 'probe-item');
      const [a1, a2] = live.filter((item) => item.sourceId === 'maker-a');
      await db
        .update(items)
        .set({ lastFetchedAt: runAt(2) })
        .where(eq(items.id, a1!.id));
      await db
        .update(items)
        .set({ lastFetchedAt: runAt(1) })
        .where(eq(items.id, a2!.id));
      expect((await probeItem(db, { datasetId: 'probe-item', sourceId: 'maker-a' }))?.id).toBe(
        a2!.id,
      );
      await db.update(items).set({ status: 'gone' }).where(eq(items.id, a2!.id));
      expect((await probeItem(db, { datasetId: 'probe-item', sourceId: 'maker-a' }))?.id).toBe(
        a1!.id,
      );
      expect(await probeItem(db, { datasetId: 'probe-item', sourceId: 'nobody' })).toBeNull();
    }));

  it('probes a page nobody has read before one that was read long ago', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('probe-unread'));
      const live = await listLiveItems(db, 'probe-unread');
      const [a1, a2] = live.filter((item) => item.sourceId === 'maker-a');
      // Postgres sorts nulls last unless told otherwise. The unread page has the later address and no
      // read at all, so only the ordering puts it first.
      await db
        .update(items)
        .set({ lastFetchedAt: runAt(0) })
        .where(eq(items.id, a1!.id));
      expect((await probeItem(db, { datasetId: 'probe-unread', sourceId: 'maker-a' }))?.id).toBe(
        a2!.id,
      );
    }));
});
