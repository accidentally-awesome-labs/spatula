import type { ReviewAction } from '@spatula/core';
import { heldSnapshot } from '@spatula/store';
import { testTaxonomySeed } from '@spatula/store/fixtures';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api } from '../../src/api';
import { withDatabase } from '../../src/database';
import { call, CONSUMER_TOKEN, expectNoStore, questionsIn, reviewerBindings } from './api-support';

/*
 * Who may call the review API, what an older CLI still gets from it, and how many writes it takes.
 * Bulk answers, suggestions, and the list's filters are in review-bulk.test.ts.
 */

const questions = (datasetId: string) => ({
  match0: `rv_${datasetId}_match_0`,
  match1: `rv_${datasetId}_match_1`,
  classify: `rv_${datasetId}_classify`,
  publish: `rv_${datasetId}_publish`,
});

const JOINS = 'The page joins that record at the next run.';
const NO_SCOPE = 'This needs the review:answer scope, which the owner hasn’t granted.';
const NO_REVIEWER =
  'Name the person answering in X-Spatula-Reviewer: 1 to 128 letters, digits, dots, underscores, colons, at signs, and hyphens.';
const OWNERS = 'Only the owner can do this.';
const LIMITED =
  'That’s more writes this minute than the review API takes. Wait a minute, then send the rest.';

describe('the review API', () => {
  it('still answers the review routes an older CLI calls', async () => {
    const datasetId = 'rv-older';
    await questionsIn(datasetId);
    const { match0, match1, classify, publish } = questions(datasetId);
    // As the CLI sends a request: to the Worker's address, with the owner token, and a content
    // type when there's a body.
    const older = async (method: string, path: string, body?: unknown, token = 'test-token') =>
      api.request(
        `https://spatula.test${path}`,
        {
          method,
          headers: {
            ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        env,
      );

    const listed = await older('GET', `/datasets/${datasetId}/review`);
    expect(listed.status).toBe(200);
    expectNoStore(listed);
    const { reviews } = (await listed.json()) as { reviews: Record<string, unknown>[] };
    expect(reviews.map((review) => review.id)).toEqual([match0, match1, classify, publish]);
    // A question nobody flagged, without a suggestion, has the shape it had before roles.
    for (const review of reviews) {
      expect(Object.keys(review).sort()).toEqual([
        'context',
        'createdAt',
        'id',
        'kind',
        'question',
        'subject',
      ]);
    }

    const answer = (reviewId: string, body: unknown) =>
      older('POST', `/datasets/${datasetId}/review/${reviewId}`, body);
    const same = await answer(match0, { answer: 'same' });
    expect(same.status).toBe(200);
    expectNoStore(same);
    expect(await same.json()).toEqual({ answered: match0, answer: 'same', effect: JOINS });
    const again = await answer(match0, { answer: 'same' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'That question has been answered already.' });

    const notAnOption = await answer(classify, { answer: 'Speakers' });
    expect(notAnOption.status).toBe(400);
    expect(await notAnOption.json()).toEqual({
      error: 'Answer with one of: Headphones, DAC/Amp, None of these.',
    });
    for (const body of [{ answer: 'Headphones', extra: 1 }, {}, { answer: '' }]) {
      const refused = await answer(classify, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(await refused.json(), JSON.stringify(body)).toEqual({
        error: 'Send { "answer": one of the question’s options }.',
      });
    }

    const published = await answer(publish, { answer: 'publish' });
    expect(published.status).toBe(200);
    expect(await published.json()).toEqual({
      answered: publish,
      answer: 'publish',
      effect: 'Published as generation 1.',
    });
    const nowhere = await answer('rv_nowhere', { answer: 'same' });
    expect(nowhere.status).toBe(404);
    expect(await nowhere.json()).toEqual({ error: 'No such question for this dataset.' });
    const unsigned = await older('GET', `/datasets/${datasetId}/review`, undefined, '');
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get('www-authenticate')).toBe('Bearer');
    expectNoStore(unsigned);
  });

  it('keeps consumers to the scopes they were granted', async () => {
    const datasetId = 'rv-scopes';
    const { a1 } = await questionsIn(datasetId);
    const { match0, match1, classify, publish } = questions(datasetId);
    const asCrowdio = (
      bindings: Env,
      method: string,
      path: string,
      body?: unknown,
      reviewer: string | null = 'reviewer-7',
    ) =>
      call(method, path, {
        token: CONSUMER_TOKEN,
        bindings,
        body,
        headers: reviewer === null ? {} : { 'x-spatula-reviewer': reviewer },
      });

    // Without the scope, or with another and one Spatula doesn't know, a consumer gets nothing.
    for (const scopes of ['', 'review:everything, taxonomy:approve-additive']) {
      const bindings = await reviewerBindings(scopes);
      const requests: [string, string, unknown?][] = [
        ['GET', `/datasets/${datasetId}/review`],
        ['POST', `/datasets/${datasetId}/review/${match0}`, { answer: 'same' }],
        [
          'POST',
          `/datasets/${datasetId}/review/bulk`,
          { answers: [{ reviewId: match0, answer: 'same' }] },
        ],
        ['GET', `/datasets/${datasetId}/taxonomy`],
      ];
      for (const [method, path, body] of requests) {
        const response = await asCrowdio(bindings, method, path, body);
        const name = `${method} ${path} with ${JSON.stringify(scopes)}`;
        expect(response.status, name).toBe(403);
        expectNoStore(response);
        expect(await response.json(), name).toEqual({ error: NO_SCOPE });
      }
    }

    const bindings = await reviewerBindings();
    // A read names no one. A consumer's reviewers don't see a publication question.
    const listPath = `/datasets/${datasetId}/review`;
    const listed = await asCrowdio(bindings, 'GET', listPath, undefined, null);
    expect(listed.status).toBe(200);
    const { reviews } = (await listed.json()) as { reviews: { id: string }[] };
    expect(reviews.map((review) => review.id)).toEqual([match0, match1, classify]);

    // A write names the person answering, whom the consumer's token can't tell apart.
    for (const reviewer of [null, '', 'has space', 'x'.repeat(129)]) {
      const path = `/datasets/${datasetId}/review/${match0}`;
      const response = await asCrowdio(bindings, 'POST', path, { answer: 'same' }, reviewer);
      expect(response.status, JSON.stringify(reviewer)).toBe(400);
      expectNoStore(response);
      expect(await response.json(), JSON.stringify(reviewer)).toEqual({ error: NO_REVIEWER });
    }
    const seven = await asCrowdio(bindings, 'POST', `/datasets/${datasetId}/review/${match0}`, {
      answer: 'same',
    });
    expect(seven.status).toBe(200);
    expect(await seven.json()).toEqual({ answered: match0, answer: 'same', effect: JOINS });
    // Another reviewer's "same" about the other record goes to the owner, and is gone for
    // consumers.
    const match1Path = `/datasets/${datasetId}/review/${match1}`;
    const eight = await asCrowdio(bindings, 'POST', match1Path, { answer: 'same' }, 'reviewer-8');
    expect(eight.status).toBe(202);
    expect(await eight.json()).toEqual({
      flagged: match1,
      effect: 'It differs from a person’s answer, so it waits for the owner.',
    });
    const specVersion = { answer: 'spec-version' };
    const after = await asCrowdio(bindings, 'POST', match1Path, specVersion, 'reviewer-8');
    expect(after.status).toBe(404);

    // What is the owner's stays the owner's, whatever the scope.
    const owners: [string, string, unknown, string][] = [
      [
        'POST',
        `/datasets/${datasetId}/review/${publish}`,
        { answer: 'publish' },
        'Only the owner answers a publication question.',
      ],
      [
        'POST',
        `/datasets/${datasetId}/review/suggestions`,
        { suggestions: [{ page: a1.locator, parts: {} }] },
        OWNERS,
      ],
      ['GET', `/datasets/${datasetId}/review/log`, undefined, OWNERS],
      ['POST', `/datasets/${datasetId}/taxonomy`, testTaxonomySeed(), OWNERS],
    ];
    for (const [method, path, body, error] of owners) {
      const response = await asCrowdio(bindings, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expectNoStore(response);
      expect(await response.json(), `${method} ${path}`).toEqual({ error });
    }
    expect((await asCrowdio(bindings, 'GET', `/datasets/${datasetId}/status`)).status).toBe(401);
    expect(await withDatabase(env, (db) => heldSnapshot(db, datasetId))).toMatchObject({
      id: `sn_${datasetId}`,
    });

    // The owner's log says who did what. Both writes may share a millisecond, so their order
    // isn't checked here; the store's tests check it.
    const log = await call('GET', `/datasets/${datasetId}/review/log`);
    expect(log.status).toBe(200);
    expectNoStore(log);
    const { actions } = (await log.json()) as { actions: ReviewAction[] };
    expect(actions.map((action) => `${action.action} ${action.actor.reviewer}`).sort()).toEqual([
      'answer reviewer-7',
      'flag reviewer-8',
    ]);
    expect(actions.find((action) => action.action === 'answer')?.actor).toEqual({
      role: 'reviewer',
      client: 'consumer',
      consumer: 'crowdio',
      reviewer: 'reviewer-7',
    });
  });

  it('answers a consumer’s reviewer in bulk as it would one at a time: as the reviewer, never as the owner', async () => {
    const datasetId = 'rv-actor';
    const { a2 } = await questionsIn(datasetId);
    const { match0, match1, classify, publish } = questions(datasetId);
    const bindings = await reviewerBindings();
    const asReviewer = (path: string, body: unknown, reviewer: string | null = 'reviewer-7') =>
      call('POST', `/datasets/${datasetId}${path}`, {
        token: CONSUMER_TOKEN,
        bindings,
        body,
        headers: reviewer === null ? {} : { 'x-spatula-reviewer': reviewer },
      });
    const listed = async (token?: string) => {
      const response = await call('GET', `/datasets/${datasetId}/review`, { token, bindings });
      expect(response.status).toBe(200);
      return ((await response.json()) as { reviews: { id: string; flagged?: true }[] }).reviews;
    };

    // A bulk request names the person answering too.
    const unnamed = await asReviewer(
      '/review/bulk',
      { answers: [{ reviewId: match0, answer: 'same' }] },
      null,
    );
    expect(unnamed.status).toBe(400);
    expectNoStore(unnamed);
    expect(await unnamed.json()).toEqual({ error: NO_REVIEWER });

    // A publication question is the owner's, in bulk as one at a time: the snapshot stays held.
    const publication = await asReviewer('/review/bulk', {
      answers: [{ reviewId: publish, answer: 'publish' }],
    });
    expect(publication.status).toBe(200);
    expect(await publication.json()).toEqual({
      results: [
        {
          reviewId: publish,
          status: 403,
          error: 'Only the owner answers a publication question.',
        },
      ],
    });
    expect(await withDatabase(env, (db) => heldSnapshot(db, datasetId))).toMatchObject({
      id: `sn_${datasetId}`,
    });

    // A second reviewer's join about the other record goes to the owner as a flag, not refused
    // as the owner's would be, and the flagged question is gone for consumers.
    const joined = await asReviewer(`/review/${match0}`, { answer: 'same' });
    expect(joined.status).toBe(200);
    const flagged = await asReviewer(
      '/review/bulk',
      { answers: [{ reviewId: match1, answer: 'same' }] },
      'reviewer-8',
    );
    expect(await flagged.json()).toEqual({
      results: [
        {
          reviewId: match1,
          status: 202,
          flagged: match1,
          effect: 'It differs from a person’s answer, so it waits for the owner.',
        },
      ],
    });
    expect((await listed(CONSUMER_TOKEN)).map((review) => review.id)).toEqual([classify]);
    // No consumer's answer closes it, however it's sent.
    const hidden = await asReviewer('/review/bulk', {
      answers: [
        { reviewId: match1, answer: 'spec-version' },
        { reviewId: match1, suggestion: true },
      ],
    });
    expect(await hidden.json()).toEqual({
      results: [
        { reviewId: match1, status: 404, error: 'No such question for this dataset.' },
        { reviewId: match1, status: 404, error: 'No such question for this dataset.' },
      ],
    });
    const alone = await asReviewer(`/review/${match1}`, { answer: 'unrelated' });
    expect(alone.status).toBe(404);
    expect(await alone.json()).toEqual({ error: 'No such question for this dataset.' });
    expect(await listed()).toEqual([
      expect.objectContaining({ id: match1, flagged: true }),
      expect.objectContaining({ id: classify }),
      expect.objectContaining({ id: publish }),
    ]);

    // Suggestions are the owner's: one from a reviewer puts nothing on any question.
    for (const reviewer of ['reviewer-7', null]) {
      const suggested = await asReviewer(
        '/review/suggestions',
        { suggestions: [{ page: a2.locator, parts: {} }] },
        reviewer,
      );
      expect(suggested.status, String(reviewer)).toBe(403);
      expectNoStore(suggested);
      expect(await suggested.json(), String(reviewer)).toEqual({ error: OWNERS });
    }
    for (const review of await listed()) expect(review).not.toHaveProperty('suggestion');

    // The owner closes the flagged question.
    const owner = await call('POST', `/datasets/${datasetId}/review/${match1}`, {
      body: { answer: 'spec-version' },
    });
    expect(owner.status).toBe(200);

    // The log records each write as the reviewer's who sent it, or the owner's.
    const log = await call('GET', `/datasets/${datasetId}/review/log`);
    const { actions } = (await log.json()) as { actions: ReviewAction[] };
    expect(
      actions.map((action) => `${action.action} ${action.subject} ${action.actor.role}`).sort(),
    ).toEqual(
      [`answer ${match0} reviewer`, `flag ${match1} reviewer`, `answer ${match1} owner`].sort(),
    );
    expect(actions.find((action) => action.action === 'flag')?.actor).toEqual({
      role: 'reviewer',
      client: 'consumer',
      consumer: 'crowdio',
      reviewer: 'reviewer-8',
    });
  });

  it('limits each owner’s and each reviewer’s writes, and counts a bulk request once', async () => {
    const datasetId = 'rv-limits';
    await questionsIn(datasetId);
    const { match0, match1, classify, publish } = questions(datasetId);
    // A limiter that lets two writes through, and records whose they were.
    const keys: string[] = [];
    let left = 2;
    const limiter: RateLimit = {
      limit: ({ key }) => {
        keys.push(key);
        left -= 1;
        return Promise.resolve({ success: left >= 0 });
      },
    };
    const bindings = { ...(await reviewerBindings()), REVIEW_LIMITER: limiter } as Env;

    // Reads aren't counted.
    expect((await call('GET', `/datasets/${datasetId}/review`, { bindings })).status).toBe(200);
    expect((await call('GET', `/datasets/${datasetId}/review/log`, { bindings })).status).toBe(200);
    const bulk = await call('POST', `/datasets/${datasetId}/review/bulk`, {
      bindings,
      body: {
        answers: [
          { reviewId: match0, answer: 'spec-version' },
          { reviewId: match1, answer: 'spec-version' },
        ],
      },
    });
    expect(bulk.status).toBe(200);
    const { results } = (await bulk.json()) as { results: { status: number }[] };
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    const reviewer = await call('POST', `/datasets/${datasetId}/review/${classify}`, {
      token: CONSUMER_TOKEN,
      bindings,
      headers: { 'x-spatula-reviewer': 'reviewer-7' },
      body: { answer: 'Headphones' },
    });
    expect(reviewer.status).toBe(200);

    const refused = await call('POST', `/datasets/${datasetId}/review/${publish}`, {
      bindings,
      body: { answer: 'publish' },
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expectNoStore(refused);
    expect(await refused.json()).toEqual({
      error:
        'That’s more writes this minute than the review API takes. Wait a minute, then send the rest.',
    });
    expect(keys).toEqual(['owner', 'crowdio:reviewer-7', 'owner']);
    // The write that was refused did nothing.
    expect(await withDatabase(env, (db) => heldSnapshot(db, datasetId))).toMatchObject({
      id: `sn_${datasetId}`,
    });
  });

  it('limits a consumer’s reviewers together too, so a reviewer it names anew gets no more room', async () => {
    const datasetId = 'rv-limits-consumer';
    await questionsIn(datasetId);
    const { match0, match1, classify } = questions(datasetId);
    // A limiter that takes this many writes a key, and records whose they were.
    const perKey = (limit: number) => {
      const keys: string[] = [];
      const limiter: RateLimit = {
        limit: ({ key }) => {
          keys.push(key);
          return Promise.resolve({ success: keys.filter((one) => one === key).length <= limit });
        },
      };
      return { limiter, keys };
    };
    const reviewers = perKey(120);
    const consumers = perKey(2);
    const bindings = {
      ...(await reviewerBindings()),
      REVIEW_LIMITER: reviewers.limiter,
      CONSUMER_REVIEW_LIMITER: consumers.limiter,
    } as Env;
    const asCrowdio = (reviewer: string, path: string, body: unknown) =>
      call('POST', `/datasets/${datasetId}/review/${path}`, {
        token: CONSUMER_TOKEN,
        bindings,
        headers: { 'x-spatula-reviewer': reviewer },
        body,
      });

    // Each write names a reviewer anew, whose own bucket has room, but the consumer's fills.
    expect((await asCrowdio('reviewer-1', classify, { answer: 'Headphones' })).status).toBe(200);
    expect((await asCrowdio('reviewer-2', match0, { answer: 'spec-version' })).status).toBe(200);
    const refused = await asCrowdio('reviewer-3', match1, { answer: 'spec-version' });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expectNoStore(refused);
    expect(await refused.json()).toEqual({ error: LIMITED });
    const bulk = await asCrowdio('reviewer-4', 'bulk', {
      answers: [{ reviewId: match1, answer: 'spec-version' }],
    });
    expect(bulk.status).toBe(429);
    expect(await bulk.json()).toEqual({ error: LIMITED });
    // The consumer's bucket is checked first, so a write it refuses takes nothing from a
    // reviewer's.
    expect(consumers.keys).toEqual(['crowdio', 'crowdio', 'crowdio', 'crowdio']);
    expect(reviewers.keys).toEqual(['crowdio:reviewer-1', 'crowdio:reviewer-2']);

    // The owner's writes count apart from any consumer's, and the question refused still waits.
    const owner = await call('POST', `/datasets/${datasetId}/review/${match1}`, {
      bindings,
      body: { answer: 'spec-version' },
    });
    expect(owner.status).toBe(200);
    expect(reviewers.keys.at(-1)).toBe('owner');
    expect(consumers.keys).toHaveLength(4);
  });
});
