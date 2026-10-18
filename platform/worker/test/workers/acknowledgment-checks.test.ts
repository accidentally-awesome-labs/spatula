import { hmacSha256Hex } from '@spatula/core';
import { acknowledgments } from '@spatula/store';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withDatabase } from '../../src/database';
import {
  acknowledge,
  applied,
  CONSUMER_KEY,
  CONSUMER_TOKEN,
  expectNoStore,
  MINUTE,
  post,
  signed,
  subscribed,
} from './api-support';

/*
 * What the Worker checks of an acknowledgment before it records one: the time it was sent, its
 * signature, the bytes the signature covers, and what the body says. The schema's own limits are
 * in core's wire.test.ts, so these tests need only show that the Worker names what is wrong.
 */

const HOUR = 60 * MINUTE;

describe('the checks on an acknowledgment', () => {
  it('take one sent within ten minutes either side of Spatula’s clock, and no other', async () => {
    const sentAt = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    // Each one taken is a dataset of its own: the same generation with another sentAt is another
    // body, and would be refused as a conflict.
    const taken: [string, string][] = [
      ['nine minutes ago', sentAt(-9 * MINUTE)],
      ['nine minutes ahead', sentAt(9 * MINUTE)],
      // An offset names the same instant as UTC does: this is now, written two hours ahead...
      ['now, written two hours ahead', sentAt(2 * HOUR).replace('Z', '+02:00')],
    ];
    for (const [index, [name, at]] of taken.entries()) {
      const datasetId = `ac-window-${index}`;
      await subscribed(datasetId);
      const response = await acknowledge(datasetId, applied(datasetId, { sentAt: at }));
      expect(response.status, name).toBe(201);
    }
    const refused: [string, string][] = [
      ['eleven minutes ago', sentAt(-11 * MINUTE)],
      ['eleven minutes ahead', sentAt(11 * MINUTE)],
      // ...and this is two hours ago, whatever the clock on the wall of that zone says.
      ['two hours ago, by its offset', sentAt(0).replace('Z', '+02:00')],
    ];
    for (const [name, at] of refused) {
      const response = await acknowledge('ac-window-0', applied('ac-window-0', { sentAt: at }));
      expect(response.status, name).toBe(400);
      expect(await response.json(), name).toEqual({
        error: 'sentAt is more than 10 minutes from Spatula’s clock.',
      });
    }
  });

  it('refuse a signature that is missing, malformed, or for other bytes', async () => {
    const datasetId = 'ac-signature';
    await subscribed(datasetId);
    const text = JSON.stringify(applied(datasetId));
    const good = await hmacSha256Hex(CONSUMER_KEY, text);
    const other = await hmacSha256Hex(
      CONSUMER_KEY,
      JSON.stringify(applied(datasetId, { detail: 'other' })),
    );
    const attempts: [string, Record<string, string>][] = [
      ['no signature', {}],
      ['an empty one', { 'x-spatula-signature': '' }],
      ['capital letters', { 'x-spatula-signature': `sha256=${good.toUpperCase()}` }],
      ['no scheme', { 'x-spatula-signature': good }],
      ['another scheme', { 'x-spatula-signature': `sha1=${good}` }],
      ['something before the scheme', { 'x-spatula-signature': `v1,sha256=${good}` }],
      ['the scheme in capitals', { 'x-spatula-signature': `SHA256=${good}` }],
      ['one character too many', { 'x-spatula-signature': `sha256=${good}0` }],
      ['one character too few', { 'x-spatula-signature': `sha256=${good.slice(1)}` }],
      ['a space inside it', { 'x-spatula-signature': `sha256= ${good}` }],
      ['another key’s', await signed(text, 'another-key')],
      ['the bytes of another body', { 'x-spatula-signature': `sha256=${other}` }],
    ];
    for (const [name, headers] of attempts) {
      const response = await post(datasetId, text, {
        authorization: `Bearer ${CONSUMER_TOKEN}`,
        ...headers,
      });
      expect(response.status, name).toBe(401);
      expectNoStore(response);
      expect(await response.json(), name).toEqual({ error: 'The signature is missing or wrong.' });
    }
    // The same body with the right signature is taken, so none of those refusals was the body's.
    const accepted = await post(datasetId, text, {
      authorization: `Bearer ${CONSUMER_TOKEN}`,
      'x-spatula-signature': `sha256=${good}`,
    });
    expect(accepted.status).toBe(201);
  });

  it('check the signature against the bytes sent, not against what they say', async () => {
    const datasetId = 'ac-bytes';
    await subscribed(datasetId);
    const compact = JSON.stringify(applied(datasetId));
    // The same acknowledgment with its whitespace changed has other bytes, so the signature of the
    // first is not the signature of the second. That holds for whitespace around the body too.
    const spaced = JSON.stringify(JSON.parse(compact), null, 2);
    for (const [name, sent] of [
      ['indented', spaced],
      ['a newline after it', `${compact}\n`],
      ['a space before it', ` ${compact}`],
    ] as const) {
      const response = await post(datasetId, sent, {
        authorization: `Bearer ${CONSUMER_TOKEN}`,
        ...(await signed(compact)),
      });
      expect(response.status, name).toBe(401);
    }
    const resigned = await post(datasetId, spaced, {
      authorization: `Bearer ${CONSUMER_TOKEN}`,
      ...(await signed(spaced)),
    });
    expect(resigned.status).toBe(201);

    // Signed as it is sent, a newline after the body is part of the bytes, and the body is taken.
    await subscribed('ac-newline');
    const newline = `${JSON.stringify(applied('ac-newline'))}\n`;
    const withNewline = await post('ac-newline', newline, {
      authorization: `Bearer ${CONSUMER_TOKEN}`,
      ...(await signed(newline)),
    });
    expect(withNewline.status).toBe(201);

    // Text outside ASCII is signed as the UTF-8 bytes it is sent as, and comes back as it went.
    await subscribed('ac-unicode');
    const unicode = JSON.stringify(applied('ac-unicode', { detail: 'ünï 🎧' }));
    const withUnicode = await post('ac-unicode', unicode, {
      authorization: `Bearer ${CONSUMER_TOKEN}`,
      ...(await signed(unicode)),
    });
    expect(withUnicode.status).toBe(201);
    const [kept] = await withDatabase(env, (db) =>
      db.select().from(acknowledgments).where(eq(acknowledgments.datasetId, 'ac-unicode')),
    );
    expect(kept!.detail).toBe('ünï 🎧');
  });

  it('check the signature over the raw bytes, a byte-order mark too, and refuse bytes that aren’t UTF-8', async () => {
    const datasetId = 'ac-raw-bytes';
    await subscribed(datasetId);
    const consumer = { authorization: `Bearer ${CONSUMER_TOKEN}` };
    const text = JSON.stringify(applied(datasetId));
    const plain = new TextEncoder().encode(text);
    const marked = new Uint8Array([0xef, 0xbb, 0xbf, ...plain]);

    // Read as text, these bytes lose their byte-order mark, but the signature covers the bytes
    // sent: one over the text without the mark is wrong.
    const overText = await post(datasetId, marked, { ...consumer, ...(await signed(text)) });
    expect(overText.status).toBe(401);
    expect(await overText.json()).toEqual({ error: 'The signature is missing or wrong.' });
    // Signed over the bytes, the mark and all, the acknowledgment is taken: the mark isn't JSON's.
    const overBytes = await post(datasetId, marked, { ...consumer, ...(await signed(marked)) });
    expect(overBytes.status).toBe(201);
    // A repeat is told from a conflict by the bytes too: the same bytes again are a repeat, and the
    // same text without the mark is another acknowledgment.
    expect((await post(datasetId, marked, { ...consumer, ...(await signed(marked)) })).status).toBe(
      200,
    );
    expect((await post(datasetId, plain, { ...consumer, ...(await signed(plain)) })).status).toBe(
      409,
    );

    // A byte no UTF-8 text has, where the detail's one character was, signed as it was sent. Read as
    // text it would turn into U+FFFD, and the JSON would hold; it's refused as what it is.
    const broken = new TextEncoder().encode(JSON.stringify(applied(datasetId, { detail: '~' })));
    broken[broken.indexOf(0x7e)] = 0xff;
    const notUtf8 = await post(datasetId, broken, { ...consumer, ...(await signed(broken)) });
    expect(notUtf8.status).toBe(400);
    expectNoStore(notUtf8);
    expect(await notUtf8.json()).toEqual({ error: 'The body isn’t UTF-8.' });
  });

  it('say what is wrong with one that is signed but not right', async () => {
    const datasetId = 'ac-wrong';
    await subscribed(datasetId);
    const signedPost = async (text: string) =>
      post(datasetId, text, {
        authorization: `Bearer ${CONSUMER_TOKEN}`,
        ...(await signed(text)),
      });
    const answer = async (response: Response) => {
      expectNoStore(response);
      return [response.status, ((await response.json()) as { error: string }).error] as const;
    };

    // Not JSON at all, signed: the signature comes first, so this is the body's fault.
    expect(await answer(await signedPost('not json'))).toEqual([400, 'The body isn’t JSON.']);
    // Not signed: the signature comes first, so this is refused before anyone reads the body.
    const unsigned = await post(datasetId, 'not json', {
      authorization: `Bearer ${CONSUMER_TOKEN}`,
    });
    expect(await answer(unsigned)).toEqual([401, 'The signature is missing or wrong.']);

    // Each field is named by its path, and the schema's own limits are tested in core.
    const wrongAt = [
      ['generation', { generation: 0 }],
      ['snapshotId', { snapshotId: '' }],
      ['outcome', { outcome: 'maybe' }],
      ['sentAt', { sentAt: '2026-10-10' }],
      ['detail', { detail: 'x'.repeat(501) }],
      ['counts.linked', { counts: { linked: -1 } }],
      ['counts', { counts: [] }],
    ] as const;
    for (const [where, change] of wrongAt) {
      const [status, error] = await answer(
        await signedPost(JSON.stringify(applied(datasetId, change))),
      );
      expect(status, JSON.stringify(change)).toBe(400);
      expect(error, JSON.stringify(change)).toMatch(
        new RegExp(`^The acknowledgment is wrong at ${where.replace('.', '\\.')}: .+`, 'u'),
      );
    }

    // A problem with the body as a whole has no field to name, so it says the body.
    for (const body of [[], 'refused', null, { ...applied(datasetId), extra: 1 }]) {
      const [status, error] = await answer(await signedPost(JSON.stringify(body)));
      expect(status, JSON.stringify(body)).toBe(400);
      expect(error, JSON.stringify(body)).toMatch(/^The acknowledgment is wrong at the body: .+/u);
    }
    // A key that is missing is the key's problem.
    const withoutSentAt = Object.fromEntries(
      Object.entries(applied(datasetId)).filter(([key]) => key !== 'sentAt'),
    );
    const [, missing] = await answer(await signedPost(JSON.stringify(withoutSentAt)));
    expect(missing).toMatch(/^The acknowledgment is wrong at sentAt: .+/u);
    // None of that recorded anything, and the same body made right still goes through.
    expect((await acknowledge(datasetId, applied(datasetId))).status).toBe(201);
  });

  it('take no more than 16 KiB, and are not read at all from a caller that is not a listed consumer', async () => {
    const LIMIT = 16 * 1024;
    const bytesOf = (text: string) => new TextEncoder().encode(text).length;
    // An acknowledgment the schema takes, of exactly this many bytes: counts to fill most of it,
    // and a detail for the rest.
    const ackOfBytes = (datasetId: string, bytes: number): string => {
      const counts: Record<string, number> = {};
      const shortOf = () =>
        bytes - bytesOf(JSON.stringify(applied(datasetId, { detail: '', counts })));
      let index = 0;
      while (shortOf() > 500) counts[`count-${index++}`] = 0;
      const detail = 'd'.repeat(shortOf());
      const text = JSON.stringify(applied(datasetId, { detail, counts }));
      expect(bytesOf(text)).toBe(bytes);
      return text;
    };
    const sendAs = async (datasetId: string, text: string, more: Record<string, string> = {}) =>
      post(datasetId, text, {
        authorization: `Bearer ${CONSUMER_TOKEN}`,
        ...(await signed(text)),
        ...more,
      });
    await subscribed('ac-size');
    await subscribed('ac-size-over');

    // Exactly the limit is taken, whether the request says how long it is or not...
    const atLimit = ackOfBytes('ac-size', LIMIT);
    expect((await sendAs('ac-size', atLimit)).status).toBe(201);
    expect((await sendAs('ac-size', atLimit, { 'content-length': String(LIMIT) })).status).toBe(
      200,
    );

    // ...and one byte more is not, and is never recorded.
    const over = ackOfBytes('ac-size-over', LIMIT + 1);
    const refused = await sendAs('ac-size-over', over);
    expect(refused.status).toBe(413);
    expectNoStore(refused);
    expect(await refused.json()).toEqual({ error: 'An acknowledgment is at most 16 KiB.' });
    const told = await sendAs('ac-size-over', over, { 'content-length': String(LIMIT + 1) });
    expect(told.status).toBe(413);
    expect(await told.json()).toEqual({ error: 'An acknowledgment is at most 16 KiB.' });
    expect(
      await withDatabase(env, (db) =>
        db.select().from(acknowledgments).where(eq(acknowledgments.datasetId, 'ac-size-over')),
      ),
    ).toEqual([]);

    // Who is calling is settled first: a caller with the wrong token is refused as one, and its
    // body is not looked at.
    const stranger = await post('ac-size-over', over, {
      authorization: 'Bearer wrong',
      ...(await signed(over)),
    });
    expect(stranger.status).toBe(401);
    expect(await stranger.json()).toEqual({ error: 'The token is missing or wrong.' });
  });

  it('take one at the limits of what the schema allows', async () => {
    const datasetId = 'ac-limits';
    await subscribed(datasetId);
    const response = await acknowledge(
      datasetId,
      applied(datasetId, {
        detail: 'd'.repeat(500),
        counts: { ['k'.repeat(40)]: 0, linked: 999_999_999 },
      }),
    );
    expect(response.status).toBe(201);
  });
});
