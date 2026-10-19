import { sha256Hex } from '@spatula/core';
import { holdSnapshot, openReview } from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { withDatabase } from '../../src/database';
import { PUBLISH_QUESTION } from '../../src/publish';
import {
  acknowledge,
  applied,
  call,
  CONSUMER_TOKEN,
  consumerBindings,
  expectNoStore,
  post,
  signed,
  staleDataset,
  subscribed,
} from './api-support';

/*
 * Who may read a dataset's snapshots, and the owner's view of where a dataset stands. The
 * acknowledgments themselves are in acknowledgments.test.ts and acknowledgment-checks.test.ts.
 */

describe('consumers', () => {
  it('read the snapshots of the datasets that list them, and nothing else', async () => {
    await subscribed('cr-listed');
    await call('PUT', '/datasets/cr-not-listed', { body: testDefinition('cr-not-listed') });
    const bindings = await consumerBindings();
    const read = await call('GET', '/datasets/cr-listed/snapshots/latest', {
      token: CONSUMER_TOKEN,
      bindings,
    });
    expect(read.status).toBe(200);
    expectNoStore(read);
    for (const [method, path] of [
      ['GET', '/datasets/cr-not-listed/snapshots/latest'],
      ['GET', '/datasets/cr-listed/review'],
      ['POST', '/datasets/cr-listed/runs'],
      ['POST', '/datasets/cr-listed/sources/revive'],
      ['GET', '/datasets/cr-listed/status'],
      ['GET', '/datasets/cr-listed/items'],
      ['POST', '/datasets/cr-listed/evals'],
      ['GET', '/datasets/cr-listed/evals'],
    ] as const) {
      const response = await call(method, path, { token: CONSUMER_TOKEN, bindings });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it('read the scheme of a consumer’s token in any case, and the token exactly', async () => {
    await subscribed('cr-scheme');
    const bindings = await consumerBindings();
    const read = async (authorization: string) =>
      (await call('GET', '/datasets/cr-scheme/snapshots/latest', { authorization, bindings }))
        .status;
    expect(await read(`bearer ${CONSUMER_TOKEN}`)).toBe(200);
    expect(await read(`BEARER ${CONSUMER_TOKEN}`)).toBe(200);
    expect(await read(`Bearer ${CONSUMER_TOKEN.toUpperCase()}`)).toBe(401);
  });

  it('read with a hash set in capitals, and tell a token from a hash', async () => {
    await subscribed('cr-hash');
    const upper = {
      ...env,
      CONSUMER_CROWDIO_TOKEN_HASH: (await sha256Hex(CONSUMER_TOKEN)).toUpperCase(),
    } as Env;
    const read = (token: string) =>
      call('GET', '/datasets/cr-hash/snapshots/latest', { token, bindings: upper });
    expect((await read(CONSUMER_TOKEN)).status).toBe(200);
    // The hash is what the Worker keeps, not what a consumer sends.
    expect((await read(await sha256Hex(CONSUMER_TOKEN))).status).toBe(401);
    // The owner's is read the same way on these routes as on the others.
    const ownerUpper = {
      ...env,
      OWNER_TOKEN_HASH: (await sha256Hex('test-token')).toUpperCase(),
    } as Env;
    const asOwner = await call('GET', '/datasets/cr-hash/snapshots/latest', {
      bindings: ownerUpper,
    });
    expect(asOwner.status).toBe(200);
  });

  it('compare the whole of a token’s hash, not a part of it', async () => {
    await subscribed('cr-near');
    const hash = await sha256Hex(CONSUMER_TOKEN);
    const ownerHash = await sha256Hex('test-token');
    const flip = (text: string, at: number) =>
      `${text.slice(0, at)}${text[at] === '0' ? '1' : '0'}${text.slice(at + 1)}`;
    const nearMisses = (right: string): [string, string][] => [
      ['the last digit', flip(right, 63)],
      ['the first digit', flip(right, 0)],
      ['a digit in the middle', flip(right, 32)],
      ['one digit more', `${right}0`],
      ['one digit fewer', right.slice(0, 63)],
      ['only the first eight digits', right.slice(0, 8)],
    ];
    const read = (token: string, using: Env) =>
      call('GET', '/datasets/cr-near/snapshots/latest', { token, bindings: using });
    for (const [name, stored] of nearMisses(hash)) {
      const using = { ...env, CONSUMER_CROWDIO_TOKEN_HASH: stored } as Env;
      expect(
        (await read(CONSUMER_TOKEN, using)).status,
        `a consumer hash that differs in ${name}`,
      ).toBe(401);
    }
    for (const [name, stored] of nearMisses(ownerHash)) {
      const using = { ...env, OWNER_TOKEN_HASH: stored } as Env;
      expect(
        (await read('test-token', using)).status,
        `an owner hash that differs in ${name}`,
      ).toBe(401);
    }
  });

  it('do not take a request with no token for a token whose hash is that of nothing', async () => {
    await subscribed('cr-empty');
    const nothing = await sha256Hex('');
    const using = {
      ...env,
      OWNER_TOKEN_HASH: nothing,
      CONSUMER_CROWDIO_TOKEN_HASH: nothing,
    } as Env;
    for (const authorization of [undefined, 'Bearer', 'Bearer ', 'bearer  ']) {
      const response = await call('GET', '/datasets/cr-empty/snapshots/latest', {
        token: null,
        authorization,
        bindings: using,
      });
      expect(response.status, `authorization ${JSON.stringify(authorization)}`).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  it('answer a stored definition that no longer passes the checks as a dataset that is not there', async () => {
    const datasetId = 'cr-stale';
    await subscribed(datasetId);
    // A later version's stricter checks would leave a stored definition like this one, with the
    // consumer still listed beside the name that fails.
    await staleDataset(datasetId, ['crowdio']);
    const bindings = await consumerBindings();
    const text = JSON.stringify(applied(datasetId));
    const responses = [
      await call('GET', `/datasets/${datasetId}/snapshots/latest`, {
        token: 'garbage',
        bindings,
      }),
      await call('GET', `/datasets/${datasetId}/snapshots/latest`, {
        token: CONSUMER_TOKEN,
        bindings,
      }),
      // Crowdio reads any 409 on this route as another body for the generation.
      await post(datasetId, text, {
        authorization: `Bearer ${CONSUMER_TOKEN}`,
        ...(await signed(text)),
      }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expectNoStore(response);
      expect(await response.json()).toEqual({ error: 'The token is missing or wrong.' });
    }
    // The owner has the token for everything, and a stale definition doesn't keep it from reading.
    const owner = await call('GET', `/datasets/${datasetId}/snapshots/latest`, { bindings });
    expect(owner.status).toBe(200);
  });

  it('keep a route of a consumer route’s shape behind the owner’s token when its method differs', async () => {
    const datasetId = 'cr-methods';
    await subscribed(datasetId);
    const bindings = await consumerBindings();
    const shapes = [
      ['POST', `/datasets/${datasetId}/snapshots/latest`],
      ['PUT', `/datasets/${datasetId}/snapshots/1`],
      ['DELETE', `/datasets/${datasetId}/snapshots/1`],
      ['GET', `/datasets/${datasetId}/acknowledgments`],
      ['PUT', `/datasets/${datasetId}/acknowledgments`],
    ] as const;
    for (const [method, path] of shapes) {
      for (const token of [null, 'wrong', CONSUMER_TOKEN]) {
        const response = await call(method, path, { token, bindings });
        const name = `${method} ${path} with ${token ?? 'no token'}`;
        // It is the owner's guard that answers, not the consumers'.
        expect(response.status, name).toBe(401);
        expect(response.headers.get('www-authenticate'), name).toBe('Bearer');
        expectNoStore(response);
        expect(await response.json(), name).toEqual({
          error: 'The owner token is missing or wrong.',
        });
      }
      // The owner gets past the guard, to a path that nothing answers.
      expect((await call(method, path, { bindings })).status).toBe(404);
    }
    // A HEAD request is the GET route's, but it is not a GET, so it is the owner's alone too.
    const head = `/datasets/${datasetId}/snapshots/latest`;
    const refused = await call('HEAD', head, { token: CONSUMER_TOKEN, bindings });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe('Bearer');
    expect((await call('HEAD', head, { bindings })).status).toBe(200);
  });

  it('keep a path shaped like the snapshot route’s, but not one of its forms, behind the owner’s token', async () => {
    const datasetId = 'cr-forms';
    await subscribed(datasetId);
    const bindings = await consumerBindings();
    // The route takes `latest` and a generation of up to nine digits from 1, and answers any other
    // with a 400 of its own. A route added later at one of these paths is the owner's until it is
    // added to the guard's table.
    for (const form of ['other', 'LATEST', '0', '01', '-1', '1.5', '1234567890', 'latest.json']) {
      const path = `/datasets/${datasetId}/snapshots/${form}`;
      for (const token of [null, 'wrong', CONSUMER_TOKEN]) {
        const response = await call('GET', path, { token, bindings });
        const name = `${path} with ${token ?? 'no token'}`;
        expect(response.status, name).toBe(401);
        expect(response.headers.get('www-authenticate'), name).toBe('Bearer');
        expectNoStore(response);
        expect(await response.json(), name).toEqual({
          error: 'The owner token is missing or wrong.',
        });
      }
      // The owner gets past the guard, to the route's own refusal.
      const owner = await call('GET', path, { bindings });
      expect(owner.status, path).toBe(400);
      expect(await owner.json(), path).toEqual({
        error: 'A generation is a whole number from 1, or latest.',
      });
    }
    // The forms it takes stay open to a listed consumer, up to its own answer.
    for (const [form, status] of [
      ['latest', 200],
      ['1', 200],
      ['999999999', 404],
    ] as const) {
      const response = await call('GET', `/datasets/${datasetId}/snapshots/${form}`, {
        token: CONSUMER_TOKEN,
        bindings,
      });
      expect(response.status, form).toBe(status);
    }
  });
});

describe('the status of a dataset', () => {
  // No run has blocked the test definition's sources, maker-a and maker-b.
  const live = { blockedRuns: 0, refusedAt: null, lastProbeAt: null, lastProbe: null };

  it('says where it stands: its head, what is held, what waits, and what consumers acknowledged', async () => {
    const datasetId = 'cr-status';
    await subscribed(datasetId, ['crowdio', 'quiet']);
    const question = { type: 'choice' as const, prompt: 'Which?', options: ['a', 'b'] };
    await withDatabase(env, async (db) => {
      await holdSnapshot(db, {
        id: 'sn_status_held',
        datasetId,
        runId: null,
        revision: 1,
        recordCount: 7,
        recordsSha256: 'held',
        key: `datasets/${datasetId}/held/sn_status_held.json`,
        sha256: 'held',
        bytes: 10,
        heldReason: 'the dataset’s approval is manual',
        report: { excluded: [] },
        at: new Date('2026-10-10T00:01:00.000Z'),
        review: { id: 'rv_status_held', question: PUBLISH_QUESTION, context: {} },
      });
      for (const [kind, subject] of [
        ['classify', 'it_one'],
        ['classify', 'it_two'],
        ['match', 'it_three|sp_one'],
      ] as const) {
        await openReview(db, {
          id: `rv_status_${subject}`,
          datasetId,
          kind,
          subject,
          question,
          context: {},
          at: new Date('2026-10-10T00:02:00.000Z'),
        });
      }
    });
    await acknowledge(datasetId, applied(datasetId, { outcome: 'refused' }));

    const response = await call('GET', `/datasets/${datasetId}/status`);
    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(await response.json()).toEqual({
      dataset: datasetId,
      revision: 1,
      headGeneration: 1,
      held: {
        snapshotId: 'sn_status_held',
        records: 7,
        reason: 'the dataset’s approval is manual',
        createdAt: '2026-10-10T00:01:00.000Z',
      },
      reviews: { classify: 2, match: 1, publication: 1 },
      consumers: [
        {
          name: 'crowdio',
          generation: 1,
          outcome: 'refused',
          receivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u),
        },
        { name: 'quiet', generation: null, outcome: null, receivedAt: null },
      ],
      sources: [
        { id: 'maker-a', ...live },
        { id: 'maker-b', ...live },
      ],
    });
  });

  it('says that nothing is published, held, or waiting for a dataset that is new', async () => {
    await call('PUT', '/datasets/cr-status-new', {
      body: { ...testDefinition('cr-status-new'), consumers: ['crowdio'] },
    });
    const response = await call('GET', '/datasets/cr-status-new/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      dataset: 'cr-status-new',
      revision: 1,
      headGeneration: 0,
      held: null,
      reviews: { classify: 0, match: 0, publication: 0 },
      consumers: [{ name: 'crowdio', generation: null, outcome: null, receivedAt: null }],
      sources: [
        { id: 'maker-a', ...live },
        { id: 'maker-b', ...live },
      ],
    });
  });

  it('answers 404 for a dataset that is not there, and 401 to anyone but the owner', async () => {
    const missing = await call('GET', '/datasets/cr-status-nothing/status');
    expect(missing.status).toBe(404);
    expectNoStore(missing);
    expect(await missing.json()).toEqual({ error: 'Dataset cr-status-nothing doesn’t exist.' });
    for (const token of [null, 'wrong']) {
      const refused = await call('GET', '/datasets/cr-status-new/status', { token });
      expect(refused.status).toBe(401);
      expect(refused.headers.get('www-authenticate')).toBe('Bearer');
      expectNoStore(refused);
    }
  });
});
