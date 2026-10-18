import type { EvalView } from '@spatula/core';
import { testDefinition } from '@spatula/store/fixtures';
import { describe, expect, it } from 'vitest';
import { call, expectNoStore } from './api-support';

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

  it('refuses scores that spatula evals could not show, and keeps nothing', async () => {
    await call('PUT', '/datasets/api-evals-refused', { body: testDefinition('api-evals-refused') });
    const post = (body: unknown) => call('POST', '/datasets/api-evals-refused/evals', { body });
    const ok = { generation: 1, goldenVersion: 1 };
    const shape = 'Send { "generation", "goldenVersion", "scores" }.';
    const wrong: [string, unknown][] = [
      ['no generation', { goldenVersion: 1, scores: SCORES }],
      ['a generation of 0', { generation: 0, goldenVersion: 1, scores: SCORES }],
      ['a generation that is not whole', { generation: 1.5, goldenVersion: 1, scores: SCORES }],
      ['a golden version of 0', { generation: 1, goldenVersion: 0, scores: SCORES }],
      ['a key it does not know', { ...ok, scores: SCORES, note: 'checked' }],
      ['no scores', ok],
      // A partial score would break spatula evals, so it isn't kept.
      ['a partial score', { ...ok, scores: { recall: 0.9 } }],
      ['a precision above 1', { ...ok, scores: { ...SCORES, precision: 1.1 } }],
      ['a recall below 0', { ...ok, scores: { ...SCORES, recall: -0.1 } }],
      [
        'an accuracy that is not a number',
        { ...ok, scores: { ...SCORES, identifiers: { accuracy: '1' } } },
      ],
      ['key specs with no accuracy', { ...ok, scores: { ...SCORES, keySpecs: {} } }],
      ['identifiers that are not a record', { ...ok, scores: { ...SCORES, identifiers: 1 } }],
    ];
    for (const [what, body] of wrong) {
      const refused = await post(body);
      expect(refused.status, what).toBe(400);
      expectNoStore(refused);
      expect(await refused.json(), what).toEqual({ error: shape });
    }

    const notJson = await call('POST', '/datasets/api-evals-refused/evals', { body: '{ "gener' });
    expect(notJson.status).toBe(400);
    expectNoStore(notJson);
    expect(await notJson.json()).toEqual({ error: 'The body isn’t JSON.' });

    const large = await post({ ...ok, scores: { ...SCORES, misses: ['x'.repeat(600 * 1024)] } });
    expect(large.status).toBe(400);
    expectNoStore(large);
    expect(await large.json()).toEqual({ error: 'The scores are larger than 512 KB.' });

    const history = await call('GET', '/datasets/api-evals-refused/evals');
    expect(await history.json()).toEqual({ evals: [] });
  });

  it('keeps no score for a dataset that does not exist', async () => {
    const missing = await call('POST', '/datasets/api-nothing/evals', {
      body: { generation: 1, goldenVersion: 1, scores: SCORES },
    });
    expect(missing.status).toBe(404);
    expectNoStore(missing);
    expect(await missing.json()).toEqual({ error: 'Dataset api-nothing doesn’t exist.' });
  });
});
