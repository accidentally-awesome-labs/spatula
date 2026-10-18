import { describe, expect, it } from 'vitest';
import { similarity } from './trigrams';

describe('similarity', () => {
  it('is 1 for the same words, whatever their case', () => {
    expect(similarity('HD650', 'hd650')).toBe(1);
  });

  it('scores a model with a word added above a sibling model', () => {
    expect(similarity('HD650', 'HD650 Pro')).toBeCloseTo(0.6);
    expect(similarity('HD650', 'HD600')).toBeCloseTo(1 / 3);
    expect(similarity('HD 660S', 'HD 660S2')).toBeCloseTo(0.7);
  });

  it('is 0 when either has no letters or digits', () => {
    expect(similarity('', 'HD650')).toBe(0);
    expect(similarity('HD650', ' - ')).toBe(0);
  });

  it('scores as pg_trgm does', () => {
    // What Postgres's similarity() returns for each pair (Crowdio's port checks the same).
    for (const [a, b, pgTrgm] of [
      ['LCD-X', 'LCD X', 1],
      ['WH-1000XM4', 'WH-1000XM5', 0.6923077],
      ['Pro Pro Pro', 'Pro Max', 0.5],
      ['Étoile', 'etoile', 0.4],
      ['Mönster', 'Monster', 0.45454547],
      ['Sennheiser Momentum 4 Wireless', 'Momentum 4', 0.3548387],
    ] as const) {
      expect(similarity(a, b), `${a} / ${b}`).toBeCloseTo(pgTrgm, 6);
    }
  });
});
