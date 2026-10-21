import {
  answerText,
  applyChanges,
  findItem,
  orderedShelves,
  readFinalAnswer,
  stableId,
  type ActorRecord,
  type GivenParts,
  type Question,
  type TaxonomySubject,
} from '@spatula/core';
import {
  commitTaxonomy,
  decisionRecords,
  getReview,
  items,
  listActions,
  listLiveItems,
  listOpenReviews,
  openReview,
  reviveItems,
  statements,
} from '@spatula/store';
import { testTaxonomy, testTaxonomyDefinition } from '@spatula/store/fixtures';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import { fakeTaxonomyDecider, makeWorld } from '../test/node/fakes';
import { refresh, taxonomyWorld } from '../test/node/runs';
import { A2, taxonomyFor, URLS } from '../test/pages';
import { answerReview, answerReviews, MAX_BULK, suggestAnswers } from './review';
import { keyHash } from './taxonomy';

const T = testTaxonomy();
const id = (subject: TaxonomySubject, slug: string) => findItem(T, subject, slug)!.id;
const SUBJECTS = { shelf: 'shelf', functions: 'function', features: 'value' } as const;
const OWNER: ActorRecord = { role: 'owner', client: 'console' };
const REVIEWER: ActorRecord = {
  role: 'reviewer',
  client: 'consumer',
  consumer: 'crowdio',
  reviewer: 'reviewer-7',
};

/** An item's current taxonomy statements, as "property method slug confidence", sorted. */
async function placedOf(itemId: string): Promise<string[]> {
  const rows = await db
    .select({
      property: statements.property,
      method: statements.method,
      value: statements.value,
      confidence: statements.confidence,
    })
    .from(statements)
    .where(and(eq(statements.itemId, itemId), isNull(statements.withdrawnAt)));
  return rows
    .filter((row) => row.property in SUBJECTS)
    .map((row) => {
      const subject = SUBJECTS[row.property as keyof typeof SUBJECTS];
      return `${row.property} ${row.method} ${findItem(T, subject, String(row.value))?.slug} ${row.confidence}`;
    })
    .sort();
}

const keyOf = async (itemId: string) =>
  (await db.select({ key: items.taxonomyKey }).from(items).where(eq(items.id, itemId)))[0]!.key;

/** A dataset whose decider puts A2 on On-ear, unsure of its pre-amp and of its back. */
async function unsureA2(datasetId: string) {
  const {
    world,
    pages: [, a2],
  } = await taxonomyWorld(testTaxonomyDefinition(datasetId));
  const unsure = fakeTaxonomyDecider((request) =>
    request.evidence.includes(URLS.a2)
      ? {
          shelves: { 'on-ear': 0.95 },
          functions: { headphones: 0.99, 'pre-amp': 0.5 },
          values: { open: 0.6, closed: 0.35 },
        }
      : taxonomyFor(request),
  );
  world.ports.taxonomyDecider = unsure.decider;
  await refresh(world, datasetId);
  const [question] = await listOpenReviews(db, datasetId);
  return { world, a2: a2!, question: question!, calls: unsure.calls };
}

/** A dataset whose decider puts B1 on Amplifiers, unsure which of its subcategories. */
async function fallbackB1(datasetId: string) {
  const {
    world,
    pages: [, , b1],
  } = await taxonomyWorld(testTaxonomyDefinition(datasetId));
  world.ports.taxonomyDecider = fakeTaxonomyDecider((request) =>
    request.evidence.includes(URLS.b1)
      ? {
          shelves: { 'headphone-amps': 0.6, 'power-amps': 0.35 },
          functions: { amplifier: 0.97 },
          values: { headphones: 0.95 },
        }
      : taxonomyFor(request),
  ).decider;
  await refresh(world, datasetId);
  const [question] = await listOpenReviews(db, datasetId);
  return { world, b1: b1!, question: question! };
}

const answerDecision = async (reviewId: string) =>
  (
    await db
      .select()
      .from(decisionRecords)
      .where(eq(decisionRecords.id, await stableId('dc', reviewId, 'answer')))
  )[0]!;

// Each test runs the pipeline against a real database, and some run it twice.
describe('answering a taxonomy question', { timeout: 20_000 }, () => {
  it('places a page as a person answers its parts, and doesn’t ask again', async () => {
    const datasetId = 'parts-answer';
    const { world, a2, question, calls } = await unsureA2(datasetId);
    const answer = (parts: GivenParts, note?: string) =>
      answerReview(world.ports, { datasetId, reviewId: question.id, parts, note });
    for (const [parts, reason] of [
      [{ shelf: 'over-ear' }, 'This question doesn’t ask for the shelf: it’s settled.'],
      [{ functions: ['amplifier'] }, 'This question doesn’t ask about the function amplifier.'],
      [
        { features: { drives: ['speakers'] } },
        'This question doesn’t ask about the feature drives.',
      ],
      [{ features: { back: ['open', 'closed'] } }, 'Back takes one value.'],
    ] as const) {
      expect(await answer(parts)).toEqual({ kind: 'refused', status: 400, reason });
    }
    // The pre-amp it asked about is left unticked: that is the person's no.
    expect(await answer({ features: { back: ['closed'] } }, 'A sealed cup.')).toEqual({
      kind: 'answered',
      effect: 'The page sits on Headphones › On-ear. The next run publishes it.',
    });
    expect(await placedOf(a2.id)).toEqual(['features human closed 1', 'shelf human on-ear 1']);
    expect(await keyOf(a2.id)).toBe(await keyHash(T, id('shelf', 'on-ear')));
    expect(await getReview(db, question.id)).toMatchObject({
      status: 'decided',
      answeredBy: { role: 'owner', client: 'cli' },
      note: 'A sealed cup.',
    });
    const placed = { shelf: id('shelf', 'on-ear'), functions: [], values: [id('value', 'closed')] };
    const decision = await answerDecision(question.id);
    expect(decision).toMatchObject({
      type: 'taxonomy',
      subject: a2.id,
      outcome: 'escalated',
      evidence: 'A sealed cup.',
      answer: answerText(placed),
    });
    expect(readFinalAnswer(decision.finalAnswer)).toEqual({
      answer: placed,
      asked: {
        shelves: [],
        functions: [id('function', 'pre-amp')],
        features: { [id('feature', 'back')]: [id('value', 'open'), id('value', 'closed')] },
      },
      given: { shelf: null, functions: [], values: [id('value', 'closed')] },
    });

    // A2 is read again, unchanged: the person's answer stands, and nothing is asked.
    world.web.routes.set(URLS.a2, { status: 200, body: A2('two') });
    const next = await refresh(world, datasetId);
    expect(next.summary.classify).toMatchObject({ reused: 1, escalated: 0, inputTokens: 0 });
    expect(calls).toHaveLength(3);
    expect(await listOpenReviews(db, datasetId)).toEqual([]);
    expect(await placedOf(a2.id)).toEqual(['features human closed 1', 'shelf human on-ear 1']);
  });

  it('takes a page out on a person’s “None of these”, and asks for the shelf where the question does', async () => {
    const datasetId = 'parts-none';
    const { world, b1, question } = await fallbackB1(datasetId);
    const answer = (parts: GivenParts) =>
      answerReview(world.ports, { datasetId, reviewId: question.id, parts });
    expect(await answer({ functions: ['dac'] })).toEqual({
      kind: 'refused',
      status: 400,
      reason: 'Answer the shelf: this question asks for it.',
    });
    expect(await answer({ shelf: 'none' })).toEqual({
      kind: 'answered',
      effect: 'The page leaves the dataset; spatula revive puts it back.',
    });
    expect(await placedOf(b1.id)).toEqual([]);
    expect((await listLiveItems(db, datasetId)).map((item) => item.id)).not.toContain(b1.id);
    expect(await keyOf(b1.id)).toBe(await keyHash(T, null));
  });

  it('leaves no shelf a person gave standing when they say “None of these”, so the page stays out', async () => {
    const datasetId = 'parts-none-retired';
    const { world, a2, question } = await unsureA2(datasetId);
    await answerReview(world.ports, {
      datasetId,
      reviewId: question.id,
      parts: { features: { back: ['closed'] } },
    });
    // On-ear is retired, so the person's shelf can't carry over, and the next read asks again.
    const retired = applyChanges(
      T,
      [{ kind: 'retire', subject: 'shelf', item: 'on-ear' }],
      () => 'tx_00000000000000000099',
    );
    if (!retired.ok) throw new Error(retired.issues.join('\n'));
    await commitTaxonomy(db, {
      datasetId,
      base: 1,
      taxonomy: retired.taxonomy,
      changes: retired.applied,
      actor: OWNER,
      at: world.clock.now(),
    });
    world.web.routes.set(URLS.a2, { status: 200, body: A2('two') });
    await refresh(world, datasetId);
    const [reopened] = await listOpenReviews(db, datasetId);
    expect(reopened!.context).toMatchObject({ earlier: { shelf: id('shelf', 'on-ear') } });
    expect(
      await answerReview(world.ports, {
        datasetId,
        reviewId: reopened!.id,
        parts: { shelf: 'none' },
      }),
    ).toEqual({
      kind: 'answered',
      effect: 'The page leaves the dataset; spatula revive puts it back.',
    });
    // Their On-ear and Closed are withdrawn with the cascade's.
    expect(await placedOf(a2.id)).toEqual([]);
    // Revived and read again, the page stays out: their "None of these" stands, and nothing of
    // theirs is a retired shelf to ask about instead.
    expect(await reviveItems(db, { datasetId, irrelevant: true, fromCaptures: true })).toBe(1);
    await refresh(world, datasetId, {});
    expect((await listLiveItems(db, datasetId)).map((item) => item.id)).not.toContain(a2.id);
    const [again] = await listOpenReviews(db, datasetId);
    expect(again!.context).toMatchObject({ earlier: { shelf: 'none' } });
  });

  it('sends a reviewer’s different parts to the owner, and a run leaves them waiting', async () => {
    const datasetId = 'parts-flagged';
    const { world, a2, question } = await unsureA2(datasetId);
    const answer = (reviewId: string, parts: GivenParts, actor: ActorRecord) =>
      answerReview(world.ports, { datasetId, reviewId, parts, actor });
    const closedBack = { features: { back: ['closed'] } };
    const openPreAmp = { functions: ['pre-amp'], features: { back: ['open'] } };
    await answer(question.id, closedBack, OWNER);
    world.clock.advance(60_000);
    // The same parts from a reviewer change nothing; different ones go to the owner.
    expect(await answer(question.id, closedBack, REVIEWER)).toEqual({ kind: 'closed' });
    const reopened = await stableId('rv', question.id, 'flag', 1);
    expect(await answer(question.id, openPreAmp, REVIEWER)).toEqual({
      kind: 'flagged',
      reviewId: reopened,
    });
    expect(await placedOf(a2.id)).toEqual(['features human closed 1', 'shelf human on-ear 1']);
    // A run that finds the person's answer standing leaves the flagged question to the owner.
    world.web.routes.set(URLS.a2, { status: 200, body: A2('two') });
    await refresh(world, datasetId);
    expect(await getReview(db, reopened)).toMatchObject({
      status: 'open',
      flag: {
        actor: REVIEWER,
        answer: {
          shelf: null,
          functions: [id('function', 'pre-amp')],
          values: [id('value', 'open')],
        },
      },
    });
    // The owner's answer replaces the person's.
    world.clock.advance(60_000);
    expect(await answer(reopened, openPreAmp, OWNER)).toMatchObject({ kind: 'answered' });
    expect(await placedOf(a2.id)).toEqual([
      'features human open 1',
      'functions human pre-amp 1',
      'shelf human on-ear 1',
    ]);
    expect(
      (await listActions(db, datasetId)).map((action) => `${action.action} ${action.actor.role}`),
    ).toEqual(['answer owner', 'flag reviewer', 'answer owner']);
  });

  it('sends a reviewer’s shelf that differs from a person’s standing one to the owner', async () => {
    const datasetId = 'parts-earlier';
    const { world, a2, question } = await unsureA2(datasetId);
    await answerReview(world.ports, {
      datasetId,
      reviewId: question.id,
      parts: { features: { back: ['closed'] } },
    });
    // The question is asked again, as a change to the taxonomy reopens it (ruling 7): the shelf
    // open, showing the person's answer, which stands meanwhile.
    const answered = (await getReview(db, question.id))!;
    const asked = answered.question as Extract<Question, { type: 'taxonomy' }>;
    await openReview(db, {
      id: 'rv_parts_earlier',
      datasetId,
      kind: 'classify',
      subject: a2.id,
      itemId: a2.id,
      decisionId: answered.decisionId,
      question: {
        ...asked,
        parts: { ...asked.parts, shelves: [...orderedShelves(T).map((shelf) => shelf.id), 'none'] },
      },
      context: {
        ...answered.context,
        earlier: { shelf: id('shelf', 'on-ear'), functions: [], values: [id('value', 'closed')] },
      },
      at: world.clock.now(),
    });
    const parts = { shelf: 'over-ear', features: { back: ['closed'] } };
    const answer = (actor: ActorRecord) =>
      answerReview(world.ports, { datasetId, reviewId: 'rv_parts_earlier', parts, actor });
    expect(await answer(REVIEWER)).toEqual({ kind: 'flagged', reviewId: 'rv_parts_earlier' });
    expect(await placedOf(a2.id)).toEqual(['features human closed 1', 'shelf human on-ear 1']);
    expect(await answer(OWNER)).toEqual({
      kind: 'answered',
      effect: 'The page sits on Headphones › Over-ear. The next run publishes it.',
    });
    expect(await placedOf(a2.id)).toEqual(['features human closed 1', 'shelf human over-ear 1']);
  });

  it('answers in the taxonomy as it is now, after a merge since the question', async () => {
    const datasetId = 'parts-merged';
    const { world, b1, question } = await fallbackB1(datasetId);
    // Preamps is merged into Power amps while the question waits.
    const merged = applyChanges(
      T,
      [{ kind: 'merge', subject: 'shelf', from: 'preamps', into: 'power-amps' }],
      () => 'tx_00000000000000000099',
    );
    if (!merged.ok) throw new Error(merged.issues.join('\n'));
    await commitTaxonomy(db, {
      datasetId,
      base: 1,
      taxonomy: merged.taxonomy,
      changes: merged.applied,
      actor: OWNER,
      at: world.clock.now(),
    });
    const answer = (shelf: string) =>
      answerReview(world.ports, { datasetId, reviewId: question.id, parts: { shelf } });
    expect(await answer('preamps')).toEqual({
      kind: 'refused',
      status: 400,
      reason: 'There’s no live shelf preamps.',
    });
    expect(await answer('power-amps')).toEqual({
      kind: 'answered',
      effect: 'The page sits on Amplifiers › Power amps. The next run publishes it.',
    });
    // Power amps implies Amplifier, which the decider settled, so it isn't stated.
    expect(await placedOf(b1.id)).toEqual([
      'features human headphones 1',
      'shelf human power-amps 1',
    ]);
    expect(await keyOf(b1.id)).toBe(await keyHash(merged.taxonomy, id('shelf', 'power-amps')));
    // What the person was asked, as the taxonomy is now: Preamps is Power amps.
    expect(readFinalAnswer((await answerDecision(question.id)).finalAnswer)!.asked.shelves).toEqual(
      ['amplifiers', 'headphone-amps', 'power-amps'].map((slug) => id('shelf', slug)),
    );
  });

  it('puts the owner’s suggestions on pages’ questions, which a reviewer takes in bulk', async () => {
    const datasetId = 'parts-suggested';
    const { world, a2, question } = await unsureA2(datasetId);
    const nowhere = 'https://maker-a.example/products/nowhere';
    expect(
      await suggestAnswers(world.ports, {
        datasetId,
        suggestions: [
          { page: URLS.a2, parts: { functions: ['pre-amp'], features: { back: ['open'] } } },
          { page: URLS.a1, parts: { functions: [] } },
          { page: nowhere, parts: {} },
        ],
      }),
    ).toEqual([
      { page: URLS.a2, kind: 'suggested', reviewId: question.id },
      { page: URLS.a1, kind: 'missing' },
      { page: nowhere, kind: 'missing' },
    ]);
    // It's kept by ID, as it was checked.
    const suggestion = {
      functions: [id('function', 'pre-amp')],
      features: { [id('feature', 'back')]: [id('value', 'open')] },
    };
    expect(await listOpenReviews(db, datasetId)).toMatchObject([{ id: question.id, suggestion }]);
    // One that doesn't fit is refused, and the one there stays. Only the owner suggests.
    expect(
      await suggestAnswers(world.ports, {
        datasetId,
        suggestions: [{ page: URLS.a2, parts: { shelf: 'dacs' } }],
      }),
    ).toEqual([
      {
        page: URLS.a2,
        kind: 'refused',
        reason: 'This question doesn’t ask for the shelf: it’s settled.',
      },
    ]);
    expect(
      await suggestAnswers(world.ports, {
        datasetId,
        suggestions: [{ page: URLS.a2, parts: {} }],
        actor: REVIEWER,
      }),
    ).toEqual([{ page: URLS.a2, kind: 'refused', reason: 'Suggestions are the owner’s.' }]);
    expect(await listOpenReviews(db, datasetId)).toMatchObject([{ id: question.id, suggestion }]);

    // A reviewer takes it in bulk, beside answers that are refused or missing, each on its own.
    world.clock.advance(60_000);
    expect(
      await answerReviews(world.ports, {
        datasetId,
        answers: [
          { reviewId: 'rv_nowhere', suggestion: true },
          { reviewId: question.id, answer: 'Headphones' },
          { reviewId: question.id, suggestion: true },
        ],
        note: 'From the maker’s sheet.',
        actor: REVIEWER,
      }),
    ).toEqual([
      { reviewId: 'rv_nowhere', result: { kind: 'missing' } },
      {
        reviewId: question.id,
        result: {
          kind: 'refused',
          status: 400,
          reason: 'A taxonomy question is answered part by part.',
        },
      },
      {
        reviewId: question.id,
        result: {
          kind: 'answered',
          effect: 'The page sits on Headphones › On-ear. The next run publishes it.',
        },
      },
    ]);
    expect(await placedOf(a2.id)).toEqual([
      'features human open 1',
      'functions human pre-amp 1',
      'shelf human on-ear 1',
    ]);
    expect(await getReview(db, question.id)).toMatchObject({
      answeredBy: REVIEWER,
      note: 'From the maker’s sheet.',
    });
    expect((await listActions(db, datasetId)).map((action) => action.action)).toEqual([
      'answer',
      'suggest',
    ]);
  });

  it('takes at most 500 answers at once', async () => {
    const { ports } = makeWorld(db, {});
    const answers = Array.from({ length: MAX_BULK + 1 }, (_, n) => ({
      reviewId: `rv_${n}`,
      answer: 'same',
    }));
    await expect(answerReviews(ports, { datasetId: 'parts-many', answers })).rejects.toThrow(
      'At most 500 answers at once',
    );
  });
});
