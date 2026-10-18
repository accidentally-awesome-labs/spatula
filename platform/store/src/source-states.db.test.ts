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
      expect(await recordSourceRuns(db, input)).toEqual({ blocked: [], refused: [] });
      await recordSourceRuns(db, { ...input, at: runAt(1) });
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
});
