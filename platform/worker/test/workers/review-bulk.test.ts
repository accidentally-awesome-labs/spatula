import {
  answerText,
  findItem,
  TAXONOMY_CRITERIA_VERSION,
  TAXONOMY_PROMPT,
  type ReviewAction,
  type ReviewView,
  type TaxonomySubject,
} from '@spatula/core';
import {
  applyDefinition,
  listLiveItems,
  openReview,
  recordFetch,
  saveDecision,
  seedTaxonomyVersion,
  startRun,
  statements,
} from '@spatula/store';
import { testDefinition, testTaxonomy, testTaxonomyDefinition } from '@spatula/store/fixtures';
import { env } from 'cloudflare:workers';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withDatabase } from '../../src/database';
import { MAX_BULK } from '../../src/review';
import { placeSubject } from '../../src/taxonomy';
import { call, CONSUMER_TOKEN, expectNoStore, MINUTE, reviewerBindings } from './api-support';

/*
 * The review API's answers in bulk, the owner's suggestions, and the list's filters, over taxonomy
 * questions as a run leaves them.
 */

const T = testTaxonomy();
const id = (subject: TaxonomySubject, slug: string) => {
  const found = findItem(T, subject, slug);
  if (found === undefined) throw new Error(`The test taxonomy has no ${subject} ${slug}`);
  return found.id;
};
const AT = new Date('2026-10-20T08:00:00.000Z');
const LATER = new Date(AT.getTime() + MINUTE);
const REVIEWER = { 'x-spatula-reviewer': 'reviewer-7' };
const ON_EAR = 'The page sits on Headphones › On-ear. The next run publishes it.';

/**
 * A dataset with the test taxonomy that lists crowdio, and two of its pages waiting, each read
 * once. A1 sits on Over-ear, unsure of its back, with no decision behind its question. A2 sits on
 * On-ear, unsure of its pre-amp and its back, asked under a place decision, as a run asks. It
 * opens one database client.
 */
async function waitingOnA2(datasetId: string) {
  return withDatabase(env, async (db) => {
    await applyDefinition(db, { ...testTaxonomyDefinition(datasetId), consumers: ['crowdio'] });
    await seedTaxonomyVersion(db, {
      datasetId,
      taxonomy: T,
      actor: { role: 'owner', client: 'cli' },
      at: AT,
    });
    const [a1, a2] = await listLiveItems(db, datasetId);
    if (a1 === undefined || a2 === undefined) throw new Error(`${datasetId} has no pages`);
    const runId = `rn_${datasetId}`;
    await startRun(db, { id: runId, datasetId });
    for (const item of [a1, a2]) {
      await recordFetch(db, {
        id: `fe_${item.id}`,
        runId,
        itemId: item.id,
        url: item.locator,
        finalUrl: null,
        policy: 'allowed',
        policyReason: null,
        method: 'http',
        outcome: 'changed',
        httpStatus: 200,
        bytes: 100,
        signals: null,
        startedAt: AT,
        durationMs: 10,
        error: null,
        page: { contentHash: `hash-${item.id}`, etag: null, lastModified: null },
      });
    }
    const back = id('feature', 'back');
    const open = id('value', 'open');
    const closed = id('value', 'closed');
    const overEar = { shelf: id('shelf', 'over-ear'), functions: [], values: [] };
    const a1Review = `rv_${datasetId}_a1`;
    await openReview(db, {
      id: a1Review,
      datasetId,
      kind: 'classify',
      subject: a1.id,
      itemId: a1.id,
      question: {
        type: 'taxonomy',
        prompt: TAXONOMY_PROMPT,
        parts: { shelves: [], functions: [], features: { [back]: [open, closed] } },
      },
      context: {
        url: a1.locator,
        field: 'taxonomy',
        version: 1,
        proposed: overEar,
        settled: overEar,
        probabilities: { [`value:${open}`]: 0.7, [`value:${closed}`]: 0.2 },
        reason: 'Its cups sit over the ears.',
        captureId: `cp_${datasetId}_a1`,
      },
      at: AT,
    });
    const parts = {
      shelves: [],
      functions: [id('function', 'pre-amp')],
      features: { [back]: [open, closed] },
    };
    const question = { type: 'taxonomy' as const, prompt: TAXONOMY_PROMPT, parts };
    const settled = { shelf: id('shelf', 'on-ear'), functions: [], values: [] };
    const probabilities = {
      [`shelf:${id('shelf', 'on-ear')}`]: 0.95,
      [`function:${id('function', 'pre-amp')}`]: 0.5,
      [`value:${open}`]: 0.6,
      [`value:${closed}`]: 0.35,
    };
    const decisionId = `dc_${datasetId}_a2`;
    await saveDecision(db, {
      id: decisionId,
      datasetId,
      type: 'taxonomy',
      subject: a2.id,
      subjectKey: placeSubject(a2.id),
      state: { page: { url: a2.locator }, rule: null, key: 'before', asked: parts },
      stateHash: 'before',
      question,
      criteriaVersion: TAXONOMY_CRITERIA_VERSION,
      adapter: null,
      probabilities,
      evidence: 'It rests on the ears.',
      thresholds: { accept: 0.9 },
      outcome: 'escalated',
      answer: answerText(settled),
      inputTokens: 0,
      outputTokens: 0,
      decidedAt: AT,
    });
    const reviewId = `rv_${datasetId}_a2`;
    const context = {
      url: a2.locator,
      field: 'taxonomy',
      version: 1,
      proposed: { ...settled, values: [open] },
      settled,
      probabilities,
      reason: 'It rests on the ears.',
      captureId: `cp_${datasetId}_a2`,
    };
    await openReview(db, {
      id: reviewId,
      datasetId,
      kind: 'classify',
      subject: a2.id,
      itemId: a2.id,
      decisionId,
      question,
      context,
      at: LATER,
    });
    return { a1, a2, a1Review, reviewId, question, context };
  });
}

/** What people said of a page, current, as "property value", sorted. */
const humanSaid = (itemId: string) =>
  withDatabase(env, async (db) =>
    (
      await db
        .select({ property: statements.property, value: statements.value })
        .from(statements)
        .where(
          and(
            eq(statements.itemId, itemId),
            eq(statements.method, 'human'),
            isNull(statements.withdrawnAt),
          ),
        )
    )
      .map((row) => `${row.property} ${String(row.value)}`)
      .sort(),
  );

describe('the review API in bulk', () => {
  it('puts the owner’s suggestions on questions, and takes a reviewer’s answers in bulk, each on its own', async () => {
    const datasetId = 'rv-bulk';
    const { a1, a2, reviewId, question, context } = await waitingOnA2(datasetId);
    const bindings = await reviewerBindings();
    const nowhere = 'https://maker-a.example/products/nowhere';
    const suggested = await call('POST', `/datasets/${datasetId}/review/suggestions`, {
      body: {
        suggestions: [
          { page: a2.locator, parts: { functions: ['pre-amp'], features: { back: ['open'] } } },
          { page: nowhere, parts: {} },
          { page: a1.locator, parts: { shelf: 'dacs' } },
        ],
      },
    });
    expect(suggested.status).toBe(200);
    expectNoStore(suggested);
    expect(await suggested.json()).toEqual({
      suggestions: [
        { page: a2.locator, status: 200, reviewId },
        { page: nowhere, status: 404, error: 'No open question about this page.' },
        {
          page: a1.locator,
          status: 400,
          error: 'This question doesn’t ask for the shelf: it’s settled.',
        },
      ],
    });
    // Kept by ID, as it was checked.
    const suggestion = {
      functions: [id('function', 'pre-amp')],
      features: { [id('feature', 'back')]: [id('value', 'open')] },
    };

    // The owner sees the captures questions cite; a reviewer sees the question and its suggestion.
    const owner = await call('GET', `/datasets/${datasetId}/review`);
    const { reviews } = (await owner.json()) as { reviews: ReviewView[] };
    expect(reviews.map((review) => review.context.captureId)).toEqual([
      `cp_${datasetId}_a1`,
      `cp_${datasetId}_a2`,
    ]);
    const onEar = await call('GET', `/datasets/${datasetId}/review?shelf=on-ear`, {
      token: CONSUMER_TOKEN,
      bindings,
    });
    expect(onEar.status).toBe(200);
    const { captureId, ...seen } = context;
    expect(captureId).toBe(`cp_${datasetId}_a2`);
    expect(await onEar.json()).toEqual({
      reviews: [
        {
          id: reviewId,
          kind: 'classify',
          subject: a2.id,
          question,
          context: seen,
          createdAt: LATER.toISOString(),
          suggestion,
        },
      ],
    });

    // Each answer is taken on its own: one missing, one refused, the suggestion taken, and the
    // same parts again, which find the question answered.
    const bulk = await call('POST', `/datasets/${datasetId}/review/bulk`, {
      token: CONSUMER_TOKEN,
      bindings,
      headers: REVIEWER,
      body: {
        answers: [
          { reviewId: 'rv_nowhere', suggestion: true },
          { reviewId, answer: 'Headphones' },
          { reviewId, suggestion: true },
          { reviewId, parts: { functions: ['pre-amp'], features: { back: ['open'] } } },
        ],
        note: 'From the maker’s sheet.',
      },
    });
    expect(bulk.status).toBe(200);
    expectNoStore(bulk);
    expect(await bulk.json()).toEqual({
      results: [
        { reviewId: 'rv_nowhere', status: 404, error: 'No such question for this dataset.' },
        { reviewId, status: 400, error: 'A taxonomy question is answered part by part.' },
        { reviewId, status: 200, answered: reviewId, effect: ON_EAR },
        { reviewId, status: 409, error: 'That question has been answered already.' },
      ],
    });
    expect(await humanSaid(a2.id)).toEqual(
      [
        `features ${id('value', 'open')}`,
        `functions ${id('function', 'pre-amp')}`,
        `shelf ${id('shelf', 'on-ear')}`,
      ].sort(),
    );

    // The log has the owner's suggestion and the reviewer's answer, with its note.
    const log = await call('GET', `/datasets/${datasetId}/review/log`);
    const { actions } = (await log.json()) as { actions: ReviewAction[] };
    const who = actions.map(
      (action) => `${action.action} ${action.actor.reviewer ?? action.actor.role}`,
    );
    expect(who.sort()).toEqual(['answer reviewer-7', 'suggest owner']);
    expect(actions.find((action) => action.action === 'suggest')?.detail).toEqual({
      page: a2.locator,
      parts: suggestion,
    });
    expect(actions.find((action) => action.action === 'answer')?.detail).toMatchObject({
      kind: 'classify',
      about: a2.id,
      effect: ON_EAR,
      note: 'From the maker’s sheet.',
    });

    // A reviewer reads the taxonomy the questions are asked in.
    const taxonomy = await call('GET', `/datasets/${datasetId}/taxonomy`, {
      token: CONSUMER_TOKEN,
      bindings,
    });
    expect(taxonomy.status).toBe(200);
    expect(await taxonomy.json()).toMatchObject({ version: 1 });

    // The owner replaces the reviewer's answer in bulk, as one at a time.
    const replaced = await call('POST', `/datasets/${datasetId}/review/bulk`, {
      body: { answers: [{ reviewId, parts: { features: { back: ['closed'] } } }] },
    });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual({
      results: [
        {
          reviewId,
          status: 200,
          answered: reviewId,
          effect: `It replaces a reviewer’s answer. ${ON_EAR}`,
        },
      ],
    });
    expect(await humanSaid(a2.id)).toEqual(
      [`features ${id('value', 'closed')}`, `shelf ${id('shelf', 'on-ear')}`].sort(),
    );
  });

  it('refuses a bulk request, or suggestions, it can’t read, whole', async () => {
    const datasetId = 'rv-bulk-shapes';
    await call('PUT', `/datasets/${datasetId}`, { body: testDefinition(datasetId) });
    const path = `/datasets/${datasetId}/review/bulk`;
    const many = Array.from({ length: MAX_BULK + 1 }, (_, n) => ({
      reviewId: `rv_${n}`,
      answer: 'same',
    }));
    for (const body of [
      { answers: [] },
      { answers: many },
      { answers: [{ reviewId: 'rv_x' }] },
      { answers: [{ reviewId: 'rv_x', answer: 'same', parts: {} }] },
      { answers: [{ reviewId: 'rv_x', suggestion: false }] },
      { answers: [{ reviewId: 'rv_x', answer: 'same' }], extra: 1 },
    ]) {
      const response = await call('POST', path, { body });
      const name = JSON.stringify(body).slice(0, 80);
      expect(response.status, name).toBe(400);
      expectNoStore(response);
      expect(await response.json(), name).toEqual({
        error: expect.stringMatching(/^The request is wrong/u),
      });
    }
    const notJson = await call('POST', path, { body: 'not json' });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: 'The body isn’t JSON.' });
    for (const body of [{ suggestions: [] }, { suggestions: [{ page: 'x' }] }]) {
      const response = await call('POST', `/datasets/${datasetId}/review/suggestions`, { body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    // A dataset that isn't there has no questions, but a 404 for each answer would read as each
    // question missing.
    const missing = await call('POST', '/datasets/rv-bulk-nothing/review/bulk', {
      body: { answers: [{ reviewId: 'rv_x', answer: 'same' }] },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Dataset rv-bulk-nothing doesn’t exist.' });
  });

  it('lists questions by kind, shelf, source, and how sure the decider was, and refuses a filter it can’t read', async () => {
    const datasetId = 'rv-bulk-filters';
    const { a1Review, reviewId } = await waitingOnA2(datasetId);
    const ids = async (query: string) => {
      const response = await call('GET', `/datasets/${datasetId}/review${query}`);
      expect(response.status, query).toBe(200);
      return ((await response.json()) as { reviews: { id: string }[] }).reviews.map(
        (review) => review.id,
      );
    };
    expect(await ids('')).toEqual([a1Review, reviewId]);
    // A shelf by its slug or its ID.
    expect(await ids('?shelf=on-ear')).toEqual([reviewId]);
    expect(await ids(`?shelf=${id('shelf', 'over-ear')}`)).toEqual([a1Review]);
    // A1's likeliest part is at 0.7, and A2's at 0.6: its shelf, at 0.95, isn't asked.
    expect(await ids('?below=0.65')).toEqual([reviewId]);
    expect(await ids('?kind=match')).toEqual([]);
    expect(await ids('?kind=classify&source=maker-a&below=1')).toEqual([a1Review, reviewId]);
    expect(await ids('?source=maker-b')).toEqual([]);
    for (const query of [
      '?kind=other',
      '?below=0',
      '?below=1.5',
      '?below=most',
      '?shelf=nowhere',
      '?colour=red',
    ]) {
      const response = await call('GET', `/datasets/${datasetId}/review${query}`);
      expect(response.status, query).toBe(400);
      expectNoStore(response);
    }
    const nowhere = await call('GET', `/datasets/${datasetId}/review?shelf=nowhere`);
    expect(await nowhere.json()).toEqual({ error: `${datasetId} has no shelf nowhere.` });
    // A dataset without a taxonomy has no shelves to filter by.
    await call('PUT', '/datasets/rv-bulk-plain', { body: testDefinition('rv-bulk-plain') });
    const plain = await call('GET', '/datasets/rv-bulk-plain/review?shelf=on-ear');
    expect(plain.status).toBe(400);
    expect(await plain.json()).toEqual({ error: 'rv-bulk-plain has no shelf on-ear.' });
  });
});
