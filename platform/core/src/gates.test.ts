import { describe, expect, it } from 'vitest';
import { checkGates, type GateInput } from './gates';

const ids = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => `sp_${String(index + from).padStart(4, '0')}`);

const input = (overrides: Partial<GateInput>): GateInput => ({
  approval: 'balanced',
  maxRemovals: { count: 25, share: 0.05 },
  previous: { canonicalIds: ids(400), revision: 3 },
  next: { canonicalIds: ids(400), revision: 3 },
  ...overrides,
});

describe('checkGates', () => {
  it('publishes a balanced dataset’s routine changes', () => {
    expect(checkGates(input({ next: { canonicalIds: ids(405, 3), revision: 3 } }))).toEqual({
      publish: true,
      reasons: [],
      added: 8,
      removed: 3,
    });
  });

  it('holds a balanced dataset’s first publication, and its first after the definition changed', () => {
    expect(checkGates(input({ previous: null })).reasons).toEqual([
      'it’s the dataset’s first publication',
    ]);
    expect(checkGates(input({ next: { canonicalIds: ids(400), revision: 4 } })).reasons).toEqual([
      'the definition changed since the last publication (revision 3 to 4)',
    ]);
  });

  it('holds a snapshot that drops more than 25 records, or more than 5% of them', () => {
    // 21 of 400 is more than 5%, though fewer than 25.
    const dropped = checkGates(input({ next: { canonicalIds: ids(379, 21), revision: 3 } }));
    expect(dropped).toMatchObject({ publish: false, removed: 21 });
    expect(dropped.reasons).toEqual([
      'it drops 21 of 400 published records, more than the guard allows (25 records or 5%)',
    ]);
    expect(checkGates(input({ next: { canonicalIds: ids(380, 20), revision: 3 } })).publish).toBe(
      true,
    );
  });

  it('holds a snapshot that drops more than 25 records of a large dataset, and not 25', () => {
    // 5% of 1,000 is 50, so only the count of 25 can stop these.
    const previous = { canonicalIds: ids(1000), revision: 3 };
    const dropped = checkGates(
      input({ previous, next: { canonicalIds: ids(974, 26), revision: 3 } }),
    );
    expect(dropped).toMatchObject({ publish: false, removed: 26 });
    expect(dropped.reasons).toEqual([
      'it drops 26 of 1000 published records, more than the guard allows (25 records or 5%)',
    ]);
    expect(
      checkGates(input({ previous, next: { canonicalIds: ids(975, 25), revision: 3 } })).publish,
    ).toBe(true);
  });

  it('publishes on its own under auto unless the guard trips, and never under manual', () => {
    expect(checkGates(input({ approval: 'auto', previous: null })).publish).toBe(true);
    expect(
      checkGates(input({ approval: 'auto', next: { canonicalIds: ids(300), revision: 3 } }))
        .publish,
    ).toBe(false);
    expect(checkGates(input({ approval: 'manual' })).reasons).toEqual([
      'the dataset’s approval is manual',
    ]);
  });
});
