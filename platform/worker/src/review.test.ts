import type { StatementInput } from '@spatula/core';
import {
  decisionRecords,
  discardHeld,
  getReview,
  items,
  judge,
  judgements,
  judgementsFor,
  latestFetchId,
  listOpenReviews,
  lockPageVerdicts,
  openReview,
  saveDecision,
  snapshotById,
  statements,
  statementsOf,
  supersedeHeld,
  writeStatements,
  type Executor,
  type NewDecision,
} from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import { fakeDecider, type World } from '../test/node/fakes';
import {
  DT_250,
  DT_80,
  routesWith,
  URL_A3,
  versionsAndAPage,
  withThirdPage,
} from '../test/node/match-world';
import { decidedDefinition, entityOf, published, refresh, worldFor } from '../test/node/runs';
import { productPage, standardRoutes, URLS } from '../test/pages';
import { PUBLISH_QUESTION, publishHeldSnapshot } from './publish';
import { answerReview } from './review';

/**
 * The world's ports, but `between` runs once, as soon as the first thing asked of the database
 * returns: the answer's read of the question.
 */
function portsWith(world: World, between: () => Promise<void>) {
  let fired = false;
  return {
    ...world.ports,
    async withDb<T>(fn: (db: Executor) => Promise<T>): Promise<T> {
      const result = await world.ports.withDb(fn);
      if (!fired) {
        fired = true;
        await between();
      }
      return result;
    },
  };
}

/**
 * What a later run does to a question that waits: it decides again on newer evidence, and asks the
 * question again, which moves the waiting one to the newer decision (`openReview`). Returns the
 * newer decision's ID.
 */
async function askedAgain(world: World, reviewId: string): Promise<string> {
  const review = (await getReview(db, reviewId))!;
  const [earlier] = await db
    .select()
    .from(decisionRecords)
    .where(eq(decisionRecords.id, review.decisionId!));
  const newer: NewDecision = {
    ...earlier!,
    id: `${earlier!.id}-newer`,
    stateHash: `${earlier!.stateHash}-newer`,
    decidedAt: world.clock.now(),
  };
  await saveDecision(db, newer);
  await openReview(db, {
    id: `${reviewId}-newer`,
    datasetId: review.datasetId,
    kind: review.kind,
    subject: review.subject,
    itemId: review.itemId,
    entityId: review.entityId,
    decisionId: newer.id,
    question: review.question,
    context: { ...review.context, reason: 'The newer evidence says so.' },
    at: world.clock.now(),
  });
  return newer.id;
}

/**
 * Resolves once `work` has finished, or once a session of this database is waiting for a lock. It
 * looks through `session`, a transaction the caller holds open, because the test's other
 * connections are busy.
 */
async function settledOrWaiting(session: Executor, work: Promise<unknown>): Promise<void> {
  let settled = false;
  void work.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let tries = 0; tries < 500 && !settled; tries += 1) {
    const [row] = await session.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and backend_type = 'client backend' and pid <> pg_backend_pid()`,
    );
    if ((row?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** What was said of a page and an entity. */
const verdictOn = async (datasetId: string, itemId: string, entityId: string) =>
  (await judgementsFor(db, datasetId)).find(
    (row) => row.itemId === itemId && row.entityId === entityId,
  );

const decisionOf = async (id: string) =>
  (await db.select().from(decisionRecords).where(eq(decisionRecords.id, id)))[0]!;

/** What a page's statements say about a property: the current ones, and how they came to say it. */
function currentlySaid(itemId: string, property: string) {
  return db
    .select({
      method: statements.method,
      value: statements.value,
      path: statements.path,
      confidence: statements.confidence,
      lastSeen: statements.lastSeen,
    })
    .from(statements)
    .where(
      and(
        eq(statements.itemId, itemId),
        eq(statements.property, property),
        isNull(statements.withdrawnAt),
      ),
    );
}

/**
 * What a page's statements say about everything but one property, as property, method, and value.
 */
async function saidExcept(itemId: string, property: string) {
  const said = (await statementsOf(db, [itemId])).get(itemId) ?? [];
  return said
    .filter((statement) => statement.property !== property)
    .map((statement) => `${statement.property}/${statement.method}/${statement.valueKey}`)
    .sort();
}

/** Puts statements about the page's category in place, as an earlier run or a person left them. */
async function alreadySaid(
  world: World,
  datasetId: string,
  itemId: string,
  ...said: ['llm' | 'human', string][]
) {
  const fetchId = (await latestFetchId(db, itemId))!;
  for (const [method, value] of said) {
    const statement: StatementInput = {
      property: 'category',
      value,
      valueKey: value,
      original: value,
      method,
      path: `test:${method}`,
      confidence: 0.9,
      position: null,
    };
    await writeStatements(db, {
      datasetId,
      itemId,
      fetchId,
      seenAt: world.clock.now(),
      methods: [method],
      properties: ['category'],
      statements: [statement],
    });
  }
}

/** A dataset whose maker-a pages the decider isn't sure about, so each waits for a person. */
async function classifyAsked(datasetId: string, probabilities: Record<string, number>) {
  const {
    world,
    pages: [a1],
  } = await worldFor(decidedDefinition(datasetId), standardRoutes());
  world.ports.decider = fakeDecider(() => probabilities).decider;
  await refresh(world, datasetId);
  const [question] = (await listOpenReviews(db, datasetId)).filter(
    (review) => review.subject === a1!.id,
  );
  return { world, page: a1!, question: question! };
}

/** Two versions of one headphone, and a decider that can't tell whether the page is the same. */
async function matchAsked(datasetId: string) {
  const {
    world,
    pages: [a1, a2],
  } = await worldFor(testDefinition(datasetId), routesWith(DT_80, DT_250));
  world.ports.decider = fakeDecider(() => ({ same: 0.5, variant: 0.45 })).decider;
  await refresh(world, datasetId);
  const [question] = await listOpenReviews(db, datasetId);
  return { world, a1: a1!, page: a2!, question: question! };
}

/** A dataset that holds what it would publish for the owner, run once. */
async function heldSnapshotIn(datasetId: string) {
  const definition = { ...testDefinition(datasetId), publication: { approval: 'manual' as const } };
  const { world } = await worldFor(definition, standardRoutes());
  await refresh(world, datasetId);
  const [question] = await listOpenReviews(db, datasetId);
  return { world, question: question!, snapshotId: question!.subject };
}

describe('answering review', { timeout: 20_000 }, () => {
  it('puts a person’s classification in the next snapshot, and finalizes the decision', async () => {
    const { world, page, question } = await classifyAsked('review-classify', {
      Headphones: 0.6,
      'DAC/Amp': 0.3,
    });
    const answer = (value: string, datasetId = 'review-classify') =>
      answerReview(world.ports, { datasetId, reviewId: question.id, answer: value });

    expect(await answer('Speakers')).toEqual({
      kind: 'refused',
      status: 400,
      reason: 'Answer with one of: Headphones, DAC/Amp, None of these.',
    });
    // A refused answer changes nothing: the question waits, and nobody has spoken for the page.
    expect(await listOpenReviews(db, 'review-classify')).toContainEqual(
      expect.objectContaining({ id: question.id }),
    );
    expect(await currentlySaid(page.id, 'category')).toEqual([]);
    expect(await answer('DAC/Amp', 'another-dataset')).toEqual({ kind: 'missing' });
    expect(
      await answerReview(world.ports, {
        datasetId: 'review-classify',
        reviewId: 'rv_nowhere',
        answer: 'DAC/Amp',
      }),
    ).toEqual({ kind: 'missing' });
    const others = await saidExcept(page.id, 'category');
    expect(others).not.toEqual([]);
    const at = world.clock.now();
    expect(await answer('DAC/Amp')).toEqual({
      kind: 'answered',
      effect: 'The page’s category is DAC/Amp. The next run publishes it.',
    });
    // It speaks for the category alone.
    expect(await saidExcept(page.id, 'category')).toEqual(others);
    // A question that is closed says so, whatever the answer.
    expect(await answer('Headphones')).toEqual({ kind: 'closed' });
    expect(await answer('Speakers')).toEqual({ kind: 'closed' });
    // What it closed, finalized, and said is stamped with the time the port gave.
    expect(await getReview(db, question.id)).toMatchObject({
      status: 'decided',
      answer: 'DAC/Amp',
      closedAt: at,
    });
    const [decision] = await db
      .select()
      .from(decisionRecords)
      .where(eq(decisionRecords.subject, page.id));
    expect(decision).toMatchObject({
      outcome: 'escalated',
      finalAnswer: 'DAC/Amp',
      finalizedAt: at,
    });
    // The statement's path names the decision the person answered, as the cascade's own do.
    expect(await currentlySaid(page.id, 'category')).toEqual([
      {
        method: 'human',
        value: 'DAC/Amp',
        path: `decision:${decision!.id}`,
        confidence: 1,
        lastSeen: at,
      },
    ]);

    await refresh(world, 'review-classify');
    const file = (await published(world, 'review-classify'))!;
    expect(file.byName.A1!.fields.category).toBe('DAC/Amp');
    expect(file.byName.A1!.provenance.category).toMatchObject({ method: 'human', confidence: 1 });
  });

  it('takes a page a person says is none of the values out of the dataset', async () => {
    const { world, page, question } = await classifyAsked('review-none', { Headphones: 0.5 });
    expect(
      await answerReview(world.ports, {
        datasetId: 'review-none',
        reviewId: question.id,
        answer: 'None of these',
      }),
    ).toEqual({
      kind: 'answered',
      effect: 'The page leaves the dataset; spatula revive puts it back.',
    });
    const [row] = await db
      .select({ status: items.status })
      .from(items)
      .where(eq(items.id, page.id));
    expect(row!.status).toBe('irrelevant');
    expect(
      (await db.select().from(decisionRecords).where(eq(decisionRecords.subject, page.id)))[0],
    ).toMatchObject({ finalAnswer: 'None of these' });
  });

  it('leaves nothing the page said about the field when a person takes the page out', async () => {
    const { world, page, question } = await classifyAsked('review-none-said', {
      Headphones: 0.5,
    });
    // Whatever the page said about its category, the cascade's or a person's, is withdrawn.
    await alreadySaid(
      world,
      'review-none-said',
      page.id,
      ['llm', 'Headphones'],
      ['human', 'DAC/Amp'],
    );
    expect(await currentlySaid(page.id, 'category')).toHaveLength(2);

    await answerReview(world.ports, {
      datasetId: 'review-none-said',
      reviewId: question.id,
      answer: 'None of these',
    });
    expect(await currentlySaid(page.id, 'category')).toEqual([]);
  });

  it('replaces what the cascade said about the field with the person’s answer', async () => {
    const { world, page, question } = await classifyAsked('review-replaces', { Headphones: 0.5 });
    await alreadySaid(world, 'review-replaces', page.id, ['llm', 'Headphones']);
    await answerReview(world.ports, {
      datasetId: 'review-replaces',
      reviewId: question.id,
      answer: 'DAC/Amp',
    });
    expect(await currentlySaid(page.id, 'category')).toMatchObject([
      { method: 'human', value: 'DAC/Amp' },
    ]);
  });

  it('names the question in the statement’s path when no decision asked it', async () => {
    const datasetId = 'review-no-decision';
    const { world, page, question } = await classifyAsked(datasetId, { Headphones: 0.5 });
    const waiting = (await getReview(db, question.id))!;
    // The question is asked again by hand, with no decision behind it.
    await openReview(db, {
      id: 'rv_by_hand',
      datasetId,
      kind: 'classify',
      subject: page.id,
      itemId: page.id,
      question: waiting.question,
      context: waiting.context,
      at: world.clock.now(),
    });
    expect((await getReview(db, question.id))?.decisionId).toBeNull();
    await answerReview(world.ports, { datasetId, reviewId: question.id, answer: 'DAC/Amp' });
    expect(await currentlySaid(page.id, 'category')).toMatchObject([
      { method: 'human', path: `review:${question.id}` },
    ]);
    // The decision that asked first isn't the one this answered.
    expect(await decisionOf(waiting.decisionId!)).toMatchObject({ finalAnswer: null });
  });

  it('records a person’s match verdict, which the next run follows', async () => {
    const { world, a1, page, question } = await matchAsked('review-match');
    const at = world.clock.now();
    expect(
      await answerReview(world.ports, {
        datasetId: 'review-match',
        reviewId: question.id,
        answer: 'same',
      }),
    ).toEqual({ kind: 'answered', effect: 'The page joins that record at the next run.' });
    expect(await judgementsFor(db, 'review-match')).toMatchObject([
      { itemId: page.id, verdict: 'same', who: 'person', confidence: 1 },
    ]);
    expect(
      (await db.select().from(judgements).where(eq(judgements.itemId, page.id)))[0]?.updatedAt,
    ).toEqual(at);
    expect((await getReview(db, question.id))?.status).toBe('decided');
    expect(
      (
        await db.select().from(decisionRecords).where(eq(decisionRecords.subject, question.subject))
      )[0],
    ).toMatchObject({ finalAnswer: 'same' });
    await refresh(world, 'review-match');
    expect(await entityOf(page.id)).toBe(await entityOf(a1.id));
  });

  it.each(['variant', 'different'])(
    'keeps the page apart from the record when a person says %s',
    async (verdict) => {
      const datasetId = `review-apart-${verdict}`;
      const { world, a1, page, question } = await matchAsked(datasetId);
      expect(
        await answerReview(world.ports, { datasetId, reviewId: question.id, answer: verdict }),
      ).toEqual({
        kind: 'answered',
        effect:
          'The page stays apart from that record; the next run gives it its own, or asks about another.',
      });
      expect(await judgementsFor(db, datasetId)).toMatchObject([
        { itemId: page.id, verdict: 'not_same', who: 'person', confidence: 1 },
      ]);
      await refresh(world, datasetId);
      const own = await entityOf(page.id);
      expect(own).not.toBeNull();
      expect(own).not.toBe(await entityOf(a1.id));
    },
  );

  it('publishes or discards a held snapshot at once', async () => {
    const { world, question: held } = await heldSnapshotIn('review-publish');
    expect(
      await answerReview(world.ports, {
        datasetId: 'review-publish',
        reviewId: held.id,
        answer: 'maybe',
      }),
    ).toEqual({
      kind: 'refused',
      status: 400,
      reason: 'Answer with one of: publish, discard.',
    });
    expect((await snapshotById(db, held.subject))?.state).toBe('held');
    expect(
      await answerReview(world.ports, {
        datasetId: 'review-publish',
        reviewId: held.id,
        answer: 'publish',
      }),
    ).toEqual({ kind: 'answered', effect: 'Published as generation 1.' });
    expect((await snapshotById(db, held.subject))?.state).toBe('published');
    expect(await listOpenReviews(db, 'review-publish')).toEqual([]);
    // Its question is closed now, and says so.
    expect(
      await answerReview(world.ports, {
        datasetId: 'review-publish',
        reviewId: held.id,
        answer: 'publish',
      }),
    ).toEqual({ kind: 'closed' });

    // Under manual approval, the next change is held too.
    world.web.routes.set(URLS.a1, {
      status: 200,
      body: productPage({ name: 'A1 Mk II', mpn: '036000291452' }),
    });
    await refresh(world, 'review-publish');
    const [next] = await listOpenReviews(db, 'review-publish');
    expect(
      await answerReview(world.ports, {
        datasetId: 'review-publish',
        reviewId: next!.id,
        answer: 'discard',
      }),
    ).toEqual({ kind: 'answered', effect: 'The held snapshot is discarded.' });
    expect((await snapshotById(db, next!.subject))?.state).toBe('discarded');
    expect(await listOpenReviews(db, 'review-publish')).toEqual([]);
  });

  it('finalizes the decision the question holds when it closes, not the one it held when it was read', async () => {
    const { world, page, question } = await classifyAsked('review-newer-classify', {
      Headphones: 0.6,
      'DAC/Amp': 0.3,
    });
    const earlier = (await getReview(db, question.id))!.decisionId!;
    // A run asks again between the answer's read of the question and its close.
    let newer = '';
    const racing = portsWith(world, async () => {
      newer = await askedAgain(world, question.id);
    });
    expect(
      await answerReview(racing, {
        datasetId: 'review-newer-classify',
        reviewId: question.id,
        answer: 'DAC/Amp',
      }),
    ).toMatchObject({ kind: 'answered' });
    expect(newer).not.toBe(earlier);
    expect(await decisionOf(newer)).toMatchObject({ finalAnswer: 'DAC/Amp' });
    expect(await decisionOf(earlier)).toMatchObject({ finalAnswer: null });
    expect(await currentlySaid(page.id, 'category')).toMatchObject([
      { method: 'human', path: `decision:${newer}` },
    ]);
  });

  it('records the verdict against the decision the question holds when it closes', async () => {
    const { world, question } = await matchAsked('review-newer-match');
    const earlier = (await getReview(db, question.id))!.decisionId!;
    let newer = '';
    const racing = portsWith(world, async () => {
      newer = await askedAgain(world, question.id);
    });
    expect(
      await answerReview(racing, {
        datasetId: 'review-newer-match',
        reviewId: question.id,
        answer: 'same',
      }),
    ).toMatchObject({ kind: 'answered' });
    expect(await decisionOf(newer)).toMatchObject({ finalAnswer: 'same' });
    expect(await decisionOf(earlier)).toMatchObject({ finalAnswer: null });
    expect(await judgementsFor(db, 'review-newer-match')).toMatchObject([
      { verdict: 'same', who: 'person', decisionId: newer },
    ]);
  });

  it('says the question is closed when another answer closed it after this one read it', async () => {
    const datasetId = 'review-closed-meanwhile';
    const { world, page, question } = await classifyAsked(datasetId, {
      Headphones: 0.6,
      'DAC/Amp': 0.3,
    });
    // The other answer gets in between this one's read of the question and its close.
    const racing = portsWith(world, async () => {
      await answerReview(world.ports, { datasetId, reviewId: question.id, answer: 'DAC/Amp' });
    });
    expect(
      await answerReview(racing, { datasetId, reviewId: question.id, answer: 'Headphones' }),
    ).toEqual({ kind: 'closed' });
    // Only the first answer took effect.
    expect(await currentlySaid(page.id, 'category')).toMatchObject([
      { method: 'human', value: 'DAC/Amp' },
    ]);
    expect(await getReview(db, question.id)).toMatchObject({
      status: 'decided',
      answer: 'DAC/Amp',
    });
  });

  it('lets only one of two answers sent at once take effect', async () => {
    const { world, page, question } = await classifyAsked('review-twice', {
      Headphones: 0.6,
      'DAC/Amp': 0.3,
    });
    const answers = ['Headphones', 'DAC/Amp'];
    const results = await Promise.all(
      answers.map((answer) =>
        answerReview(world.ports, { datasetId: 'review-twice', reviewId: question.id, answer }),
      ),
    );
    expect(results.map((result) => result.kind).sort()).toEqual(['answered', 'closed']);
    const winner = answers[results.findIndex((result) => result.kind === 'answered')]!;
    expect(await currentlySaid(page.id, 'category')).toMatchObject([
      { method: 'human', value: winner },
    ]);
    expect(
      (await db.select().from(decisionRecords).where(eq(decisionRecords.subject, page.id)))[0],
    ).toMatchObject({
      finalAnswer: winner,
    });
  });
});

describe('answering a publication question after its snapshot changed', { timeout: 20_000 }, () => {
  // The question was open when the answer read it, and the snapshot changed before the answer
  // reached it: another answer, or a newer run.
  const changes: [
    string,
    (world: World, datasetId: string, snapshotId: string) => Promise<unknown>,
  ][] = [
    [
      'published',
      (world, datasetId, snapshotId) => publishHeldSnapshot(world.ports, { datasetId, snapshotId }),
    ],
    [
      'superseded',
      (world, datasetId) =>
        world.ports.withDb((db) => supersedeHeld(db, { datasetId, at: world.clock.now() })),
    ],
    [
      'discarded',
      (world, _datasetId, snapshotId) =>
        world.ports.withDb((db) => discardHeld(db, { snapshotId, at: world.clock.now() })),
    ],
  ];
  const reasons: Record<string, string> = {
    published: 'That snapshot is published already.',
    superseded: 'A newer run replaced that snapshot.',
    discarded: 'That snapshot was discarded.',
  };

  it.each(changes)(
    'says the snapshot is %s, not that it can’t be published',
    async (state, change) => {
      const datasetId = `review-stale-${state}`;
      const { world, question, snapshotId } = await heldSnapshotIn(datasetId);
      const racing = portsWith(world, async () => {
        await change(world, datasetId, snapshotId);
      });
      expect(
        await answerReview(racing, { datasetId, reviewId: question.id, answer: 'publish' }),
      ).toEqual({ kind: 'refused', status: 409, reason: reasons[state] });
      expect((await snapshotById(db, snapshotId))?.state).toBe(state);
    },
  );

  it('says so when the snapshot to discard isn’t held any more', async () => {
    const datasetId = 'review-stale-discard';
    const { world, question, snapshotId } = await heldSnapshotIn(datasetId);
    const racing = portsWith(world, async () => {
      await publishHeldSnapshot(world.ports, { datasetId, snapshotId });
    });
    expect(
      await answerReview(racing, { datasetId, reviewId: question.id, answer: 'discard' }),
    ).toEqual({ kind: 'refused', status: 409, reason: 'That snapshot isn’t held any more.' });
    expect((await snapshotById(db, snapshotId))?.state).toBe('published');
  });

  it('says a snapshot it can’t find is missing', async () => {
    const datasetId = 'review-stale-missing';
    const { world } = await worldFor(testDefinition(datasetId), standardRoutes());
    const id = await world.ports.withDb((db) =>
      openReview(db, {
        id: 'rv_nowhere_to_publish',
        datasetId,
        kind: 'publication',
        subject: 'sn_nowhere',
        question: PUBLISH_QUESTION,
        context: {},
        at: world.clock.now(),
      }),
    );
    expect(await answerReview(world.ports, { datasetId, reviewId: id, answer: 'publish' })).toEqual(
      {
        kind: 'refused',
        status: 409,
        reason: 'That snapshot is missing, so it can’t be published.',
      },
    );
  });
});

describe('a page that two questions ask about', { timeout: 20_000 }, () => {
  /**
   * Two versions of one headphone, split in the first run, and a page that gives only their name.
   * The decider is sure the 250 is a version of the 80, and unsure whether the page is either, so
   * the second run asks a person about the page and each record.
   */
  async function pageWithTwoQuestions(datasetId: string) {
    const routes = routesWith(DT_80, DT_250);
    routes[URL_A3] = { status: 200, body: productPage({ name: 'DT 770 PRO' }) };
    const {
      world,
      pages: [a1, a2, page],
    } = await worldFor(withThirdPage(testDefinition(datasetId)), routes);
    world.ports.decider = fakeDecider(
      (request): Record<string, number> =>
        request.evidence.startsWith(`Record A (${URLS.a2}):`)
          ? { variant: 0.97 }
          : { same: 0.5, variant: 0.45 },
    ).decider;
    await refresh(world, datasetId);
    const [e1, e2] = [(await entityOf(a1!.id))!, (await entityOf(a2!.id))!];
    await refresh(world, datasetId);
    const asked = await listOpenReviews(db, datasetId);
    expect(asked).toHaveLength(2);
    const about = (entityId: string) =>
      asked.find((review) => review.subject === `${page!.id}|${entityId}`)!;
    return { world, page: page!, e1, e2, about };
  }

  const answer = (world: World, datasetId: string, reviewId: string, value: string) =>
    answerReview(world.ports, { datasetId, reviewId, answer: value });

  it('refuses a second “same” from a person, names the record the first chose, and keeps its question open', async () => {
    const datasetId = 'review-two-same';
    const { world, page, e1, e2, about } = await pageWithTwoQuestions(datasetId);
    expect(await answer(world, datasetId, about(e1).id, 'same')).toEqual({
      kind: 'answered',
      effect: 'The page joins that record at the next run.',
    });
    expect(await answer(world, datasetId, about(e2).id, 'same')).toEqual({
      kind: 'refused',
      status: 409,
      reason: `A person already said this page is the same product as ${e1}, and a page joins one record. Answer variant or different.`,
    });
    // Nothing was written for the refused answer: its question waits, and it speaks for nothing.
    expect(await listOpenReviews(db, datasetId)).toMatchObject([{ id: about(e2).id }]);
    expect(await decisionOf((await getReview(db, about(e2).id))!.decisionId!)).toMatchObject({
      finalAnswer: null,
    });
    expect(await verdictOn(datasetId, page.id, e1)).toMatchObject({
      verdict: 'same',
      who: 'person',
    });
    expect(await verdictOn(datasetId, page.id, e2)).toMatchObject({
      verdict: 'unsure',
      who: 'llm',
    });

    // The person can still say what the page isn't.
    expect(await answer(world, datasetId, about(e2).id, 'different')).toMatchObject({
      kind: 'answered',
    });
    expect(await listOpenReviews(db, datasetId)).toEqual([]);
    await refresh(world, datasetId);
    expect(await entityOf(page.id)).toBe(e1);
  });

  it('takes a person’s “same” again about the record they already chose', async () => {
    const datasetId = 'review-same-again';
    const { world, page, e1, about } = await pageWithTwoQuestions(datasetId);
    const asked = about(e1);
    expect(await answer(world, datasetId, asked.id, 'same')).toMatchObject({ kind: 'answered' });
    // The pair is asked once more, as a change to the question would have it.
    await openReview(db, {
      id: 'rv_again',
      datasetId,
      kind: 'match',
      subject: asked.subject,
      itemId: page.id,
      entityId: e1,
      question: asked.question,
      context: asked.context,
      at: world.clock.now(),
    });
    expect(await answer(world, datasetId, 'rv_again', 'same')).toEqual({
      kind: 'answered',
      effect: 'The page joins that record at the next run.',
    });
  });

  it('refuses a “same” for a page that is joined to another record already', async () => {
    const datasetId = 'review-joined';
    const { world, page, e1, e2, about } = await pageWithTwoQuestions(datasetId);
    await db.update(items).set({ entityId: e1 }).where(eq(items.id, page.id));
    expect(await answer(world, datasetId, about(e2).id, 'same')).toEqual({
      kind: 'refused',
      status: 409,
      reason: `This page is already joined to ${e1}, and a page joins one record. Answer variant or different.`,
    });
    expect(await listOpenReviews(db, datasetId)).toHaveLength(2);
    // The record it is joined to can be confirmed, and the other ruled out.
    expect(await answer(world, datasetId, about(e1).id, 'same')).toMatchObject({
      kind: 'answered',
    });
    expect(await answer(world, datasetId, about(e2).id, 'variant')).toMatchObject({
      kind: 'answered',
    });
  });

  it('takes a person’s “same” beside a decider’s “same” about another record, and joins the person’s', async () => {
    const datasetId = 'review-decider-same';
    // The decider accepted "same" for e1; the question about e2 waits.
    const { world, page, e1, e2 } = await versionsAndAPage(datasetId);
    const [question] = await listOpenReviews(db, datasetId);
    expect(question!.subject).toBe(`${page.id}|${e2}`);
    expect(await answer(world, datasetId, question!.id, 'same')).toEqual({
      kind: 'answered',
      effect: 'The page joins that record at the next run.',
    });
    expect(await verdictOn(datasetId, page.id, e1)).toMatchObject({ verdict: 'same', who: 'llm' });
    expect(await verdictOn(datasetId, page.id, e2)).toMatchObject({
      verdict: 'same',
      who: 'person',
    });
    await refresh(world, datasetId);
    expect(await entityOf(page.id)).toBe(e2);
  });

  it('waits for an answer in progress about the page, and then checks what that one said', async () => {
    const datasetId = 'review-page-lock';
    const { world, page, e1, e2, about } = await pageWithTwoQuestions(datasetId);
    let answering!: ReturnType<typeof answer>;
    let answeredEarly = false;
    // Another answer about the page has its lock and has said "same" for e1, and hasn't committed.
    await db.transaction(async (tx) => {
      await lockPageVerdicts(tx, page.id);
      await judge(tx, {
        datasetId,
        itemId: page.id,
        entityId: e1,
        verdict: 'same',
        who: 'person',
        confidence: 1,
        decisionId: null,
        at: world.clock.now(),
      });
      answering = answer(world, datasetId, about(e2).id, 'same');
      let finished = false;
      void answering.then(
        () => (finished = true),
        () => (finished = true),
      );
      await settledOrWaiting(tx, answering);
      answeredEarly = finished;
    });
    // The answer waited for the lock, so it read the committed "same" for e1 and was refused.
    expect(answeredEarly).toBe(false);
    expect(await answering).toEqual({
      kind: 'refused',
      status: 409,
      reason: `A person already said this page is the same product as ${e1}, and a page joins one record. Answer variant or different.`,
    });
    expect(await listOpenReviews(db, datasetId)).toHaveLength(2);
  });

  it('lets only one of two “same” answers sent at once take effect', async () => {
    const datasetId = 'review-same-at-once';
    const { world, page, e1, e2, about } = await pageWithTwoQuestions(datasetId);
    const entities = [e1, e2];
    const results = await Promise.all(
      entities.map((entityId) => answer(world, datasetId, about(entityId).id, 'same')),
    );
    const chosen = entities[results.findIndex((result) => result.kind === 'answered')]!;
    const refused = results.find((result) => result.kind === 'refused');
    expect(results.map((result) => result.kind).sort()).toEqual(['answered', 'refused']);
    expect(refused).toMatchObject({ status: 409, reason: expect.stringContaining(chosen) });
    const said = (await judgementsFor(db, datasetId)).filter(
      (row) => row.itemId === page.id && row.who === 'person',
    );
    expect(said).toMatchObject([{ entityId: chosen, verdict: 'same' }]);
  });
});
