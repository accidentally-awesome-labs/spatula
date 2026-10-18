import type { EvalScores } from '@spatula/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { seedDataset, T } from '../test/seed';
import { applyDefinition } from './datasets';
import { listEvals, saveEval } from './evals';
import { testDefinition } from './fixtures';
import { datasets, evals } from './schema';

const scores = (recall: number) => ({ recall }) as unknown as EvalScores;

describe('evals', () => {
  it('keep each score, newest first', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      const save = (generation: number, recall: number, minute: number) =>
        saveEval(tx, {
          datasetId: 'test-products',
          generation,
          goldenVersion: 1,
          scores: scores(recall),
          at: T(minute),
        });
      await save(1, 0.8, 1);
      await save(2, 0.92, 2);
      const listed = await listEvals(tx, 'test-products');
      expect(listed.map((saved) => saved.generation)).toEqual([2, 1]);
      expect(listed[0]).toMatchObject({ scores: { recall: 0.92 }, createdAt: T(2).toISOString() });
    }));

  it('say what was scored and when, and keep the score as it was given', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      const given = {
        precision: 1,
        recall: 0.9,
        fields: { name: { checked: 3, correct: 2, missing: 0, accuracy: 2 / 3 } },
        misses: ['maker-hd-800: no published record'],
      } as unknown as EvalScores;
      const saved = await saveEval(tx, {
        datasetId: 'test-products',
        generation: 4,
        goldenVersion: 2,
        scores: given,
        at: T(3),
      });
      expect(saved).toEqual({
        id: expect.stringMatching(/^ev_[0-9a-hjkmnp-tv-z]{20}$/u),
        generation: 4,
        goldenVersion: 2,
        scores: given,
        createdAt: T(3).toISOString(),
      });
      expect(await listEvals(tx, 'test-products')).toEqual([saved]);
    }));

  it('list a dataset’s own scores only, the newest 50 of them', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      await applyDefinition(tx, testDefinition('other-evals'));
      await saveEval(tx, {
        datasetId: 'other-evals',
        generation: 9,
        goldenVersion: 1,
        scores: scores(0.5),
        at: T(0),
      });
      // 51 scores, a minute apart: the oldest is left out.
      for (let generation = 1; generation <= 51; generation += 1) {
        await saveEval(tx, {
          datasetId: 'test-products',
          generation,
          goldenVersion: 1,
          scores: scores(0.9),
          at: T(generation - 1),
        });
      }
      const listed = await listEvals(tx, 'test-products');
      expect(listed).toHaveLength(50);
      expect(listed[0]!.generation).toBe(51);
      expect(listed.at(-1)!.generation).toBe(2);
      expect((await listEvals(tx, 'other-evals')).map((saved) => saved.generation)).toEqual([9]);
      expect(await listEvals(tx, 'nothing')).toEqual([]);
    }));

  it('go with their dataset', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      await saveEval(tx, {
        datasetId: 'test-products',
        generation: 1,
        goldenVersion: 1,
        scores: scores(0.9),
        at: T(1),
      });
      await tx.delete(datasets).where(eq(datasets.id, 'test-products'));
      expect(await tx.select().from(evals).where(eq(evals.datasetId, 'test-products'))).toEqual([]);
    }));
});
