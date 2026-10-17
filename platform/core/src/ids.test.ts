import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, newId, runIdFor, sha256Hex, stableId, stableStringify } from './ids';

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

describe('hmacSha256Hex', () => {
  it('signs as RFC 4231’s second test case says', async () => {
    expect(await hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('signs any text as the UTF-8 bytes it is, whitespace and all, under any key', async () => {
    // Node's own HMAC is the second opinion. A signature covers the exact bytes sent, so a newline
    // after a body, or text outside ASCII, must not change what is signed.
    const texts = [
      '',
      'a',
      'what do ya want for nothing?\n',
      ' padded ',
      '\tcolumns\r\n',
      'ünï 🎧 日本語',
      '{"generation":1}\n',
      'x'.repeat(10_000),
    ];
    // Keys shorter than a block, as long as one, and longer, which HMAC hashes first.
    const keys = ['Jefe', 'k', 'a key with ünï 🎧', 'x'.repeat(64), 'x'.repeat(131)];
    for (const key of keys) {
      for (const text of texts) {
        expect(
          await hmacSha256Hex(key, text),
          `${key.slice(0, 8)} signing ${text.slice(0, 8)}`,
        ).toBe(createHmac('sha256', key).update(text, 'utf8').digest('hex'));
      }
    }
  });
});
