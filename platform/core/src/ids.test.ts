import { describe, expect, it } from 'vitest';
import { newId, runIdFor, sha256Hex, stableId, stableStringify } from './ids';

describe('newId', () => {
  it('is the prefix and 20 base32 characters', () => {
    expect(newId('sp')).toMatch(/^sp_[0-9a-hjkmnp-tv-z]{20}$/);
  });

  it('is new every time', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('it')));
    expect(ids.size).toBe(1000);
  });
});

describe('runIdFor', () => {
  it('names the dataset and the five-minute slot, in UTC', () => {
    expect(runIdFor('crowdio-audio-products', new Date('2026-10-09T12:07:59Z'))).toBe(
      'crowdio-audio-products-202610091205',
    );
    expect(runIdFor('crowdio-audio-products', new Date('2026-10-09T12:05:00Z'))).toBe(
      'crowdio-audio-products-202610091205',
    );
    expect(runIdFor('crowdio-audio-products', new Date('2026-10-09T12:10:00Z'))).toBe(
      'crowdio-audio-products-202610091210',
    );
  });
});

describe('stableStringify', () => {
  it('sorts keys at every level and leaves out undefined', () => {
    expect(stableStringify({ b: 1, a: { d: [{ y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[{"x":2,"y":1}]},"b":1}',
    );
  });

  it('writes a Date as its ISO string, as JSON.stringify does', () => {
    expect(stableStringify({ at: new Date('2026-10-09T12:05:00.000Z') })).toBe(
      '{"at":"2026-10-09T12:05:00.000Z"}',
    );
  });
});

describe('sha256Hex', () => {
  const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

  it('hashes text as UTF-8', async () => {
    expect(await sha256Hex('abc')).toBe(ABC);
  });

  it('hashes bytes', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(ABC);
  });
});

describe('stableId', () => {
  it('is the same for the same parts, and looks like any other ID', async () => {
    const id = await stableId('fe', 'run-1', 'it_1', 0);
    expect(id).toMatch(/^fe_[0-9a-hjkmnp-tv-z]{20}$/);
    expect(await stableId('fe', 'run-1', 'it_1', 0)).toBe(id);
  });

  it('differs when any part does, and when parts split differently', async () => {
    const ids = new Set([
      await stableId('fe', 'run-1', 'it_1', 0),
      await stableId('fe', 'run-1', 'it_1', 1),
      await stableId('fe', 'run-2', 'it_1', 0),
      await stableId('fe', 'run-1i', 't_1', 0),
      await stableId('st', 'run-1', 'it_1', 0),
    ]);
    expect(ids.size).toBe(5);
  });
});
