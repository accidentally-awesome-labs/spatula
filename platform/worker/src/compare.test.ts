import {
  finalAnswerText,
  findItem,
  type Decider,
  type Definition,
  type TaxonomySubject,
} from '@spatula/core';
import {
  decisionRecords,
  finalizeDecision,
  items,
  judgements,
  reviewItems,
  statements,
} from '@spatula/store';
import { testDefinition, testTaxonomy, testTaxonomyDefinition } from '@spatula/store/fixtures';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import { fakeDecider, fakeStep, modelPortsOf, type World } from '../test/node/fakes';
import { DT_250, DT_80, routesWith } from '../test/node/match-world';
import { decidedDefinition as decided, refresh, taxonomyWorld, worldFor } from '../test/node/runs';
import { standardRoutes, URLS } from '../test/pages';
import {
  COMPARISON_ID,
  comparisonIdFor,
  comparisonKey,
  datasetOfComparison,
  runComparison,
  type CompareParams,
} from './compare';
import { LlmHttpError } from './llm-openai';
import type { PlaceState } from './taxonomy';

const HOUR = 3_600_000;
const NO_AI_INPUT = 'User-agent: *\nContent-Signal: ai-input=no\nAllow: /\n';
/** What one of the fake decider's answers costs at the tests' $1 per million tokens: 500 in, 20 out. */
const CALL_USD = 520 / 1_000_000;

/** The test dataset with every page's category left to the cascade: maker-b's B1 too. */
function everyPageDecided(datasetId: string): Definition {
  return decided(datasetId, {
    sources: decided(datasetId).sources.map((source) =>
      source.id === 'maker-b' ? { ...source, fixed: { brand: 'Maker B' } } : source,
    ),
  });
}

/** The world's fake decider, under a model name a price can be found for. */
const priced = (world: World): Decider => ({ ...world.decider.decider, name: 'llm:test/model' });

/** Everything a comparison must leave alone in a dataset, as rows. */
async function datasetRows(datasetId: string) {
  return {
    decisions: await db
      .select()
      .from(decisionRecords)
      .where(eq(decisionRecords.datasetId, datasetId))
      .orderBy(asc(decisionRecords.id)),
    judgements: await db
      .select()
      .from(judgements)
      .where(eq(judgements.datasetId, datasetId))
      .orderBy(asc(judgements.itemId)),
    reviews: await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.datasetId, datasetId))
      .orderBy(asc(reviewItems.id)),
    statements: await db
      .select()
      .from(statements)
      .where(eq(statements.datasetId, datasetId))
      .orderBy(asc(statements.id)),
    items: await db
      .select()
      .from(items)
      .where(eq(items.datasetId, datasetId))
      .orderBy(asc(items.id)),
  };
}

/** The dataset's current decisions, by the address of the page each is about. */
async function decisionsByPage(datasetId: string) {
  const pages = await db.select().from(items).where(eq(items.datasetId, datasetId));
  const rows = await db
    .select()
    .from(decisionRecords)
    .where(eq(decisionRecords.datasetId, datasetId));
  const byUrl = (url: string) => {
    const page = pages.find((item) => item.locator === url)!;
    return rows.find((row) => row.subject === page.id && row.supersededAt === null)!;
  };
  return { a1: byUrl(URLS.a1), a2: byUrl(URLS.a2), b1: byUrl(URLS.b1) };
}

/**
 * Three pages classified by the world's fake decider, all accepted, and then a person's answers to
 * two of them: A1 Headphones, as the decider said, and A2 DAC/Amp, which it didn't.
 */
async function decidedWorld(datasetId: string) {
  // Without LLM extraction a page's state stays the same from run to run, so a later run keeps
  // the decisions this one makes current.
  const { world } = await worldFor(everyPageDecided(datasetId), standardRoutes(), { llm: false });
  world.ports.decider = priced(world);
  await refresh(world, datasetId);
  const decisions = await decisionsByPage(datasetId);
  expect([decisions.a1, decisions.a2, decisions.b1].map((row) => row.outcome)).toEqual([
    'accepted',
    'accepted',
    'accepted',
  ]);
  const at = world.clock.now();
  await finalizeDecision(db, { id: decisions.a1.id, finalAnswer: 'Headphones', at });
  await finalizeDecision(db, { id: decisions.a2.id, finalAnswer: 'DAC/Amp', at });
  return { world, decisions };
}

function paramsFor(world: World, datasetId: string, more: Partial<CompareParams> = {}) {
  const at = world.clock.now();
  return {
    comparisonId: comparisonIdFor(datasetId, at),
    datasetId,
    job: 'classify',
    model: 'cheap/x',
    backup: null,
    accept: null,
    limit: 200,
    maxUsd: 2,
    startedAt: at.toISOString(),
    ...more,
  } satisfies CompareParams;
}

describe('comparison IDs', () => {
  it('carry their dataset and the time they started, in UTC', () => {
    const id = comparisonIdFor(
      'crowdio-audio-products',
      new Date(Date.UTC(2026, 9, 24, 19, 42, 7)),
    );
    expect(id).toBe('cmp-crowdio-audio-products-20261024194207');
    expect(COMPARISON_ID.test(id)).toBe(true);
    expect(datasetOfComparison(id)).toBe('crowdio-audio-products');
    expect(datasetOfComparison(comparisonIdFor('set-2', new Date(0)))).toBe('set-2');
    expect(datasetOfComparison('cmp-20261024194207')).toBeNull();
    expect(datasetOfComparison('run-crowdio-20261024194207')).toBeNull();
    expect(comparisonKey('crowdio-audio-products', id)).toBe(
      `datasets/crowdio-audio-products/comparisons/${id}.json`,
    );
  });
});

// Each test runs the pipeline against a real database first, and a busy machine needs more than
// the five seconds a test gets by default.
describe('a model comparison', { timeout: 20_000 }, () => {
  it('asks the answered questions again, scores them in two columns, and writes nothing to the dataset', async () => {
    const id = 'compare-classify';
    const { world, decisions } = await decidedWorld(id);
    const before = await datasetRows(id);
    const params = paramsFor(world, id);
    const { step, names } = fakeStep(world.clock);
    const report = await runComparison(params, step, world.ports);

    // The person-answered first, the newest first among them (A2 was read after B1), then the rest.
    expect(names).toEqual([
      'load',
      `q:${decisions.a2.id}`,
      `q:${decisions.a1.id}`,
      `q:${decisions.b1.id}`,
      'report',
    ]);
    // Each question was rebuilt as the live step built it: the same request, word for word.
    const [a1, b1, a2] = world.decider.calls.slice(0, 3);
    expect(world.decider.calls.slice(3)).toEqual([a2, a1, b1]);

    expect(report).toMatchObject({
      id: params.comparisonId,
      dataset: id,
      job: 'classify',
      model: 'cheap/x',
      backup: null,
      accept: 0.9,
      startedAt: params.startedAt,
      skipped: 0,
      stoppedAtBudget: false,
      columns: {
        person: { questions: 2, failed: 0, right: 1, acceptedWrongly: 1, toPerson: 0 },
        model: { questions: 1, failed: 0, right: 1, acceptedWrongly: 0, toPerson: 0 },
      },
      suggestedAccept: null,
      disagreements: [
        { subject: URLS.a2, answered: 'Headphones', sureness: 0.97, expected: 'DAC/Amp' },
      ],
    });
    expect(report.columns.person.allRight).toBeUndefined();
    // The candidate's calls, and what the decisions cost when they were made, at the same price.
    expect(report.columns.person.usd).toBeCloseTo(2 * CALL_USD, 12);
    expect(report.columns.person.currentUsd).toBeCloseTo(2 * CALL_USD, 12);
    expect(report.columns.model.usd).toBeCloseTo(CALL_USD, 12);
    expect(report.columns.model.currentUsd).toBeCloseTo(CALL_USD, 12);

    // The report is in R2, and nothing in the dataset changed.
    const kept = world.stored.get(comparisonKey(id, params.comparisonId));
    expect(JSON.parse(new TextDecoder().decode(kept))).toEqual(report);
    expect(await datasetRows(id)).toEqual(before);
  });

  it('stops before the next question once its spend reaches --max-usd', async () => {
    const id = 'compare-budget';
    const { world, decisions } = await decidedWorld(id);
    const { step, names } = fakeStep(world.clock);
    const report = await runComparison(
      paramsFor(world, id, { maxUsd: CALL_USD / 2 }),
      step,
      world.ports,
    );
    expect(names).toEqual(['load', `q:${decisions.a2.id}`, 'report']);
    expect(report.stoppedAtBudget).toBe(true);
    expect(report.columns.person.questions).toBe(1);
    expect(report.columns.model.questions).toBe(0);
    expect(report.columns.person.usd).toBeCloseTo(CALL_USD, 12);
  });

  it('asks the backup when the model fails, and sends nothing more to a provider found down', async () => {
    const id = 'compare-backup';
    const { world } = await decidedWorld(id);
    let downCalls = 0;
    const down: Decider = {
      name: 'llm:down/x',
      async decide() {
        downCalls += 1;
        throw new LlmHttpError(402, '402 Insufficient credits');
      },
    };
    world.ports.modelPorts = modelPortsOf(world, { decider: { 'down/x': down } });
    const { step } = fakeStep(world.clock);
    const report = await runComparison(
      paramsFor(world, id, { model: 'down/x', backup: 'up/y' }),
      step,
      world.ports,
    );
    expect(report).toMatchObject({
      model: 'down/x',
      backup: 'up/y',
      columns: {
        person: { questions: 2, failed: 0, right: 1 },
        model: { questions: 1, failed: 0, right: 1 },
      },
    });
    // The first question found down/x's provider down; the later ones went straight to the backup.
    expect(downCalls).toBe(1);
    // Failed calls count no tokens: only the backup's answers cost anything.
    expect(report.columns.person.usd).toBeCloseTo(2 * CALL_USD, 12);
  });

  it('counts the questions that fail on both models as failed, at no cost', async () => {
    const id = 'compare-failed';
    const { world } = await decidedWorld(id);
    const broken: Decider = {
      name: 'llm:broken/x',
      async decide() {
        throw new Error('the network dropped it');
      },
    };
    world.ports.modelPorts = modelPortsOf(world, { decider: { 'broken/x': broken } });
    const { step } = fakeStep(world.clock);
    const report = await runComparison(
      paramsFor(world, id, { model: 'broken/x' }),
      step,
      world.ports,
    );
    expect(report.columns.person).toMatchObject({ questions: 2, failed: 2, right: 0, usd: 0 });
    expect(report.columns.model).toMatchObject({ questions: 1, failed: 1, usd: 0 });
    expect(report.notes.join('\n')).toContain('the network dropped it');
  });

  it('scores a shelf placement for its shelf, and for every part', async () => {
    const id = 'compare-place';
    const { world } = await taxonomyWorld(testTaxonomyDefinition(id));
    await refresh(world, id);
    const taxonomy = testTaxonomy();
    const idOf = (subject: TaxonomySubject, slug: string) => findItem(taxonomy, subject, slug)!.id;
    const decisions = await decisionsByPage(id);
    // A person says B1 is a headphone amp, as the decider did, but not a DAC.
    const answer = {
      shelf: idOf('shelf', 'headphone-amps'),
      functions: [],
      values: [idOf('value', 'headphones')],
    };
    await finalizeDecision(db, {
      id: decisions.b1.id,
      finalAnswer: finalAnswerText({
        answer,
        asked: (decisions.b1.state as PlaceState).asked,
        given: answer,
      }),
      at: world.clock.now(),
    });
    const before = await datasetRows(id);
    const { step } = fakeStep(world.clock);
    const report = await runComparison(paramsFor(world, id), step, world.ports);

    // Each placement was asked as the live step asked it.
    const [a1, b1, a2] = world.taxonomyDecider.calls.slice(0, 3);
    expect(world.taxonomyDecider.calls.slice(3)).toEqual([b1, a2, a1]);
    expect(report.columns.person).toMatchObject({
      questions: 1,
      right: 1,
      allRight: 0,
      acceptedWrongly: 1,
    });
    expect(report.columns.model).toMatchObject({
      questions: 2,
      right: 2,
      allRight: 2,
      acceptedWrongly: 0,
    });
    expect(report.disagreements).toEqual([
      {
        subject: URLS.b1,
        answered: 'headphone-amps; functions: dac; values: headphones',
        sureness: 0.95,
        expected: 'headphone-amps; values: headphones',
      },
    ]);
    expect(await datasetRows(id)).toEqual(before);
  });

  it('skips a question whose site says ai-input=no, and counts it as skipped', async () => {
    const id = 'compare-consent';
    const { world, decisions } = await decidedWorld(id);
    // Maker A's site now says no to AI input, and the next run reads its pages under that.
    world.clock.advance(25 * HOUR);
    world.web.routes.set('https://maker-a.example/robots.txt', { status: 200, body: NO_AI_INPUT });
    await refresh(world, id);
    const asked = world.decider.calls.length;
    const { step, names } = fakeStep(world.clock);
    const report = await runComparison(paramsFor(world, id), step, world.ports);
    expect(names).toContain(`q:${decisions.a1.id}`);
    expect(report).toMatchObject({
      skipped: 2,
      columns: { person: { questions: 0 }, model: { questions: 1, right: 1 } },
    });
    // Only B1, on maker B's site, was asked.
    expect(world.decider.calls.slice(asked).map((call) => call.evidence)).toEqual([
      expect.stringContaining(URLS.b1),
    ]);
    expect(report.notes.join('\n')).toContain('AI input');
  });

  it('asks a match question again without the lineup, and scores it by its outcome', async () => {
    const id = 'compare-match';
    const { world } = await worldFor(testDefinition(id), routesWith(DT_80, DT_250));
    const live = fakeDecider(() => ({ 'spec-version': 0.97, same: 0.02 }));
    world.ports.decider = live.decider;
    await refresh(world, id);
    expect(live.calls).toHaveLength(1);
    // The candidate names another relationship, which keeps the page apart all the same.
    const candidate = fakeDecider(() => ({ 'other-model': 0.96 }));
    world.ports.decider = candidate.decider;
    const { step } = fakeStep(world.clock);
    const report = await runComparison(paramsFor(world, id, { job: 'match' }), step, world.ports);
    expect(candidate.calls).toEqual([live.calls[0]]);
    expect(report.columns.model).toMatchObject({ questions: 1, right: 1, acceptedWrongly: 0 });
    expect(report.notes.join('\n')).toContain('lineup');
  });
});
