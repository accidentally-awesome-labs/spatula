import {
  createLlmDecider,
  GENERIC_MATCH_CRITERIA,
  MODEL_NUMBER_REASON,
  runIdFor,
  type Decider,
  type DecisionRequest,
  type Definition,
  type PagesSource,
} from '@spatula/core';
import { packs } from '@spatula/pack-products';
import {
  applyDefinition,
  decisionRecords,
  finalizeDecision,
  judge,
  judgementsFor,
  listOpenReviews,
} from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import { fakeDecider, fakeLlm, modelPortsOf, type World } from '../test/node/fakes';
import {
  DT_250,
  DT_80,
  routesWith,
  URL_A3,
  versionsAndAPage,
  withThirdPage,
} from '../test/node/match-world';
import { entityOf, published, refresh, worldFor } from '../test/node/runs';
import { productPage, ROBOTS_OPEN, URLS } from '../test/pages';
import { LlmHttpError } from './llm-openai';
import { matchItem } from './match';
import type { Context } from './pipeline';
import { runRefresh, type StepRunner } from './refresh';

const DT_600 = { name: 'DT 770 PRO', gtin13: '4010118471087' };

/** The version of the criteria the products pack gives the decider. */
const PACK_VERSION = packs['products/product']!.match!.version;

const HOUR = 3_600_000;
const NO_AI_INPUT = 'User-agent: *\nContent-Signal: ai-input=no\nAllow: /\n';

const decisionsAbout = (datasetId: string) =>
  db.select().from(decisionRecords).where(eq(decisionRecords.datasetId, datasetId));

const contextOf = (world: World, definition: Definition): Context => ({
  runId: runIdFor(definition.dataset, world.clock.now()),
  datasetId: definition.dataset,
  revision: 1,
  definition,
  startedAt: world.clock.now(),
});

/** The next run's time, so what a step makes is a new run's decision. */
const nextRun = (world: World) => world.clock.advance(5 * 60_000);

/** The names of the steps that asked a match question. */
const matchSteps = (names: string[]) => names.filter((name) => name.startsWith('match:'));

/** A decider that is down. */
const DOWN: Decider = {
  name: 'llm:test-model',
  async decide() {
    throw new Error('the decider is down');
  },
};

// Each test runs the pipeline against a real database, several runs in most, and a busy machine
// needs more than the five seconds a test gets by default.
describe('matching pages', { timeout: 20_000 }, () => {
  it('asks before joining two pages with one name and different GTINs, and keeps a variant apart', async () => {
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(testDefinition('match-variant'), routesWith(DT_80, DT_250));
    world.ports.decider = fakeDecider(() => ({ 'spec-version': 0.97, same: 0.02 })).decider;
    const first = await refresh(world, 'match-variant');
    const e1 = await entityOf(a1!.id);
    expect(first.names.slice(-6)).toEqual([
      'resolve',
      `match:${a2!.id}:${e1}`,
      'resolve:matched',
      'snapshot',
      'captures',
      'finish',
    ]);
    expect(first.summary.match).toMatchObject({ accepted: 1, inputTokens: 500, outputTokens: 20 });
    expect(first.summary.entities).toEqual({
      created: 3,
      linked: 0,
      conflicts: 0,
      unresolved: 0,
      waiting: 0,
    });
    expect(await entityOf(a2!.id)).not.toBe(e1);
    expect(await judgementsFor(db, 'match-variant')).toMatchObject([
      { itemId: a2!.id, entityId: e1, verdict: 'not_same', who: 'llm' },
    ]);
    expect((await published(world, 'match-variant'))!.snapshot.records).toHaveLength(3);

    // The question was answered, so the next run asks nothing.
    const second = await refresh(world, 'match-variant');
    expect(second.names).not.toContain('resolve:matched');
  });

  it('joins the pages when the decider says they’re the same product', async () => {
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(testDefinition('match-same'), routesWith(DT_80, DT_250));
    world.ports.decider = fakeDecider(() => ({ same: 0.98 })).decider;
    const first = await refresh(world, 'match-same');
    expect(first.summary.entities).toMatchObject({ created: 2, linked: 1, waiting: 0 });
    expect(await entityOf(a2!.id)).toBe(await entityOf(a1!.id));
    const file = (await published(world, 'match-same'))!;
    expect(file.byName['DT 770 PRO']!.fields.gtins).toEqual(['04010118471063', '04010118471070']);
  });

  it('waits for a person when the decider isn’t sure, and leaves the page out until then', async () => {
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(testDefinition('match-unsure'), routesWith(DT_80, DT_250));
    const scripted = fakeDecider(() => ({ same: 0.5, 'spec-version': 0.45 }));
    world.ports.decider = scripted.decider;
    const first = await refresh(world, 'match-unsure');
    const e1 = await entityOf(a1!.id);
    expect(first.summary.match).toMatchObject({ escalated: 1 });
    expect(first.summary.entities).toMatchObject({ waiting: 1 });
    expect(await entityOf(a2!.id)).toBeNull();
    expect(await listOpenReviews(db, 'match-unsure')).toMatchObject([
      {
        kind: 'match',
        subject: `${a2!.id}|${e1}`,
        context: {
          page: URLS.a2,
          entity: URLS.a1,
          proposed: 'same',
          probabilities: { same: 0.5, 'spec-version': 0.45 },
        },
      },
    ]);
    // The decider weighed the pair, so its "unsure" is an answer: only a person's word replaces it.
    expect(await judgementsFor(db, 'match-unsure')).toMatchObject([
      { itemId: a2!.id, entityId: e1, verdict: 'unsure', who: 'llm', confidence: 0.5 },
    ]);
    expect((await published(world, 'match-unsure'))!.snapshot.records).toHaveLength(2);

    // Nothing is asked again while the person hasn't answered.
    const second = await refresh(world, 'match-unsure');
    expect(matchSteps(second.names)).toEqual([]);
    expect(second.summary.entities).toMatchObject({ waiting: 1 });
    expect(scripted.calls).toHaveLength(1);
  });

  it('names the record a question asks about by its ID, beside the page that stands for it', async () => {
    const {
      world,
      pages: [a1],
    } = await worldFor(testDefinition('match-record'), routesWith(DT_80, DT_250));
    world.ports.decider = fakeDecider(() => ({ same: 0.5, 'spec-version': 0.45 })).decider;
    await refresh(world, 'match-record');
    // A refusal names a record by its ID, so the listing has to show which question that is.
    const e1 = await entityOf(a1!.id);
    expect(e1).not.toBeNull();
    const [question] = await listOpenReviews(db, 'match-record');
    expect(question!.context).toMatchObject({ entity: URLS.a1, page: URLS.a2 });
    expect(question!.context.record).toBe(e1);
  });

  it('asks about a similar name within the brand, showing the decider both records', async () => {
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(
      testDefinition('match-similar'),
      routesWith({ name: 'HD 660S' }, { name: 'HD 660SE' }),
    );
    const first = await refresh(world, 'match-similar');
    const e1 = await entityOf(a1!.id);
    expect(first.names).toContain(`match:${a2!.id}:${e1}`);
    expect(world.decider.calls[0]!.question).toMatchObject({
      options: ['same', 'edition', 'spec-version', 'other-model', 'unrelated'],
    });
    expect(world.decider.calls[0]!.criteria).toContain(
      'spec-version: the same model name, but a specification differs',
    );
    expect(world.decider.calls[0]!.evidence).toContain(`Record A (${URLS.a2}):`);
    expect(world.decider.calls[0]!.evidence).toContain('A: HD 660SE');
    expect(world.decider.calls[0]!.evidence).toContain(`Record B (${URLS.a1}):`);
    // The default fake answers "different", so each is its own record.
    expect(first.summary.entities).toMatchObject({ created: 3, waiting: 0 });
    const decisions = await db
      .select()
      .from(decisionRecords)
      .where(eq(decisionRecords.datasetId, 'match-similar'));
    expect(decisions).toMatchObject([
      {
        type: 'match',
        subject: `${a2!.id}|${e1}`,
        outcome: 'accepted',
        answer: 'unrelated',
        criteriaVersion: PACK_VERSION,
      },
    ]);
  });

  it('keeps two models apart by the model-number rule, asking no decider, and names the pair', async () => {
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(
      testDefinition('match-rule'),
      routesWith({ name: 'HD 660S' }, { name: 'HD 660S2' }),
    );
    const scripted = fakeDecider(() => ({ same: 0.98 }));
    world.ports.decider = scripted.decider;
    const first = await refresh(world, 'match-rule');
    const e1 = await entityOf(a1!.id);
    expect(scripted.calls).toEqual([]);
    expect(first.summary.match).toEqual({
      rule: 1,
      accepted: 0,
      escalated: 0,
      reused: 0,
      skipped: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(first.summary.ruleApart).toEqual(['HD 660S2 and HD 660S']);
    expect(await judgementsFor(db, 'match-rule')).toMatchObject([
      { itemId: a2!.id, entityId: e1, verdict: 'not_same', who: 'rule', confidence: 1 },
    ]);
    expect(await decisionsAbout('match-rule')).toMatchObject([
      {
        outcome: 'rule',
        adapter: null,
        answer: 'other-model',
        probabilities: { 'other-model': 1 },
        evidence: MODEL_NUMBER_REASON,
        inputTokens: 0,
        outputTokens: 0,
      },
    ]);
    expect(first.summary.entities).toMatchObject({ created: 3, waiting: 0 });

    // The pair is settled, so the next run asks nothing.
    const second = await refresh(world, 'match-rule');
    expect(matchSteps(second.names)).toEqual([]);
  });

  it('applies the rule where the dataset allows no AI input', async () => {
    const definition = testDefinition('match-rule-no-ai');
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(
      { ...definition, policy: { ...definition.policy, purposes: [] } },
      routesWith({ name: 'HD 660S' }, { name: 'HD 660S2' }),
    );
    const first = await refresh(world, 'match-rule-no-ai');
    expect(first.summary.match).toMatchObject({ rule: 1, escalated: 0 });
    expect(world.decider.calls).toEqual([]);
    expect(await judgementsFor(db, 'match-rule-no-ai')).toMatchObject([
      { itemId: a2!.id, entityId: await entityOf(a1!.id), verdict: 'not_same', who: 'rule' },
    ]);
    expect(await listOpenReviews(db, 'match-rule-no-ai')).toEqual([]);
  });

  it('applies the rule after the run’s LLM budget is spent', async () => {
    const base = withThirdPage(testDefinition('match-rule-spent'));
    const routes = routesWith({ name: 'HD 660S' }, { name: 'HD 660SE' });
    routes[URL_A3] = { status: 200, body: productPage({ name: 'HD 660S2' }) };
    const {
      world,
      pages: [a1, a2, a3],
    } = await worldFor({ ...base, budget: { ...base.budget, llmUsdPerRun: 0.0005 } }, routes, {
      llm: false,
    });
    const scripted = fakeDecider(() => ({ unrelated: 0.97 }));
    world.ports.decider = scripted.decider;
    // A2's question spends 520 tokens, more than the budget. A3's is the rule's all the same.
    const first = await refresh(world, 'match-rule-spent');
    const e1 = await entityOf(a1!.id);
    expect(matchSteps(first.names)).toEqual([`match:${a2!.id}:${e1}`, `match:${a3!.id}:${e1}`]);
    expect(first.summary.match).toMatchObject({ accepted: 1, rule: 1, skipped: 0 });
    expect(scripted.calls).toHaveLength(1);
  });

  it('leaves a page to the decider when the record carries another name, an edition’s, that it differs from by more than model marks', async () => {
    const definition = testDefinition('match-rule-editions');
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(definition, routesWith({ name: 'DT 990 PRO' }, { name: 'DT 990 PRO Club' }));
    world.ports.decider = fakeDecider(() => ({ edition: 0.97, same: 0.02 })).decider;
    await refresh(world, 'match-rule-editions');
    const e1 = await entityOf(a1!.id);
    expect(await entityOf(a2!.id)).toBe(e1);

    // A third page joins the picture. It differs from the record's base page, "DT 990 PRO", by a
    // model number alone, but not from its edition, "DT 990 PRO Club", which the record carries too.
    await applyDefinition(db, withThirdPage(definition));
    world.web.routes.set(URL_A3, { status: 200, body: productPage({ name: 'DT 990 PRO 2' }) });
    const scripted = fakeDecider(() => ({ 'other-model': 0.97 }));
    world.ports.decider = scripted.decider;
    const second = await refresh(world, 'match-rule-editions');
    expect(second.summary.match).toMatchObject({ rule: 0, accepted: 1 });
    expect(second.summary.ruleApart).toBeUndefined();
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0]!.evidence).toContain('A: DT 990 PRO 2');
    // Listed by item ID, which is random, so found by verdict.
    const judged = await judgementsFor(db, 'match-rule-editions');
    expect(judged).toHaveLength(2);
    expect(judged.find((judgement) => judgement.verdict === 'edition')).toMatchObject({
      itemId: a2!.id,
      entityId: e1,
      who: 'llm',
    });
    expect(judged.find((judgement) => judgement.verdict === 'not_same')).toMatchObject({
      entityId: e1,
      who: 'llm',
    });
  });

  it('names at most ten pairs the rule kept apart, and counts them all', async () => {
    const base = testDefinition('match-rule-many');
    const makerA = base.sources[0] as PagesSource;
    const routes = routesWith({ name: 'HD 660S' }, { name: 'HD 660S2' });
    // Ten pages more, whose addresses sort after the first two.
    const more = Array.from({ length: 10 }, (_, index) => {
      const url = `https://maker-a.example/products/z${String(index + 1).padStart(2, '0')}`;
      routes[url] = { status: 200, body: productPage({ name: `HD 660S${index + 3}` }) };
      return url;
    });
    const { world } = await worldFor(
      { ...base, sources: [{ ...makerA, pages: [...makerA.pages, ...more] }, base.sources[1]!] },
      routes,
    );
    const first = await refresh(world, 'match-rule-many');
    expect(first.summary.match).toMatchObject({ rule: 11, accepted: 0, escalated: 0 });
    expect(first.summary.ruleApart).toEqual(
      Array.from({ length: 10 }, (_, index) => `HD 660S${index + 2} and HD 660S`),
    );
    expect(world.decider.calls).toEqual([]);
  });

  it('cuts each name of a pair at eighty characters', async () => {
    // Longer than 80 characters, and within the test dataset's 120 for a name.
    const long = `Orpheus ${'Xanadu '.repeat(13).trim()}`;
    expect(long.length).toBeGreaterThan(80);
    const { world } = await worldFor(
      testDefinition('match-rule-long'),
      routesWith({ name: long }, { name: `${long} 2` }),
    );
    const first = await refresh(world, 'match-rule-long');
    expect(first.summary.match).toMatchObject({ rule: 1 });
    expect(first.summary.ruleApart).toEqual([`${long.slice(0, 80)} and ${long.slice(0, 80)}`]);
  });

  it('proposes the option offered first when the decider is torn, whichever it ranked first', async () => {
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(testDefinition('match-torn'), routesWith(DT_80, DT_250));
    world.ports.decider = fakeDecider(() => ({ 'spec-version': 0.45, same: 0.45 })).decider;
    await refresh(world, 'match-torn');
    expect(await listOpenReviews(db, 'match-torn')).toMatchObject([
      {
        subject: `${a2!.id}|${await entityOf(a1!.id)}`,
        context: { proposed: 'same', probabilities: { 'spec-version': 0.45, same: 0.45 } },
      },
    ]);
  });

  it('joins a page the decider says is an edition, and records the verdict edition', async () => {
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(
      testDefinition('match-edition'),
      routesWith(
        { name: 'DJ 300 PRO X', gtin13: DT_80.gtin13 },
        { name: 'DJ 300 PRO X Club', gtin13: DT_250.gtin13 },
      ),
    );
    world.ports.decider = fakeDecider(() => ({ edition: 0.97, same: 0.02 })).decider;
    const first = await refresh(world, 'match-edition');
    const e1 = await entityOf(a1!.id);
    expect(first.summary.match).toMatchObject({ accepted: 1, escalated: 0 });
    expect(await judgementsFor(db, 'match-edition')).toMatchObject([
      { itemId: a2!.id, entityId: e1, verdict: 'edition', who: 'llm', confidence: 0.97 },
    ]);
    expect(await entityOf(a2!.id)).toBe(e1);
  });

  it('shows the decider the record by its base page, though its edition started it, and the edition as known', async () => {
    // The Club's page sorts first, so it starts the record, and the base page joins it as an
    // edition.
    const definition = testDefinition('match-base-page');
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(
      definition,
      routesWith(
        { name: 'DJ 300 PRO X Club', gtin13: DT_80.gtin13 },
        { name: 'DJ 300 PRO X', gtin13: DT_250.gtin13 },
      ),
    );
    world.ports.decider = fakeDecider(() => ({ edition: 0.97 })).decider;
    await refresh(world, 'match-base-page');
    expect(await entityOf(a2!.id)).toBe(await entityOf(a1!.id));

    // A third page is asked about the record.
    await applyDefinition(db, withThirdPage(definition));
    world.web.routes.set(URL_A3, {
      status: 200,
      body: productPage({ name: 'DJ 300 PRO X Silver' }),
    });
    const scripted = fakeDecider(() => ({ edition: 0.97 }));
    world.ports.decider = scripted.decider;
    await refresh(world, 'match-base-page');
    expect(scripted.calls).toHaveLength(1);
    const { evidence } = scripted.calls[0]!;
    expect(evidence).toContain(`Record B (${URLS.a2}):`);
    expect(evidence).toContain('A: DJ 300 PRO X Silver\nB: DJ 300 PRO X\nA adds: Silver');
    expect(evidence).toContain('B’s known editions: DJ 300 PRO X Club');
    expect(evidence).not.toContain('B: DJ 300 PRO X Club');
  });

  it('asks a person when the decider is torn between the same product and an edition', async () => {
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(testDefinition('match-torn-edition'), routesWith(DT_80, DT_250));
    world.ports.decider = fakeDecider(() => ({ same: 0.5, edition: 0.48 })).decider;
    const first = await refresh(world, 'match-torn-edition');
    expect(first.summary.match).toMatchObject({ escalated: 1 });
    expect(await listOpenReviews(db, 'match-torn-edition')).toMatchObject([
      { subject: `${a2!.id}|${await entityOf(a1!.id)}`, context: { proposed: 'same' } },
    ]);
    expect(await entityOf(a2!.id)).toBeNull();
  });

  it('shows the decider the brand’s other records, and keeps them in the decision’s evidence', async () => {
    const routes = routesWith({ name: 'HD 660S' }, { name: 'HD 660SE' });
    // A3 gives a GTIN, so it is placed first, and is a record of its own when A2 is asked about A1.
    routes[URL_A3] = { status: 200, body: productPage({ name: 'HD 600', gtin13: DT_600.gtin13 }) };
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(withThirdPage(testDefinition('match-lineup')), routes);
    const first = await refresh(world, 'match-lineup');
    const e1 = await entityOf(a1!.id);
    expect(matchSteps(first.names)).toEqual([`match:${a2!.id}:${e1}`]);
    expect(world.decider.calls[0]!.evidence).toContain(
      'Other records with the same brand, each already a record of its own:\n- HD 600',
    );
    expect(await decisionsAbout('match-lineup')).toMatchObject([
      { evidence: 'the test’s reason Shown beside it: HD 600.' },
    ]);
  });

  it('keeps the lineup on one line in the reason of a question a person is asked', async () => {
    const routes = routesWith({ name: 'HD 660S' }, { name: 'HD 660SE' });
    routes[URL_A3] = { status: 200, body: productPage({ name: 'HD 600', gtin13: DT_600.gtin13 }) };
    const { world } = await worldFor(withThirdPage(testDefinition('match-lineup-review')), routes);
    world.ports.decider = fakeDecider(() => ({ same: 0.5, edition: 0.48 })).decider;
    const first = await refresh(world, 'match-lineup-review');
    expect(first.summary.match).toMatchObject({ escalated: 1 });
    const [review] = await listOpenReviews(db, 'match-lineup-review');
    expect(review!.context.reason).toBe('the test’s reason Shown beside it: HD 600.');
  });
});

describe('a page that gives only a name', { timeout: 20_000 }, () => {
  for (const order of ['before', 'after'] as const) {
    it(`waits for the variant to be settled, then is asked about both versions, sorting ${order} them`, async () => {
      const datasetId = `match-name-only-${order}`;
      const routes = routesWith(DT_80, DT_250);
      const nameOnly = { name: 'DT 770 PRO' };
      // The page that gives only a name sorts before the two versions, or after them.
      if (order === 'before') {
        routes[URLS.a1] = { status: 200, body: productPage(nameOnly) };
        routes[URLS.a2] = { status: 200, body: productPage(DT_80) };
        routes[URL_A3] = { status: 200, body: productPage(DT_250) };
      } else {
        routes[URL_A3] = { status: 200, body: productPage(nameOnly) };
      }
      const {
        world,
        pages: [a1, a2, a3],
      } = await worldFor(withThirdPage(testDefinition(datasetId)), routes);
      const [page, v80, v250] = order === 'before' ? [a1!, a2!, a3!] : [a3!, a1!, a2!];
      const v250Url = order === 'before' ? URL_A3 : URLS.a2;
      // The 250 is a version of the 80. The page is the 250 ohm one: the same as that, not the 80.
      const scripted = fakeDecider((request): Record<string, number> => {
        if (request.evidence.startsWith(`Record A (${v250Url}):`)) return { 'spec-version': 0.97 };
        return request.evidence.includes(`Record B (${v250Url}):`)
          ? { same: 0.98 }
          : { unrelated: 0.97 };
      });
      world.ports.decider = scripted.decider;

      // A name alone doesn't say which version the page is, so it joins nothing and starts nothing
      // while the 250's question is open, or in the pass that answers it.
      const first = await refresh(world, datasetId);
      const e1 = await entityOf(v80.id);
      const e2 = await entityOf(v250.id);
      expect(matchSteps(first.names)).toEqual([`match:${v250.id}:${e1}`]);
      expect(e2).not.toBe(e1);
      expect(await entityOf(page.id)).toBeNull();
      expect(first.summary.entities).toMatchObject({ waiting: 1 });
      expect(first.summary.notes).toContainEqual(
        expect.stringMatching(
          /^1 page that gives only the name ".*DT 770 PRO" waits until it’s settled/u,
        ),
      );

      // Once each version has its entity, the page is asked about both.
      const second = await refresh(world, datasetId);
      expect(matchSteps(second.names)).toEqual([
        `match:${page.id}:${e1}`,
        `match:${page.id}:${e2}`,
      ]);
      const verdicts = (await judgementsFor(db, datasetId)).map(
        (judgement) => `${judgement.itemId}|${judgement.entityId}|${judgement.verdict}`,
      );
      expect(verdicts.sort()).toEqual(
        [`${v250.id}|${e1}|not_same`, `${page.id}|${e1}|not_same`, `${page.id}|${e2}|same`].sort(),
      );
      expect(await entityOf(page.id)).toBe(e2);
      expect(second.summary.entities).toMatchObject({ waiting: 0, conflicts: 0 });
    });
  }
});

describe('a decider that says a page is the same as two entities', { timeout: 20_000 }, () => {
  /** The verdicts on a page, by entity. */
  const verdictsAbout = async (datasetId: string, pageId: string) =>
    new Map(
      (await judgementsFor(db, datasetId))
        .filter((row) => row.itemId === pageId)
        .map((row) => [row.entityId, row]),
    );

  /** What the cascade said about the page and an entity, as the decision the step made. */
  const decisionAbout = async (datasetId: string, pageId: string, entityId: string) =>
    (await decisionsAbout(datasetId)).find((row) => row.subject === `${pageId}|${entityId}`)!;

  it('accepts one, and asks a person about the other, with the page waiting', async () => {
    const datasetId = 'match-contradiction';
    const { page, e1, e2, second } = await versionsAndAPage(datasetId);
    expect(matchSteps(second.names)).toEqual([`match:${page.id}:${e1}`, `match:${page.id}:${e2}`]);
    expect(second.summary.match).toMatchObject({ accepted: 1, escalated: 1 });
    expect(second.summary.entities).toMatchObject({ waiting: 1 });
    expect(await entityOf(page.id)).toBeNull();
    expect(await listOpenReviews(db, datasetId)).toMatchObject([
      { kind: 'match', subject: `${page.id}|${e2}`, context: { page: URL_A3, proposed: 'same' } },
    ]);
    const verdicts = await verdictsAbout(datasetId, page.id);
    expect(verdicts.get(e1)).toMatchObject({ verdict: 'same', who: 'llm' });
    expect(verdicts.get(e2)).toMatchObject({ verdict: 'unsure', who: 'llm' });
    expect(await decisionAbout(datasetId, page.id, e2)).toMatchObject({
      outcome: 'escalated',
      answer: null,
      probabilities: { same: 0.98 },
      evidence: expect.stringContaining('The page is judged to join another entity already.'),
    });
  });

  it('accepts what isn’t a contradiction: a “different”, or its “same” again about the one entity', async () => {
    const datasetId = 'match-no-contradiction';
    const { world, definition, page, e1, e2 } = await versionsAndAPage(datasetId);
    // A new version of the criteria is a new question about each pair, which the decider answers.
    const pack = packs['products/product']!;
    world.ports.packs = {
      'products/product': {
        ...pack,
        match: { version: PACK_VERSION + 1, criteria: pack.match!.criteria },
      },
    };
    const ask = async (entityId: string) => {
      nextRun(world);
      return matchItem(
        contextOf(world, definition),
        { itemId: page.id, entityId },
        { usdLeft: 0.01, down: {} },
        world.ports,
      );
    };
    // The page is the same as the first entity already: a "same" about that entity again agrees
    // with it, and a "different" about the other disagrees with nothing.
    expect(await ask(e1)).toMatchObject({ outcome: 'accepted' });
    world.ports.decider = fakeDecider(() => ({ unrelated: 0.97 })).decider;
    expect(await ask(e2)).toMatchObject({ outcome: 'accepted' });
    const verdicts = await verdictsAbout(datasetId, page.id);
    expect(verdicts.get(e1)).toMatchObject({ verdict: 'same' });
    expect(verdicts.get(e2)).toMatchObject({ verdict: 'not_same' });
  });

  it('lets the page join the other entity when a person says it isn’t the one asked about', async () => {
    const datasetId = 'match-contradiction-different';
    const { world, definition, page, e1, e2 } = await versionsAndAPage(datasetId);
    const asked = await decisionAbout(datasetId, page.id, e2);
    await finalizeDecision(db, { id: asked.id, finalAnswer: 'unrelated', at: world.clock.now() });
    // In the pipeline the answer reaches the next run through the `judge` call in `answerReview`
    // (review.ts). This applies it by the step, as the test of a person’s answer does.
    expect(
      await matchItem(
        contextOf(world, definition),
        { itemId: page.id, entityId: e2 },
        { usdLeft: 0.01, down: {} },
        world.ports,
      ),
    ).toMatchObject({ outcome: 'reused' });
    expect(await listOpenReviews(db, datasetId)).toEqual([]);
    await refresh(world, datasetId);
    expect(await entityOf(page.id)).toBe(e1);
  });

  it('joins the page to the entity a person says it is, not the one a decider accepted', async () => {
    const datasetId = 'match-contradiction-same';
    const { world, definition, page, e2 } = await versionsAndAPage(datasetId);
    const asked = await decisionAbout(datasetId, page.id, e2);
    await finalizeDecision(db, { id: asked.id, finalAnswer: 'same', at: world.clock.now() });
    await matchItem(
      contextOf(world, definition),
      { itemId: page.id, entityId: e2 },
      { usdLeft: 0.01, down: {} },
      world.ports,
    );
    await refresh(world, datasetId);
    expect(await entityOf(page.id)).toBe(e2);
  });

  it('asks a person about its “same” too where a person already said the page is another entity', async () => {
    const datasetId = 'match-contradiction-person';
    const routes = routesWith(DT_80, DT_250);
    routes[URL_A3] = { status: 200, body: productPage({ name: 'DT 770 PRO' }) };
    const definition = withThirdPage(testDefinition(datasetId));
    const {
      world,
      pages: [a1, a2, page],
    } = await worldFor(definition, routes);
    const scripted = fakeDecider(
      (request): Record<string, number> =>
        request.evidence.startsWith(`Record A (${URLS.a2}):`)
          ? { 'spec-version': 0.97 }
          : { same: 0.98 },
    );
    world.ports.decider = scripted.decider;
    await refresh(world, datasetId);
    const [e1, e2] = [(await entityOf(a1!.id))!, (await entityOf(a2!.id))!];
    await judge(db, {
      datasetId,
      itemId: page!.id,
      entityId: e1,
      verdict: 'same',
      who: 'person',
      confidence: 1,
      decisionId: null,
      at: world.clock.now(),
    });
    nextRun(world);
    const matched = await matchItem(
      contextOf(world, definition),
      { itemId: page!.id, entityId: e2 },
      { usdLeft: 0.01, down: {} },
      world.ports,
    );
    expect(matched).toMatchObject({ outcome: 'escalated' });
    expect(await listOpenReviews(db, datasetId)).toMatchObject([
      { subject: `${page!.id}|${e2}`, context: { proposed: 'same' } },
    ]);
    // The person's word settles which entity the page is, and the question about the other is moot.
    await refresh(world, datasetId);
    expect(await entityOf(page!.id)).toBe(e1);
  });
});

describe('a pair that no decider could be asked about', { timeout: 20_000 }, () => {
  it('asks the decider once there is one, with no new revision', async () => {
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(testDefinition('match-late-decider'), routesWith(DT_80, DT_250), {
      decider: false,
    });
    const first = await refresh(world, 'match-late-decider');
    const e1 = await entityOf(a1!.id);
    expect(first.summary.match).toMatchObject({ escalated: 1, accepted: 0 });
    expect(first.summary.entities).toMatchObject({ created: 2, waiting: 1 });
    expect(await listOpenReviews(db, 'match-late-decider')).toMatchObject([
      { kind: 'match', subject: `${a2!.id}|${e1}` },
    ]);
    expect(await judgementsFor(db, 'match-late-decider')).toMatchObject([
      { itemId: a2!.id, entityId: e1, verdict: 'unsure', who: 'rule' },
    ]);

    // With no decider to ask, the pair waits for a person, and nothing is asked again.
    const again = await refresh(world, 'match-late-decider');
    expect(matchSteps(again.names)).toEqual([]);
    expect(again.summary.entities).toMatchObject({ waiting: 1 });
    expect(await decisionsAbout('match-late-decider')).toHaveLength(1);

    // A decider is set up. Resolution plans every page on every run, so no revision is needed.
    world.ports.decider = world.decider.decider;
    const second = await refresh(world, 'match-late-decider');
    expect(matchSteps(second.names)).toEqual([`match:${a2!.id}:${e1}`]);
    expect(second.summary.match).toMatchObject({ accepted: 1, escalated: 0, reused: 0 });
    expect(world.decider.calls).toHaveLength(1);
    expect(await listOpenReviews(db, 'match-late-decider')).toEqual([]);
    expect(await judgementsFor(db, 'match-late-decider')).toMatchObject([
      { itemId: a2!.id, entityId: e1, verdict: 'not_same', who: 'llm' },
    ]);
    expect(await entityOf(a2!.id)).not.toBeNull();
    expect((await published(world, 'match-late-decider'))!.snapshot.records).toHaveLength(3);
  });

  it('asks a person, not the decider, where the dataset doesn’t declare ai-input', async () => {
    const definition = testDefinition('match-no-purpose');
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(
      { ...definition, policy: { ...definition.policy, purposes: [] } },
      routesWith(DT_80, DT_250),
    );
    const first = await refresh(world, 'match-no-purpose');
    expect(first.summary.match).toMatchObject({ escalated: 1, accepted: 0 });
    expect(world.decider.calls).toEqual([]);
    expect(await listOpenReviews(db, 'match-no-purpose')).toMatchObject([
      { subject: `${a2!.id}|${await entityOf(a1!.id)}` },
    ]);

    // The decider is set up, but the dataset doesn't allow it: the pair waits for a person.
    const second = await refresh(world, 'match-no-purpose');
    expect(matchSteps(second.names)).toEqual([]);
    expect(second.summary.entities).toMatchObject({ waiting: 1 });
    expect(world.decider.calls).toEqual([]);
  });

  it('asks a person where a site says ai-input=no, and the decider once it no longer does', async () => {
    const routes = routesWith(DT_80, DT_250);
    routes['https://maker-a.example/robots.txt'] = { status: 200, body: NO_AI_INPUT };
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(testDefinition('match-site-consent'), routes);
    const first = await refresh(world, 'match-site-consent');
    const e1 = await entityOf(a1!.id);
    expect(first.summary.match).toMatchObject({ escalated: 1, accepted: 0 });
    expect(world.decider.calls).toEqual([]);

    // A decider could answer in principle, so the pair is asked again; the site still says no, so
    // the earlier escalation is the answer, and the decision isn't made twice.
    world.clock.advance(25 * HOUR);
    const second = await refresh(world, 'match-site-consent');
    expect(matchSteps(second.names)).toEqual([`match:${a2!.id}:${e1}`]);
    expect(second.summary.match).toMatchObject({ escalated: 1, accepted: 0, reused: 0 });
    expect(world.decider.calls).toEqual([]);
    expect(await decisionsAbout('match-site-consent')).toHaveLength(1);
    expect(await listOpenReviews(db, 'match-site-consent')).toHaveLength(1);

    // The site changes its mind, and the decider is asked at last.
    world.clock.advance(25 * HOUR);
    world.web.routes.set('https://maker-a.example/robots.txt', { status: 200, body: ROBOTS_OPEN });
    const third = await refresh(world, 'match-site-consent');
    expect(third.summary.match).toMatchObject({ accepted: 1, escalated: 0 });
    expect(world.decider.calls).toHaveLength(1);
    expect(await listOpenReviews(db, 'match-site-consent')).toEqual([]);
    expect(await entityOf(a2!.id)).not.toBeNull();
  });
});

describe('a question that isn’t answered in the run that raised it', { timeout: 20_000 }, () => {
  it('leaves the page waiting when the decider fails, and asks again next run', async () => {
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(testDefinition('match-decider-fails'), routesWith(DT_80, DT_250));
    // The decider's message quotes what the model said, and runs past what a note may hold.
    const noisy = `overloaded \u0000 ${'x'.repeat(600)}`;
    const working = fakeDecider(() => ({ 'spec-version': 0.97 }));
    let failing = true;
    world.ports.decider = {
      name: working.decider.name,
      async decide(request) {
        if (failing) throw new Error(noisy);
        return working.decider.decide(request);
      },
    };
    const first = await refresh(world, 'match-decider-fails');
    const e1 = await entityOf(a1!.id);
    expect(first.summary.match).toMatchObject({ failed: 1, accepted: 0 });
    // Workflows keep what a step returns, so the note is clean and short where it is made.
    const note =
      `${URLS.a2}: the decider failed on a match question: llm:test/model: test/model: overloaded  ${'x'.repeat(186)}…`.slice(
        0,
        500,
      );
    expect(first.summary.notes).toContain(note);
    expect(first.results.get(`match:${a2!.id}:${e1}`)).toMatchObject({ note });
    // Nothing was recorded, and the page waits out of the snapshot.
    expect(await decisionsAbout('match-decider-fails')).toEqual([]);
    expect(await judgementsFor(db, 'match-decider-fails')).toEqual([]);
    expect(await entityOf(a2!.id)).toBeNull();
    expect(first.summary.entities).toMatchObject({ created: 2, waiting: 1 });
    expect((await published(world, 'match-decider-fails'))!.snapshot.records).toHaveLength(2);

    failing = false;
    const second = await refresh(world, 'match-decider-fails');
    expect(second.summary.match).toMatchObject({ accepted: 1, failed: 0 });
    expect(await entityOf(a2!.id)).not.toBeNull();
    expect((await published(world, 'match-decider-fails'))!.snapshot.records).toHaveLength(3);
  });

  it('asks again about an answer that didn’t fit the schema, rather than wait for a person', async () => {
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(testDefinition('match-off-schema'), routesWith(DT_80, DT_250));
    // A model's answer that doesn't fit the schema comes back as no probabilities at all.
    world.ports.decider = createLlmDecider(fakeLlm(() => null).llm);
    const first = await refresh(world, 'match-off-schema');
    const e1 = await entityOf(a1!.id);
    expect(first.summary.match).toMatchObject({ escalated: 1, accepted: 0 });
    // The decider weighed nothing, so it gave no answer. Its "unsure" is the rule's, which asks a
    // person for now, and asks the decider again once there is one that answers.
    expect(await judgementsFor(db, 'match-off-schema')).toMatchObject([
      { itemId: a2!.id, entityId: e1, verdict: 'unsure', who: 'rule' },
    ]);
    expect(await listOpenReviews(db, 'match-off-schema')).toHaveLength(1);

    const answering = fakeDecider(() => ({ 'spec-version': 0.97 }));
    world.ports.decider = answering.decider;
    const second = await refresh(world, 'match-off-schema');
    expect(matchSteps(second.names)).toEqual([`match:${a2!.id}:${e1}`]);
    expect(second.summary.match).toMatchObject({ accepted: 1, escalated: 0, reused: 0 });
    expect(answering.calls).toHaveLength(1);
    expect(await listOpenReviews(db, 'match-off-schema')).toEqual([]);
    expect(await judgementsFor(db, 'match-off-schema')).toMatchObject([
      { itemId: a2!.id, entityId: e1, verdict: 'not_same', who: 'llm' },
    ]);
    expect(await entityOf(a2!.id)).not.toBeNull();
  });

  it('stops asking once the run’s LLM budget is spent, and asks the rest next run', async () => {
    const definition = withThirdPage(testDefinition('match-budget'));
    const routes = routesWith(DT_80, DT_250);
    routes[URL_A3] = { status: 200, body: productPage(DT_600) };
    const {
      world,
      pages: [a1, a2, a3],
    } = await worldFor(
      { ...definition, budget: { ...definition.budget, llmUsdPerRun: 0.0005 } },
      routes,
      { llm: false },
    );
    // A2 is the same product, and A3 a different one.
    const scripted = fakeDecider(
      (request): Record<string, number> =>
        request.evidence.startsWith(`Record A (${URLS.a2}):`)
          ? { same: 0.98 }
          : { unrelated: 0.97 },
    );
    world.ports.decider = scripted.decider;
    // A2's question spends 520 tokens, so A3's waits.
    const first = await refresh(world, 'match-budget');
    const e1 = await entityOf(a1!.id);
    expect(matchSteps(first.names)).toEqual([`match:${a2!.id}:${e1}`, `match:${a3!.id}:${e1}`]);
    expect(first.summary.match).toMatchObject({ accepted: 1, skipped: 1 });
    expect(scripted.calls).toHaveLength(1);
    expect(first.summary.entities).toMatchObject({ created: 2, linked: 1, waiting: 1 });
    expect(await entityOf(a2!.id)).toBe(e1);
    expect(await entityOf(a3!.id)).toBeNull();

    // The next run has a budget of its own: it asks only what is still open.
    const second = await refresh(world, 'match-budget');
    expect(matchSteps(second.names)).toEqual([`match:${a3!.id}:${e1}`]);
    expect(second.summary.match).toMatchObject({ accepted: 1, skipped: 0 });
    expect(second.summary.entities).toMatchObject({ created: 1, linked: 0, waiting: 0 });
    expect(scripted.calls).toHaveLength(2);
    expect((await published(world, 'match-budget'))!.snapshot.records).toHaveLength(3);
  });

  it('counts the pages both resolutions joined and created', async () => {
    const routes = routesWith(DT_80, DT_250);
    // A3 gives A1's GTIN, so the first resolution joins it to A1's entity, whatever its name.
    routes[URL_A3] = { status: 200, body: productPage({ ...DT_80, name: 'DT 770 PRO (2024)' }) };
    const {
      world,
      pages: [a1, a2, a3],
    } = await worldFor(withThirdPage(testDefinition('match-counts')), routes);
    world.ports.decider = fakeDecider(() => ({ same: 0.98 })).decider;
    const first = await refresh(world, 'match-counts');
    // The first resolution creates A1's entity and B1's, and links A3. A2's question is answered
    // "same", so the second resolution links it.
    expect(first.summary.entities).toEqual({
      created: 2,
      linked: 2,
      conflicts: 0,
      unresolved: 0,
      waiting: 0,
    });
    const e1 = await entityOf(a1!.id);
    expect([await entityOf(a2!.id), await entityOf(a3!.id)]).toEqual([e1, e1]);
  });

  it('carries on from a resolution that a version without match questions kept', async () => {
    const datasetId = 'match-old-resolve';
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(testDefinition(datasetId), routesWith(DT_80, DT_250));
    // Workflows keep what a step returns, and a resolution from before questions has none.
    const kept: StepRunner = {
      async do(name, fn) {
        const result = JSON.parse(JSON.stringify((await fn()) ?? null)) as Record<string, unknown>;
        if (name === 'resolve') delete result.questions;
        return result as never;
      },
      async sleep(_name, ms) {
        world.clock.advance(ms);
      },
    };
    const summary = await runRefresh(
      { runId: runIdFor(datasetId, world.clock.now()), datasetId },
      kept,
      world.ports,
    );
    // Nothing was asked, and the page waits for the next run, which asks.
    expect(summary.entities).toMatchObject({ created: 2, waiting: 1 });
    expect(world.decider.calls).toEqual([]);
    world.clock.advance(5 * 60_000);
    const next = await refresh(world, datasetId);
    expect(matchSteps(next.names)).toEqual([`match:${a2!.id}:${await entityOf(a1!.id)}`]);
    expect(next.summary.match).toMatchObject({ accepted: 1 });
  });

  it('reports the decision it made when it runs again, and counts it once', async () => {
    const cases: [string, Record<string, number>, { accepted: number; escalated: number }][] = [
      ['match-replayed', { 'spec-version': 0.97 }, { accepted: 1, escalated: 0 }],
      ['match-replayed-unsure', { same: 0.5, 'spec-version': 0.45 }, { accepted: 0, escalated: 1 }],
    ];
    for (const [datasetId, answer, expected] of cases) {
      const { world } = await worldFor(testDefinition(datasetId), routesWith(DT_80, DT_250));
      world.ports.decider = fakeDecider(() => answer).decider;
      const runId = runIdFor(datasetId, world.clock.now());
      // Each match step runs twice, as Workflows runs a step again after a crash.
      const ran = new Set<string>();
      const replaying: StepRunner = {
        async do(name, fn) {
          if (name.startsWith('match:') && !ran.has(name)) {
            ran.add(name);
            await fn();
          }
          return JSON.parse(JSON.stringify((await fn()) ?? null)) as never;
        },
        async sleep(_name, ms) {
          world.clock.advance(ms);
        },
      };
      const summary = await runRefresh({ runId, datasetId }, replaying, world.ports);
      expect(summary.match, datasetId).toEqual({
        rule: 0,
        skipped: 0,
        failed: 0,
        reused: 0,
        ...expected,
        inputTokens: 500,
        outputTokens: 20,
      });
      expect(await decisionsAbout(datasetId), datasetId).toHaveLength(1);
      expect(summary.spend?.match?.['test-model'], datasetId).toMatchObject({
        calls: 1,
        failed: 0,
        inputTokens: 500,
        outputTokens: 20,
      });
    }
  });

  it('counts the rule’s pair once when its step runs again', async () => {
    const datasetId = 'match-rule-replayed';
    const { world } = await worldFor(
      testDefinition(datasetId),
      routesWith({ name: 'HD 660S' }, { name: 'HD 660S2' }),
    );
    const runId = runIdFor(datasetId, world.clock.now());
    // Each match step runs twice, as Workflows runs a step again after a crash.
    const ran = new Set<string>();
    const replaying: StepRunner = {
      async do(name, fn) {
        if (name.startsWith('match:') && !ran.has(name)) {
          ran.add(name);
          await fn();
        }
        return JSON.parse(JSON.stringify((await fn()) ?? null)) as never;
      },
      async sleep(_name, ms) {
        world.clock.advance(ms);
      },
    };
    const summary = await runRefresh({ runId, datasetId }, replaying, world.ports);
    expect(summary.match).toEqual({
      rule: 1,
      accepted: 0,
      escalated: 0,
      reused: 0,
      skipped: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(summary.ruleApart).toEqual(['HD 660S2 and HD 660S']);
    expect(await decisionsAbout(datasetId)).toHaveLength(1);
  });
});

describe('the match step', { timeout: 20_000 }, () => {
  /** A run whose decider is down: A2's question was raised, and nothing came of it. */
  async function unanswered(definition: Definition) {
    const { world, pages } = await worldFor(definition, routesWith(DT_80, DT_250));
    world.ports.decider = DOWN;
    await refresh(world, definition.dataset);
    nextRun(world);
    const [a1, a2, b1] = pages;
    return { world, a1: a1!, a2: a2!, b1: b1!, e1: (await entityOf(a1!.id))! };
  }

  it('reuses an answer as sure as the dataset asks, and asks again when it asks for more', async () => {
    const definition = testDefinition('match-sure');
    const { world, a2, e1 } = await unanswered(definition);
    const scripted = fakeDecider(() => ({ 'spec-version': 0.96, same: 0.02 }));
    world.ports.decider = scripted.decider;
    const askedAt = async (accept: number) => {
      const stricter = { ...definition, decisions: { ...definition.decisions, match: { accept } } };
      const matched = await matchItem(
        contextOf(world, stricter),
        { itemId: a2.id, entityId: e1 },
        { usdLeft: 0.01, down: {} },
        world.ports,
      );
      nextRun(world);
      return matched;
    };
    expect(await askedAt(0.95)).toMatchObject({
      outcome: 'accepted',
      usage: { inputTokens: 500, outputTokens: 20 },
    });
    // The answer is as sure as the dataset now asks: it stands, and costs nothing.
    expect(await askedAt(0.96)).toEqual({
      outcome: 'reused',
      calls: [],
      down: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      note: null,
    });
    expect(scripted.calls).toHaveLength(1);
    // The dataset asks for more than the decider was sure of, so the decider is asked again, and
    // a person is asked what it still isn't sure of.
    expect(await askedAt(0.97)).toMatchObject({ outcome: 'escalated' });
    expect(scripted.calls).toHaveLength(2);
    expect(await listOpenReviews(db, 'match-sure')).toHaveLength(1);
  });

  it('accepts a relationship on its outcome’s total, and asks the decider once', async () => {
    const definition = testDefinition('match-outcome');
    const { world, a2, e1 } = await unanswered(definition);
    const scripted = fakeDecider(() => ({ 'other-model': 0.6, 'spec-version': 0.38, same: 0.02 }));
    world.ports.decider = scripted.decider;
    const ask = async () => {
      const matched = await matchItem(
        contextOf(world, definition),
        { itemId: a2.id, entityId: e1 },
        { usdLeft: 0.01, down: {} },
        world.ports,
      );
      nextRun(world);
      return matched;
    };
    expect(await ask()).toMatchObject({ outcome: 'accepted' });
    expect((await decisionsAbout('match-outcome')).map((row) => row.answer)).toEqual([
      'other-model',
    ]);
    expect(await judgementsFor(db, 'match-outcome')).toMatchObject([
      { itemId: a2.id, entityId: e1, verdict: 'not_same', who: 'llm', confidence: 0.98 },
    ]);
    // The answer was as sure as its outcome, so asking again reuses it, at no cost.
    expect(await ask()).toEqual({
      outcome: 'reused',
      calls: [],
      down: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      note: null,
    });
    expect(scripted.calls).toHaveLength(1);
  });

  it('finds its decision again whatever lineup it is shown, since the lineup isn’t part of its key', async () => {
    const definition = testDefinition('match-lineup-key');
    const { world, a2, e1 } = await unanswered(definition);
    const scripted = fakeDecider(() => ({ unrelated: 0.97 }));
    world.ports.decider = scripted.decider;
    const ask = async (lineup: { name: string; keptApart: boolean }[]) => {
      const matched = await matchItem(
        contextOf(world, definition),
        { itemId: a2.id, entityId: e1, lineup },
        { usdLeft: 0.01, down: {} },
        world.ports,
      );
      nextRun(world);
      return matched;
    };
    expect(await ask([])).toMatchObject({ outcome: 'accepted' });
    // A new record in the brand doesn't ask a settled pair again.
    expect(await ask([{ name: 'DT 990 PRO', keptApart: false }])).toMatchObject({
      outcome: 'reused',
    });
    expect(scripted.calls).toHaveLength(1);
  });

  it('applies a person’s answer, and closes the question', async () => {
    const definition = testDefinition('match-person');
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(definition, routesWith(DT_80, DT_250));
    const scripted = fakeDecider(() => ({ same: 0.5, 'spec-version': 0.45 }));
    world.ports.decider = scripted.decider;
    await refresh(world, 'match-person');
    const e1 = (await entityOf(a1!.id))!;
    const [asked] = await decisionsAbout('match-person');
    await finalizeDecision(db, { id: asked!.id, finalAnswer: 'same', at: world.clock.now() });

    // The person's answer stands, though the decider could be asked again. In the pipeline it
    // reaches the next run through the `judge` call in `answerReview` (review.ts); this test
    // drives `matchItem` after `finalizeDecision` directly.
    const matched = await matchItem(
      contextOf(world, definition),
      { itemId: a2!.id, entityId: e1 },
      { usdLeft: 0.01, down: {} },
      world.ports,
    );
    expect(matched).toMatchObject({ outcome: 'reused' });
    expect(scripted.calls).toHaveLength(1);
    expect(await judgementsFor(db, 'match-person')).toMatchObject([
      { itemId: a2!.id, entityId: e1, verdict: 'same', who: 'person', confidence: 1 },
    ]);
    expect(await listOpenReviews(db, 'match-person')).toEqual([]);
    await refresh(world, 'match-person');
    expect(await entityOf(a2!.id)).toBe(e1);
  });

  it('leaves a pair alone when its page or entity is no longer there', async () => {
    const definition = testDefinition('match-gone');
    const { world, a2 } = await unanswered(definition);
    world.ports.decider = world.decider.decider;
    const matched = await matchItem(
      contextOf(world, definition),
      { itemId: a2.id, entityId: 'sp_00000000000000000000' },
      { usdLeft: 0.01, down: {} },
      world.ports,
    );
    expect(matched).toEqual({
      outcome: 'skipped',
      calls: [],
      down: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      note: null,
    });
    expect(world.decider.calls).toEqual([]);
    expect(await decisionsAbout('match-gone')).toEqual([]);
  });

  it('asks no decider once the run’s budget is spent, but still sends a person what none could answer', async () => {
    const definition = testDefinition('match-spent');
    const { world, a2, e1 } = await unanswered(definition);
    const scripted = fakeDecider(() => ({ 'spec-version': 0.97 }));
    world.ports.decider = scripted.decider;
    const question = { itemId: a2.id, entityId: e1 };
    expect(
      await matchItem(
        contextOf(world, definition),
        question,
        { usdLeft: 0, down: {} },
        world.ports,
      ),
    ).toMatchObject({
      outcome: 'skipped',
    });
    expect(scripted.calls).toEqual([]);
    expect(await decisionsAbout('match-spent')).toEqual([]);

    // Where the dataset allows no decider, the budget has nothing to hold back.
    nextRun(world);
    const noPurpose = { ...definition, policy: { ...definition.policy, purposes: [] } };
    expect(
      await matchItem(contextOf(world, noPurpose), question, { usdLeft: 0, down: {} }, world.ports),
    ).toMatchObject({
      outcome: 'escalated',
    });
    expect(scripted.calls).toEqual([]);
    expect(await listOpenReviews(db, 'match-spent')).toHaveLength(1);
  });

  it('asks again when the pack words "same" differently, and says so with a new version', async () => {
    const definition = testDefinition('match-criteria');
    const { world, a2, e1 } = await unanswered(definition);
    const scripted = fakeDecider(() => ({ unrelated: 0.97 }));
    world.ports.decider = scripted.decider;
    const ask = async () => {
      const matched = await matchItem(
        contextOf(world, definition),
        { itemId: a2.id, entityId: e1 },
        { usdLeft: 0.01, down: {} },
        world.ports,
      );
      nextRun(world);
      return matched;
    };
    expect(await ask()).toMatchObject({ outcome: 'accepted' });
    expect(await ask()).toMatchObject({ outcome: 'reused' });
    expect(scripted.calls).toHaveLength(1);

    // New words under the same version are a new question all the same: the hash has the words.
    const pack = packs['products/product']!;
    const worded = (version: number) => ({
      'products/product': { ...pack, match: { version, criteria: 'same: only a colour.' } },
    });
    world.ports.packs = worded(PACK_VERSION);
    expect(await ask()).toMatchObject({ outcome: 'accepted' });
    expect(scripted.calls).toHaveLength(2);
    expect(scripted.calls[1]!.criteria).toBe('same: only a colour.');

    // A new version under the same words is one too.
    world.ports.packs = worded(PACK_VERSION + 1);
    expect(await ask()).toMatchObject({ outcome: 'accepted' });
    expect(scripted.calls).toHaveLength(3);
    const versions = (await decisionsAbout('match-criteria')).map((row) => row.criteriaVersion);
    expect(versions.sort()).toEqual([PACK_VERSION, PACK_VERSION, PACK_VERSION + 1]);
  });

  it('describes "same" with the generic criteria where the record type has no pack', async () => {
    const definition = testDefinition('match-generic');
    const { world, a2, e1 } = await unanswered(definition);
    const scripted = fakeDecider(() => ({ unrelated: 0.97 }));
    world.ports.decider = scripted.decider;
    world.ports.packs = {};
    await matchItem(
      contextOf(world, definition),
      { itemId: a2.id, entityId: e1 },
      { usdLeft: 0.01, down: {} },
      world.ports,
    );
    expect(scripted.calls[0]!.criteria).toBe(GENERIC_MATCH_CRITERIA);
    expect(await decisionsAbout('match-generic')).toMatchObject([{ criteriaVersion: 0 }]);
  });

  it('needs the consent of every site it shows the decider: the page’s, and each of the entity’s', async () => {
    const definition = testDefinition('match-hosts');
    const {
      world,
      pages: [a1, , b1],
    } = await worldFor(definition, routesWith(DT_80, DT_250), { llm: false });
    const scripted = fakeDecider(() => ({ unrelated: 0.97 }));
    world.ports.decider = scripted.decider;
    await refresh(world, 'match-hosts');
    const e1 = (await entityOf(a1!.id))!;
    const asked = scripted.calls.length;
    // B1 is another maker's page, asked against maker A's entity: two sites are shown.
    const hosts = async () => {
      nextRun(world);
      const matched = await matchItem(
        contextOf(world, definition),
        { itemId: b1!.id, entityId: e1 },
        { usdLeft: 0.01, down: {} },
        world.ports,
      );
      return { matched, asked: scripted.calls.length - asked };
    };
    expect(await hosts()).toMatchObject({ matched: { outcome: 'accepted' }, asked: 1 });

    // Maker A's site now says no, and its pages are the entity's. The answer given before rested
    // on its pages, so it can't stand, and nobody is asked.
    world.clock.advance(25 * HOUR);
    world.web.routes.set('https://maker-a.example/robots.txt', { status: 200, body: NO_AI_INPUT });
    await refresh(world, 'match-hosts');
    expect(await hosts()).toMatchObject({ matched: { outcome: 'escalated' }, asked: 1 });

    // Maker A says yes again, and maker B, the page's site, says no.
    world.clock.advance(25 * HOUR);
    world.web.routes.set('https://maker-a.example/robots.txt', { status: 200, body: ROBOTS_OPEN });
    world.web.routes.set('https://maker-b.example/robots.txt', { status: 200, body: NO_AI_INPUT });
    await refresh(world, 'match-hosts');
    expect(await hosts()).toMatchObject({ matched: { outcome: 'escalated' }, asked: 1 });
  });
});

/** A fake decider that answers as the model named, so its decisions record `llm:<model>`. */
const named = (
  model: string,
  answer: (request: DecisionRequest) => Record<string, number> | null,
) => {
  const fake = fakeDecider(answer);
  return { ...fake, decider: { ...fake.decider, name: `llm:${model}` } };
};

describe('match through steps (ADR 0010)', { timeout: 20_000 }, () => {
  it('asks the backup when the model fails, and marks its provider down for the run', async () => {
    const id = 'match-step-backup';
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(
      { ...testDefinition(id), models: { match: [{ model: 'down/x', backup: 'up/y' }] } },
      routesWith(DT_80, DT_250),
    );
    let downCalls = 0;
    const down: Decider = {
      name: 'llm:down/x',
      async decide() {
        downCalls += 1;
        throw new LlmHttpError(402, '402 Insufficient credits');
      },
    };
    const up = named('up/y', () => ({ 'spec-version': 0.97 }));
    world.ports.modelPorts = modelPortsOf(world, {
      decider: { 'down/x': down, 'up/y': up.decider },
    });
    const run = await refresh(world, id);
    const e1 = await entityOf(a1!.id);
    expect(run.summary.match).toMatchObject({ accepted: 1, failed: 0 });
    expect(downCalls).toBe(1);
    expect(up.calls).toHaveLength(1);
    expect(await decisionsAbout(id)).toMatchObject([
      { adapter: 'llm:up/y', answer: 'spec-version', subject: `${a2!.id}|${e1}` },
    ]);
    expect(run.summary.llm.down?.down?.reason).toBe('payment required');
    expect(run.summary.spend?.match?.['down/x']).toMatchObject({ calls: 1, failed: 1 });
    expect(run.summary.spend?.match?.['up/y']).toMatchObject({ calls: 1, failed: 0 });
  });

  it('asks a person only what every step weighed', async () => {
    const id = 'match-step-weighed';
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(
      { ...testDefinition(id), models: { match: ['cheap/x', 'strong/y'] } },
      routesWith(DT_80, DT_250),
    );
    const cheap = named('cheap/x', () => ({ same: 0.5, 'spec-version': 0.45 }));
    const strong = named('strong/y', () => ({ same: 0.6, 'spec-version': 0.35 }));
    let strongDown = true;
    world.ports.modelPorts = modelPortsOf(world, {
      decider: {
        'cheap/x': cheap.decider,
        'strong/y': {
          name: 'llm:strong/y',
          async decide(request) {
            if (strongDown) throw new LlmHttpError(500, 'overloaded');
            return strong.decider.decide(request);
          },
        },
      },
    });
    const first = await refresh(world, id);
    const e1 = await entityOf(a1!.id);
    expect(first.summary.match).toMatchObject({ failed: 1, escalated: 0 });
    expect(first.summary.notes.some((note) => note.includes('strong/y'))).toBe(true);
    expect(await decisionsAbout(id)).toEqual([]);
    expect(await judgementsFor(db, id)).toEqual([]);
    expect(await listOpenReviews(db, id)).toEqual([]);

    strongDown = false;
    const second = await refresh(world, id);
    expect(second.summary.match).toMatchObject({ escalated: 1, failed: 0 });
    expect(await listOpenReviews(db, id)).toMatchObject([
      {
        kind: 'match',
        subject: `${a2!.id}|${e1}`,
        context: { proposed: 'same', probabilities: { same: 0.6, 'spec-version': 0.35 } },
      },
    ]);
    expect(await decisionsAbout(id)).toMatchObject([
      { outcome: 'escalated', adapter: 'llm:strong/y' },
    ]);
  });
});
