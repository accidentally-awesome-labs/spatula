import {
  createLlmDecider,
  GENERIC_MATCH_CRITERIA,
  runIdFor,
  type Decider,
  type Definition,
  type PagesSource,
} from '@spatula/core';
import { packs } from '@spatula/pack-products';
import { decisionRecords, finalizeDecision, judgementsFor, listOpenReviews } from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import { fakeDecider, fakeLlm, type World } from '../test/node/fakes';
import { entityOf, published, refresh, worldFor } from '../test/node/runs';
import { productPage, ROBOTS_OPEN, standardRoutes, URLS } from '../test/pages';
import { matchItem } from './match';
import type { Context } from './pipeline';
import { runRefresh, type StepRunner } from './refresh';

/** The test dataset, with maker-a's two pages saying what a test needs them to. */
function routesWith(a1: Record<string, unknown>, a2: Record<string, unknown>) {
  const routes = standardRoutes();
  routes[URLS.a1] = { status: 200, body: productPage(a1) };
  routes[URLS.a2] = { status: 200, body: productPage(a2) };
  return routes;
}

const DT_80 = { name: 'DT 770 PRO', gtin13: '4010118471063' };
const DT_250 = { name: 'DT 770 PRO', gtin13: '4010118471070' };
const DT_600 = { name: 'DT 770 PRO', gtin13: '4010118471087' };
const URL_A3 = 'https://maker-a.example/products/a3';

/** The version of the criteria the products pack gives the decider. */
const PACK_VERSION = packs['products/product']!.match!.version;

const HOUR = 3_600_000;
const NO_AI_INPUT = 'User-agent: *\nContent-Signal: ai-input=no\nAllow: /\n';

/** The test dataset with a third page for maker A, at a3. */
function withThirdPage(definition: Definition): Definition {
  const makerA = definition.sources[0] as PagesSource;
  return {
    ...definition,
    sources: [{ ...makerA, pages: [...makerA.pages, URL_A3] }, definition.sources[1]!],
  };
}

const decisionsAbout = (datasetId: string) =>
  db.select().from(decisionRecords).where(eq(decisionRecords.datasetId, datasetId));

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
    world.ports.decider = fakeDecider(() => ({ variant: 0.97, same: 0.02 })).decider;
    const first = await refresh(world, 'match-variant');
    const e1 = await entityOf(a1!.id);
    expect(first.names.slice(-5)).toEqual([
      'resolve',
      `match:${a2!.id}:${e1}`,
      'resolve:matched',
      'snapshot',
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
    const scripted = fakeDecider(() => ({ same: 0.5, variant: 0.45 }));
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
          probabilities: { same: 0.5, variant: 0.45 },
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

  it('asks about a similar name within the brand, showing the decider both records', async () => {
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(
      testDefinition('match-similar'),
      routesWith({ name: 'HD 660S' }, { name: 'HD 660S2' }),
    );
    const first = await refresh(world, 'match-similar');
    const e1 = await entityOf(a1!.id);
    expect(first.names).toContain(`match:${a2!.id}:${e1}`);
    expect(world.decider.calls[0]!.question).toMatchObject({
      options: ['same', 'variant', 'different'],
    });
    expect(world.decider.calls[0]!.criteria).toContain('variant: a version of the model');
    expect(world.decider.calls[0]!.evidence).toContain(`Record A (${URLS.a2}):`);
    expect(world.decider.calls[0]!.evidence).toContain('name: HD 660S2');
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
        answer: 'different',
        criteriaVersion: PACK_VERSION,
      },
    ]);
  });

  it('proposes the option offered first when the decider is torn, whichever it ranked first', async () => {
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(testDefinition('match-torn'), routesWith(DT_80, DT_250));
    world.ports.decider = fakeDecider(() => ({ variant: 0.45, same: 0.45 })).decider;
    await refresh(world, 'match-torn');
    expect(await listOpenReviews(db, 'match-torn')).toMatchObject([
      {
        subject: `${a2!.id}|${await entityOf(a1!.id)}`,
        context: { proposed: 'same', probabilities: { variant: 0.45, same: 0.45 } },
      },
    ]);
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
      // The 250 is a version of the 80. The page is the 250 ohm one: the same as that, not as the 80.
      const scripted = fakeDecider((request): Record<string, number> => {
        if (request.evidence.startsWith(`Record A (${v250Url}):`)) return { variant: 0.97 };
        return request.evidence.includes(`Record B (${v250Url}):`)
          ? { same: 0.98 }
          : { different: 0.97 };
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
    const working = fakeDecider(() => ({ variant: 0.97 }));
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
      `${URLS.a2}: the decider failed on a match question: overloaded  ${'x'.repeat(600)}`.slice(
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

    const answering = fakeDecider(() => ({ variant: 0.97 }));
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
      { ...definition, budget: { ...definition.budget, llmTokensPerRun: 500 } },
      routes,
      { llm: false },
    );
    // A2 is the same product, and A3 a different one.
    const scripted = fakeDecider(
      (request): Record<string, number> =>
        request.evidence.startsWith(`Record A (${URLS.a2}):`)
          ? { same: 0.98 }
          : { different: 0.97 },
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
      ['match-replayed', { variant: 0.97 }, { accepted: 1, escalated: 0 }],
      ['match-replayed-unsure', { same: 0.5, variant: 0.45 }, { accepted: 0, escalated: 1 }],
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
    }
  });
});

describe('the match step', { timeout: 20_000 }, () => {
  const contextOf = (world: World, definition: Definition): Context => ({
    runId: runIdFor(definition.dataset, world.clock.now()),
    datasetId: definition.dataset,
    revision: 1,
    definition,
    startedAt: world.clock.now(),
  });
  /** The next run's time, so what the step makes is a new run's decision. */
  const nextRun = (world: World) => world.clock.advance(5 * 60_000);

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
    const scripted = fakeDecider(() => ({ variant: 0.96, same: 0.02 }));
    world.ports.decider = scripted.decider;
    const askedAt = async (accept: number) => {
      const stricter = { ...definition, decisions: { ...definition.decisions, match: { accept } } };
      const matched = await matchItem(
        contextOf(world, stricter),
        { itemId: a2.id, entityId: e1 },
        10_000,
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

  it('applies a person’s answer, and closes the question', async () => {
    const definition = testDefinition('match-person');
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(definition, routesWith(DT_80, DT_250));
    const scripted = fakeDecider(() => ({ same: 0.5, variant: 0.45 }));
    world.ports.decider = scripted.decider;
    await refresh(world, 'match-person');
    const e1 = (await entityOf(a1!.id))!;
    const [asked] = await decisionsAbout('match-person');
    await finalizeDecision(db, { id: asked!.id, finalAnswer: 'same', at: world.clock.now() });

    // The person's answer stands, though the decider could be asked again. In the pipeline it
    // reaches the next run through the `judge` call that Task 16 adds; this test drives `matchItem`
    // after `finalizeDecision` directly.
    const matched = await matchItem(
      contextOf(world, definition),
      { itemId: a2!.id, entityId: e1 },
      10_000,
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
      10_000,
      world.ports,
    );
    expect(matched).toEqual({
      outcome: 'skipped',
      usage: { inputTokens: 0, outputTokens: 0 },
      note: null,
    });
    expect(world.decider.calls).toEqual([]);
    expect(await decisionsAbout('match-gone')).toEqual([]);
  });

  it('asks no decider once the run’s budget is spent, but still sends a person what none could answer', async () => {
    const definition = testDefinition('match-spent');
    const { world, a2, e1 } = await unanswered(definition);
    const scripted = fakeDecider(() => ({ variant: 0.97 }));
    world.ports.decider = scripted.decider;
    const question = { itemId: a2.id, entityId: e1 };
    expect(await matchItem(contextOf(world, definition), question, 0, world.ports)).toMatchObject({
      outcome: 'skipped',
    });
    expect(scripted.calls).toEqual([]);
    expect(await decisionsAbout('match-spent')).toEqual([]);

    // Where the dataset allows no decider, the budget has nothing to hold back.
    nextRun(world);
    const noPurpose = { ...definition, policy: { ...definition.policy, purposes: [] } };
    expect(await matchItem(contextOf(world, noPurpose), question, 0, world.ports)).toMatchObject({
      outcome: 'escalated',
    });
    expect(scripted.calls).toEqual([]);
    expect(await listOpenReviews(db, 'match-spent')).toHaveLength(1);
  });

  it('asks again when the pack words "same" differently, and says so with a new version', async () => {
    const definition = testDefinition('match-criteria');
    const { world, a2, e1 } = await unanswered(definition);
    const scripted = fakeDecider(() => ({ different: 0.97 }));
    world.ports.decider = scripted.decider;
    const ask = async () => {
      const matched = await matchItem(
        contextOf(world, definition),
        { itemId: a2.id, entityId: e1 },
        10_000,
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
    const scripted = fakeDecider(() => ({ different: 0.97 }));
    world.ports.decider = scripted.decider;
    world.ports.packs = {};
    await matchItem(
      contextOf(world, definition),
      { itemId: a2.id, entityId: e1 },
      10_000,
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
    const scripted = fakeDecider(() => ({ different: 0.97 }));
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
        10_000,
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
