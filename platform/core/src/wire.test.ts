import { describe, expect, it } from 'vitest';
import { ACK_WINDOW_MS, acknowledgmentSchema } from './wire';

const OK = {
  generation: 1,
  snapshotId: 'sn_x',
  outcome: 'applied',
  sentAt: '2026-10-10T00:00:00.000Z',
};

/**
 * Where the schema finds fault with a body, as the Worker names it: the path of the first issue,
 * which is empty for the body as a whole. Null when the body is right.
 */
function wrongAt(body: unknown): string | null {
  const result = acknowledgmentSchema.safeParse(body);
  return result.success ? null : (result.error.issues[0]?.path.join('.') ?? null);
}

describe('acknowledgmentSchema', () => {
  it('takes the four keys every acknowledgment has, and a detail and counts besides', () => {
    expect(wrongAt(OK)).toBeNull();
    expect(
      wrongAt({ ...OK, detail: 'two records had no brand', counts: { linked: 3, skipped: 0 } }),
    ).toBeNull();
  });

  it('wants each of the four', () => {
    for (const key of Object.keys(OK)) {
      const without = Object.fromEntries(Object.entries(OK).filter(([name]) => name !== key));
      expect(wrongAt(without), key).toBe(key);
    }
  });

  it('refuses a key it does not know, and anything that is not an object, as a whole', () => {
    for (const body of [{ ...OK, extra: 1 }, [], 'applied', null, 7]) {
      expect(wrongAt(body), JSON.stringify(body)).toBe('');
    }
  });

  it('takes a generation that is a whole number from 1 to 999,999,999', () => {
    for (const generation of [1, 2, 999_999_999]) expect(wrongAt({ ...OK, generation })).toBeNull();
    for (const generation of [0, -1, 1.5, 1_000_000_000, '1', null]) {
      expect(wrongAt({ ...OK, generation }), String(generation)).toBe('generation');
    }
  });

  it('takes a snapshot ID of 1 to 64 characters', () => {
    for (const snapshotId of ['s', 'x'.repeat(64)])
      expect(wrongAt({ ...OK, snapshotId })).toBeNull();
    for (const snapshotId of ['', 'x'.repeat(65), 1]) {
      expect(wrongAt({ ...OK, snapshotId }), String(snapshotId)).toBe('snapshotId');
    }
  });

  it('takes the outcomes applied and refused, and no other', () => {
    for (const outcome of ['applied', 'refused']) expect(wrongAt({ ...OK, outcome })).toBeNull();
    for (const outcome of ['maybe', 'Applied', '', 1]) {
      expect(wrongAt({ ...OK, outcome }), String(outcome)).toBe('outcome');
    }
  });

  it('takes a sentAt that is a date and time with a zone or an offset, and no other', () => {
    for (const sentAt of [
      '2026-10-10T00:00:00Z',
      '2026-10-10T00:00:00.123Z',
      '2026-10-10T02:00:00+02:00',
      '2026-10-10T00:00:00-05:30',
    ]) {
      expect(wrongAt({ ...OK, sentAt }), sentAt).toBeNull();
    }
    for (const sentAt of [
      '2026-10-10',
      '2026-10-10T00:00:00',
      '2026-10-10 00:00:00Z',
      '2026-13-40T00:00:00Z',
      'yesterday',
      '',
      1_791_000_000_000,
    ]) {
      expect(wrongAt({ ...OK, sentAt }), String(sentAt)).toBe('sentAt');
    }
  });

  it('takes a detail of up to 500 characters', () => {
    for (const detail of ['', 'x'.repeat(500)]) expect(wrongAt({ ...OK, detail })).toBeNull();
    for (const detail of ['x'.repeat(501), 5]) {
      expect(wrongAt({ ...OK, detail }), String(detail)).toBe('detail');
    }
  });

  it('takes counts of whole numbers from 0, under names of up to 40 characters', () => {
    for (const counts of [{}, { linked: 0 }, { linked: 999_999_999 }, { ['k'.repeat(40)]: 3 }]) {
      expect(wrongAt({ ...OK, counts }), JSON.stringify(counts)).toBeNull();
    }
    for (const [counts, where] of [
      [{ linked: -1 }, 'counts.linked'],
      [{ linked: 1.5 }, 'counts.linked'],
      [{ linked: '3' }, 'counts.linked'],
      [{ ['k'.repeat(41)]: 1 }, `counts.${'k'.repeat(41)}`],
      [[], 'counts'],
      ['linked', 'counts'],
    ] as const) {
      expect(wrongAt({ ...OK, counts }), JSON.stringify(counts)).toBe(where);
    }
  });
});

describe('ACK_WINDOW_MS', () => {
  it('is ten minutes', () => {
    expect(ACK_WINDOW_MS).toBe(10 * 60 * 1000);
  });
});
