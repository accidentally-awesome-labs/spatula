import { sha256Hex, type DatasetStatus } from '@spatula/core';
import { acknowledgments } from '@spatula/store';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withDatabase } from '../../src/database';
import {
  acknowledge,
  applied,
  call,
  CONSUMER_KEY,
  CONSUMER_TOKEN,
  consumerBindings,
  expectNoStore,
  MINUTE,
  post,
  signed,
  subscribed,
} from './api-support';

/*
 * What a consumer says of a snapshot, and what Spatula answers. How a signature, a body, and a
 * time are checked is in acknowledgment-checks.test.ts.
 */

describe('acknowledgments', () => {
  it('are taken once per generation, signed, and recent', async () => {
    await subscribed('ak-once');
    const body = {
      generation: 1,
      snapshotId: 'sn_ak-once',
      outcome: 'applied',
      sentAt: new Date().toISOString(),
      counts: { linked: 0 },
    };
    const first = await acknowledge('ak-once', body);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ acknowledged: 1 });
    expect((await acknowledge('ak-once', body)).status).toBe(200);
    expect((await acknowledge('ak-once', { ...body, outcome: 'refused' })).status).toBe(409);
    expect((await acknowledge('ak-once', body, false)).status).toBe(401);
    expect((await acknowledge('ak-once', { ...body, generation: 2 })).status).toBe(404);
    expect((await acknowledge('ak-once', { ...body, snapshotId: 'sn_other' })).status).toBe(400);
    const stale = {
      ...body,
      generation: 1,
      sentAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    };
    expect((await acknowledge('ak-once', stale)).status).toBe(400);
    // The owner reads snapshots too, but acknowledgments come from consumers.
    expect(
      (
        await call('POST', '/datasets/ak-once/acknowledgments', {
          body,
          bindings: await consumerBindings(),
        })
      ).status,
    ).toBe(403);

    const status = await call('GET', '/datasets/ak-once/status', {
      bindings: await consumerBindings(),
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      dataset: 'ak-once',
      headGeneration: 1,
      held: null,
      reviews: { classify: 0, match: 0, publication: 0 },
      consumers: [{ name: 'crowdio', generation: 1, outcome: 'applied' }],
    });
  });

  it('answer in the words Crowdio reads', async () => {
    await subscribed('ak-words');
    const body = applied('ak-words');
    // Every answer is private, whatever it says.
    const answer = async (response: Response) => {
      expectNoStore(response);
      return [response.status, await response.json()];
    };
    expect(await answer(await acknowledge('ak-words', body))).toEqual([201, { acknowledged: 1 }]);
    expect(await answer(await acknowledge('ak-words', body))).toEqual([200, { acknowledged: 1 }]);
    expect(await answer(await acknowledge('ak-words', { ...body, outcome: 'refused' }))).toEqual([
      409,
      { error: 'Generation 1 was acknowledged differently.' },
    ]);
    expect(await answer(await acknowledge('ak-words', { ...body, generation: 2 }))).toEqual([
      404,
      { error: 'Generation 2 isn’t published.' },
    ]);
    expect(await answer(await acknowledge('ak-words', { ...body, snapshotId: 'sn_x' }))).toEqual([
      400,
      { error: 'Generation 1 isn’t snapshot sn_x.' },
    ]);
    expect(await answer(await acknowledge('ak-words', body, false))).toEqual([
      401,
      { error: 'The signature is missing or wrong.' },
    ]);
    const owner = await call('POST', '/datasets/ak-words/acknowledgments', {
      body,
      bindings: await consumerBindings(),
    });
    expect(await answer(owner)).toEqual([403, { error: 'Acknowledgments come from consumers.' }]);
  });

  it('keep what a refusal says, and its detail, so the owner can see it', async () => {
    await subscribed('ak-refused');
    // Sent five minutes ago, which is inside the window, so the two times can be told apart.
    const sentAt = new Date(Date.now() - 5 * MINUTE).toISOString();
    const refused = await acknowledge(
      'ak-refused',
      applied('ak-refused', {
        outcome: 'refused',
        detail: 'x'.repeat(500),
        counts: { linked: 2, skipped: 0 },
        sentAt,
      }),
    );
    expect(refused.status).toBe(201);
    // The detail and the counts are kept for later slices to show, with the two times.
    const [kept] = await withDatabase(env, (db) =>
      db.select().from(acknowledgments).where(eq(acknowledgments.datasetId, 'ak-refused')),
    );
    expect(kept).toMatchObject({
      consumer: 'crowdio',
      generation: 1,
      snapshotId: 'sn_ak-refused',
      outcome: 'refused',
      detail: 'x'.repeat(500),
      counts: { linked: 2, skipped: 0 },
    });
    // What the consumer said, and when Spatula heard it by its own clock.
    expect(kept!.sentAt.toISOString()).toBe(sentAt);
    expect(Math.abs(Date.now() - kept!.receivedAt.getTime())).toBeLessThan(60_000);
    expect(kept!.bodySha256).toMatch(/^[0-9a-f]{64}$/u);
    const status = (await (
      await call('GET', '/datasets/ak-refused/status', { bindings: await consumerBindings() })
    ).json()) as DatasetStatus;
    expect(status.consumers).toEqual([
      {
        name: 'crowdio',
        generation: 1,
        outcome: 'refused',
        receivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u),
      },
    ]);
  });

  it('are refused from a token that is missing, wrong, or not listed for the dataset', async () => {
    await subscribed('ak-token');
    // Lists nobody, so crowdio's token is no better here than a wrong one.
    await subscribed('ak-unlisted', []);
    const attempts: [string, string, Record<string, string>][] = [
      ['no token', 'ak-token', {}],
      ['a wrong token', 'ak-token', { authorization: 'Bearer wrong' }],
      [
        'a token that is not a bearer token',
        'ak-token',
        { authorization: `Basic ${CONSUMER_TOKEN}` },
      ],
      [
        'a consumer the dataset does not list',
        'ak-unlisted',
        { authorization: `Bearer ${CONSUMER_TOKEN}` },
      ],
      ['a dataset that is not there', 'ak-nothing', { authorization: `Bearer ${CONSUMER_TOKEN}` }],
    ];
    for (const [name, datasetId, headers] of attempts) {
      const text = JSON.stringify(applied(datasetId));
      // The signature is right, so the token is what is refused.
      const response = await post(datasetId, text, { ...headers, ...(await signed(text)) });
      expect(response.status, name).toBe(401);
      expect(response.headers.get('www-authenticate'), name).toBe('Bearer');
      expectNoStore(response);
      expect(await response.json(), name).toEqual({ error: 'The token is missing or wrong.' });
    }
  });

  it('say so when a consumer has no HMAC key yet', async () => {
    await subscribed('ak-nokey');
    const datasetId = 'ak-nokey';
    const text = JSON.stringify(applied(datasetId));
    const hash = await sha256Hex(CONSUMER_TOKEN);
    // The test bindings set crowdio's key to nothing (vitest.workers.config.ts), so a key that is
    // not set at all is a copy of them with the key taken out.
    const unset = { ...env, CONSUMER_CROWDIO_TOKEN_HASH: hash } as Record<string, unknown>;
    delete unset.CONSUMER_CROWDIO_HMAC_KEY;
    expect('CONSUMER_CROWDIO_HMAC_KEY' in unset).toBe(false);
    // A key that is not set, and one that is set to nothing, are one case.
    for (const keyless of [
      unset as unknown as Env,
      { ...env, CONSUMER_CROWDIO_TOKEN_HASH: hash, CONSUMER_CROWDIO_HMAC_KEY: '' } as Env,
    ]) {
      const response = await post(
        datasetId,
        text,
        { authorization: `Bearer ${CONSUMER_TOKEN}`, ...(await signed(text)) },
        keyless,
      );
      expect(response.status).toBe(503);
      expectNoStore(response);
      expect(await response.json()).toEqual({ error: 'crowdio has no HMAC key yet.' });
    }
    // Reading needs no key.
    const read = await call('GET', `/datasets/${datasetId}/snapshots/latest`, {
      token: CONSUMER_TOKEN,
      bindings: unset as unknown as Env,
    });
    expect(read.status).toBe(200);
  });

  it('are recorded under the consumer whose token was sent, signed with its own key', async () => {
    const datasetId = 'ak-two';
    await subscribed(datasetId, ['crowdio', 'other-app']);
    // Names in capitals, with underscores for hyphens: other-app's are CONSUMER_OTHER_APP_….
    const both = {
      ...(await consumerBindings()),
      CONSUMER_OTHER_APP_TOKEN_HASH: await sha256Hex('other-token'),
      CONSUMER_OTHER_APP_HMAC_KEY: 'other-key',
    } as Env;
    const text = JSON.stringify(applied(datasetId));

    // other-app's token with crowdio's key is a signature that is wrong for other-app.
    const wrongKey = await post(
      datasetId,
      text,
      { authorization: 'Bearer other-token', ...(await signed(text, CONSUMER_KEY)) },
      both,
    );
    expect(wrongKey.status).toBe(401);
    expect(await wrongKey.json()).toEqual({ error: 'The signature is missing or wrong.' });

    const right = await post(
      datasetId,
      text,
      { authorization: 'Bearer other-token', ...(await signed(text, 'other-key')) },
      both,
    );
    expect(right.status).toBe(201);

    const status = (await (
      await call('GET', `/datasets/${datasetId}/status`, { bindings: both })
    ).json()) as DatasetStatus;
    expect(status.consumers).toEqual([
      { name: 'crowdio', generation: null, outcome: null, receivedAt: null },
      { name: 'other-app', generation: 1, outcome: 'applied', receivedAt: expect.any(String) },
    ]);
  });
});
