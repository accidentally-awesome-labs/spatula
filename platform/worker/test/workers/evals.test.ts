import type { EvalView } from '@spatula/core';
import { testDefinition } from '@spatula/store/fixtures';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../../src/api';
import { call, expectNoStore, staleDataset } from './api-support';

/*
 * The items and the scores that `spatula eval` reads and keeps. They are in a file of their own
 * because each database client the Worker opens stays open until the test file ends (see
 * api-support.ts).
 */

/** The four figures `spatula evals` shows. A score may hold more, and is kept as it is. */
const SCORES = {
  precision: 1,
  recall: 0.9,
  identifiers: { accuracy: 1 },
  keySpecs: { accuracy: 1 },
};

/** And the taxonomy's three, which it shows when a score has them (ADR 0007). */
const TAXONOMY = { shelf: { accuracy: 0.96 }, functions: { precision: 0.95, recall: 0.925 } };

describe('items and evals', () => {
  it('lists a dataset’s items', async () => {
    const applied = await call('PUT', '/datasets/api-items', { body: testDefinition('api-items') });
    expect(applied.status).toBe(200);
    const listed = await call('GET', '/datasets/api-items/items');
    expect(listed.status).toBe(200);
    expectNoStore(listed);
    const item = (sourceId: string, slug: string) => ({
      locator: `https://${sourceId}.example/products/${slug}`,
      sourceId,
      status: 'live',
      entityId: null,
    });
    expect(await listed.json()).toEqual({
      items: [item('maker-a', 'a1'), item('maker-a', 'a2'), item('maker-b', 'b1')],
    });
  });

  it('keeps a score as it was sent, and lists it, for the owner only', async () => {
    await call('PUT', '/datasets/api-evals', { body: testDefinition('api-evals') });
    const sent = {
      ...SCORES,
      fields: { name: { checked: 3, correct: 2, missing: 0, accuracy: 2 / 3 } },
      misses: ['maker-hd-800: no published record'],
    };
    const saved = await call('POST', '/datasets/api-evals/evals', {
      body: { generation: 1, goldenVersion: 2, scores: sent },
    });
    expect(saved.status).toBe(201);
    expectNoStore(saved);
    const view = (await saved.json()) as EvalView;
    expect(view).toEqual({
      id: expect.stringMatching(/^ev_[0-9a-hjkmnp-tv-z]{20}$/u),
      generation: 1,
      goldenVersion: 2,
      scores: sent,
      createdAt: expect.any(String),
    });
    expect(Math.abs(Date.now() - Date.parse(view.createdAt))).toBeLessThan(60_000);

    // No token, or a wrong one, keeps nothing.
    for (const token of [null, 'wrong']) {
      const refused = await call('POST', '/datasets/api-evals/evals', {
        token,
        body: { generation: 2, goldenVersion: 2, scores: SCORES },
      });
      expect(refused.status, `${token ?? 'no token'}`).toBe(401);
      expectNoStore(refused);
    }

    const history = await call('GET', '/datasets/api-evals/evals');
    expect(history.status).toBe(200);
    expectNoStore(history);
    expect(await history.json()).toEqual({ evals: [view] });
  });

  it('refuses scores that spatula evals could not show, naming the problem, and keeps nothing', async () => {
    await call('PUT', '/datasets/api-evals-refused', { body: testDefinition('api-evals-refused') });
    const post = (body: unknown) => call('POST', '/datasets/api-evals-refused/evals', { body });
    const ok = { generation: 1, goldenVersion: 1 };
    // Each body, and where its first problem is: the field's path, or the body as a whole.
    const wrong: [string, unknown, string][] = [
      ['no generation', { goldenVersion: 1, scores: SCORES }, 'generation'],
      ['a generation of 0', { generation: 0, goldenVersion: 1, scores: SCORES }, 'generation'],
      ['a generation that is not whole', { ...ok, generation: 1.5, scores: SCORES }, 'generation'],
      // The numbers are kept in a Postgres integer, so they stop short of 2^31.
      ['a generation above 999,999,999', { ...ok, generation: 1e9, scores: SCORES }, 'generation'],
      [
        'a golden version of 0',
        { generation: 1, goldenVersion: 0, scores: SCORES },
        'goldenVersion',
      ],
      [
        'a golden version above 999,999,999',
        { ...ok, goldenVersion: 1e9, scores: SCORES },
        'goldenVersion',
      ],
      ['a key it does not know', { ...ok, scores: SCORES, note: 'checked' }, 'the body'],
      ['no scores', ok, 'scores'],
      // A partial score would break spatula evals, so it isn't kept.
      ['a partial score', { ...ok, scores: { recall: 0.9 } }, 'scores.precision'],
      ['a precision above 1', { ...ok, scores: { ...SCORES, precision: 1.1 } }, 'scores.precision'],
      ['a recall below 0', { ...ok, scores: { ...SCORES, recall: -0.1 } }, 'scores.recall'],
      [
        'an accuracy that is not a number',
        { ...ok, scores: { ...SCORES, identifiers: { accuracy: '1' } } },
        'scores.identifiers.accuracy',
      ],
      [
        'key specs with no accuracy',
        { ...ok, scores: { ...SCORES, keySpecs: {} } },
        'scores.keySpecs.accuracy',
      ],
      [
        'identifiers that are not a record',
        { ...ok, scores: { ...SCORES, identifiers: 1 } },
        'scores.identifiers',
      ],
      [
        'a shelf accuracy above 1',
        { ...ok, scores: { ...SCORES, taxonomy: { ...TAXONOMY, shelf: { accuracy: 1.5 } } } },
        'scores.taxonomy.shelf.accuracy',
      ],
      [
        'functions with no recall',
        { ...ok, scores: { ...SCORES, taxonomy: { ...TAXONOMY, functions: { precision: 1 } } } },
        'scores.taxonomy.functions.recall',
      ],
      ['an array', [], 'the body'],
      ['null', null, 'the body'],
    ];
    for (const [what, body, where] of wrong) {
      const refused = await post(body);
      expect(refused.status, what).toBe(400);
      expectNoStore(refused);
      const { error } = (await refused.json()) as { error: string };
      expect(error, what).toMatch(
        new RegExp(`^The eval is wrong at ${where.replaceAll('.', '\\.')}: .+`, 'u'),
      );
    }

    const notJson = await call('POST', '/datasets/api-evals-refused/evals', { body: '{ "gener' });
    expect(notJson.status).toBe(400);
    expectNoStore(notJson);
    expect(await notJson.json()).toEqual({ error: 'The body isn’t JSON.' });

    // None of that kept anything, and the largest numbers that fit are kept.
    const largest = await post({
      generation: 999_999_999,
      goldenVersion: 999_999_999,
      scores: SCORES,
    });
    expect(largest.status).toBe(201);
    const history = await call('GET', '/datasets/api-evals-refused/evals');
    expect(await history.json()).toEqual({
      evals: [expect.objectContaining({ generation: 999_999_999, goldenVersion: 999_999_999 })],
    });
  });

  it('keeps a score with the taxonomy’s figures, as it was sent', async () => {
    await call('PUT', '/datasets/api-evals-taxonomy', {
      body: testDefinition('api-evals-taxonomy'),
    });
    const sent = {
      ...SCORES,
      taxonomy: {
        shelf: { checked: 25, correct: 24, missing: 0, accuracy: 0.96 },
        functions: { stated: 40, expected: 40, correct: 38, precision: 0.95, recall: 0.95 },
        features: { checked: 10, correct: 9, missing: 1, accuracy: 0.9 },
        targets: { shelf: true, functions: true },
      },
    };
    const saved = await call('POST', '/datasets/api-evals-taxonomy/evals', {
      body: { generation: 1, goldenVersion: 3, scores: sent },
    });
    expect(saved.status).toBe(201);
    expectNoStore(saved);
    expect(((await saved.json()) as EvalView).scores).toEqual(sent);
  });

  it('takes no more than 512 KiB, counted in bytes, and keeps nothing over it', async () => {
    const LIMIT = 512 * 1024;
    const bytesOf = (text: string) => new TextEncoder().encode(text).length;
    const evalWith = (padding: string) =>
      JSON.stringify({ generation: 1, goldenVersion: 1, scores: { ...SCORES, padding } });
    // An eval of exactly this many bytes: the padding is a score's extra field, which is kept.
    const evalOfBytes = (bytes: number): string => {
      const text = evalWith('p'.repeat(bytes - bytesOf(evalWith(''))));
      expect(bytesOf(text)).toBe(bytes);
      return text;
    };
    const send = (text: string, headers: Record<string, string> = {}) =>
      api.request(
        '/datasets/api-evals-size/evals',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-token',
            'content-type': 'application/json',
            ...headers,
          },
          body: text,
        },
        env,
      );
    const tooBig = { error: 'The scores are at most 512 KiB.' };
    await call('PUT', '/datasets/api-evals-size', { body: testDefinition('api-evals-size') });

    // Exactly the limit is taken, whether the request says how long it is or not...
    const atLimit = evalOfBytes(LIMIT);
    expect((await send(atLimit)).status).toBe(201);
    expect((await send(atLimit, { 'content-length': String(LIMIT) })).status).toBe(201);

    // ...and one byte more is not.
    const over = evalOfBytes(LIMIT + 1);
    const withAndWithoutLength: Record<string, string>[] = [
      {},
      { 'content-length': String(LIMIT + 1) },
    ];
    for (const headers of withAndWithoutLength) {
      const refused = await send(over, headers);
      expect(refused.status).toBe(413);
      expectNoStore(refused);
      expect(await refused.json()).toEqual(tooBig);
    }
    // It is bytes that count: this has fewer characters than the limit, and more bytes.
    const wide = evalWith('€'.repeat(200_000));
    expect(wide.length).toBeLessThan(LIMIT);
    expect(bytesOf(wide)).toBeGreaterThan(LIMIT);
    const refusedWide = await send(wide);
    expect(refusedWide.status).toBe(413);
    expect(await refusedWide.json()).toEqual(tooBig);

    // Who is calling is settled first: a wrong token is refused as one, and the body isn't read.
    const stranger = await send(over, { authorization: 'Bearer wrong' });
    expect(stranger.status).toBe(401);

    // Only the two that fit were kept.
    const history = await call('GET', '/datasets/api-evals-size/evals');
    expect(((await history.json()) as { evals: unknown[] }).evals).toHaveLength(2);
  });

  it('answers a body it couldn’t read as a failure, and logs why, not as one that isn’t JSON', async () => {
    // The connection drops partway through a body that said how long it would be. The body limit
    // goes by that length and leaves the reading to the route, whose read then fails.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"generation":'));
        controller.error(new Error('the connection was reset'));
      },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await api.request(
        '/datasets/api-evals-unread/evals',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-token',
            'content-type': 'application/json',
            'content-length': '64',
          },
          body,
        },
        env,
      );
      expect(response.status).toBe(500);
      expectNoStore(response);
      expect(await response.json()).toEqual({
        error: 'Something went wrong. The Worker’s logs say what.',
      });
      expect(logged).toHaveBeenCalledWith('API error:', 'the connection was reset');
    } finally {
      logged.mockRestore();
    }
  });

  it('keeps a score, and lists items, for a dataset whose stored definition went stale', async () => {
    // Scores don't read the definition, so one that no longer passes the checks doesn't stop them.
    await staleDataset('api-evals-stale');
    const saved = await call('POST', '/datasets/api-evals-stale/evals', {
      body: { generation: 1, goldenVersion: 1, scores: SCORES },
    });
    expect(saved.status).toBe(201);
    expectNoStore(saved);
    const view = (await saved.json()) as EvalView;
    const history = await call('GET', '/datasets/api-evals-stale/evals');
    expect(history.status).toBe(200);
    expect(await history.json()).toEqual({ evals: [view] });
    const items = await call('GET', '/datasets/api-evals-stale/items');
    expect(items.status).toBe(200);
    expect(((await items.json()) as { items: unknown[] }).items).toHaveLength(3);
  });

  it('answers 404 for a dataset that does not exist, not an empty list or a kept score', async () => {
    const requests = [
      ['GET', '/datasets/api-nothing/items', undefined],
      ['GET', '/datasets/api-nothing/evals', undefined],
      ['POST', '/datasets/api-nothing/evals', { generation: 1, goldenVersion: 1, scores: SCORES }],
    ] as const;
    for (const [method, path, body] of requests) {
      const missing = await call(method, path, { body });
      expect(missing.status, `${method} ${path}`).toBe(404);
      expectNoStore(missing);
      expect(await missing.json(), `${method} ${path}`).toEqual({
        error: 'Dataset api-nothing doesn’t exist.',
      });
    }
  });
});
