import {
  answerText,
  findItem,
  NONE_SHELF,
  parseDefinition,
  runIdFor,
  type Definition,
  type TaxonomyDecider,
  type TaxonomyRequest,
  type TaxonomySubject,
} from '@spatula/core';
import {
  applyDefinition,
  decisionRecords,
  items,
  latestFetchId,
  listLiveItems,
  listOpenReviews,
  statements,
  writeStatements,
} from '@spatula/store';
import { testTaxonomy, testTaxonomyDefinition } from '@spatula/store/fixtures';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import { fakeTaxonomyDecider, modelPortsOf, type World } from '../test/node/fakes';
import { refresh, taxonomyWorld, worldFor } from '../test/node/runs';
import {
  A1,
  B1,
  ROBOTS_OPEN,
  standardRoutes,
  taxonomyFor,
  URLS,
  type SlugChances,
} from '../test/pages';
import { LlmHttpError } from './llm-openai';
import { extractionTag, retryTag } from './pipeline';
import { runRefresh, type StepRunner } from './refresh';
import { keyHash, placeSubject } from './taxonomy';

const T = testTaxonomy();
const id = (subject: TaxonomySubject, slug: string) => findItem(T, subject, slug)!.id;
const SUBJECTS = { shelf: 'shelf', functions: 'function', features: 'value' } as const;
const HOUR = 3_600_000;
const NO_AI_INPUT = 'User-agent: *\nContent-Signal: ai-input=no\nAllow: /\n';
const ROBOTS = {
  a: 'https://maker-a.example/robots.txt',
  b: 'https://maker-b.example/robots.txt',
} as const;

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

/** The definition with these top-level parts changed. */
function redefine(definition: Definition, changes: Record<string, unknown>): Definition {
  const parsed = parseDefinition({ ...definition, ...changes });
  if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
  return parsed.definition;
}

/** The test dataset with a source's shelf fixed by a rule. */
function withShelfRule(definition: Definition, sourceId: string, shelf: string): Definition {
  return redefine(definition, {
    sources: definition.sources.map((source) =>
      source.id === sourceId ? { ...source, fixed: { ...source.fixed, shelf } } : source,
    ),
  });
}

/** How many decisions there are about placing a page, current or not. */
const placeDecisionsOf = async (itemId: string) =>
  (
    await db
      .select({ id: decisionRecords.id })
      .from(decisionRecords)
      .where(eq(decisionRecords.subjectKey, placeSubject(itemId)))
  ).length;

/** A person's shelf for a page, written as an answer writes it. */
async function personSays(world: World, datasetId: string, itemId: string, shelf: string) {
  await writeStatements(db, {
    datasetId,
    itemId,
    fetchId: (await latestFetchId(db, itemId))!,
    seenAt: world.clock.now(),
    methods: ['human'],
    properties: ['shelf'],
    statements: [
      {
        property: 'shelf',
        value: shelf,
        valueKey: shelf,
        original: shelf,
        method: 'human',
        path: 'review:test',
        confidence: 1,
        position: null,
      },
    ],
  });
}

// Each test runs the pipeline against a real database, several runs in most.
describe('placing pages in the taxonomy', { timeout: 20_000 }, () => {
  it('places each page on a shelf with its functions and features, and doesn’t ask again', async () => {
    const {
      world,
      pages: [a1, a2, b1],
    } = await taxonomyWorld(testTaxonomyDefinition('place-basics'));
    const first = await refresh(world, 'place-basics');
    expect(first.names.slice(0, 4)).toEqual(['load', 'taxonomy', 'plan', 'items:0']);
    expect(first.names.filter((name) => /^(?:extract|decide):/u.test(name))).toEqual([
      `extract:${a1!.id}`,
      `decide:${a1!.id}`,
      `extract:${b1!.id}`,
      `decide:${b1!.id}`,
      `extract:${a2!.id}`,
      `decide:${a2!.id}`,
    ]);
    expect(first.summary.classify).toEqual({
      rule: 0,
      accepted: 3,
      escalated: 0,
      reused: 0,
      skipped: 0,
      failed: 0,
      inputTokens: 1800,
      outputTokens: 120,
    });
    // The functions a shelf implies aren't stated: B1's amplifier, the headphones' headphones.
    expect(await placedOf(a1!.id)).toEqual(['features llm open 0.95', 'shelf llm over-ear 0.96']);
    expect(await placedOf(a2!.id)).toEqual(['features llm closed 0.94', 'shelf llm on-ear 0.95']);
    expect(await placedOf(b1!.id)).toEqual([
      'features llm headphones 0.95',
      'functions llm dac 0.95',
      'shelf llm headphone-amps 0.97',
    ]);
    const [decision] = await db
      .select()
      .from(decisionRecords)
      .where(eq(decisionRecords.subjectKey, placeSubject(b1!.id)));
    expect(decision).toMatchObject({
      type: 'taxonomy',
      subject: b1!.id,
      adapter: 'llm:test-model',
      outcome: 'accepted',
      answer: answerText({
        shelf: id('shelf', 'headphone-amps'),
        functions: [id('function', 'dac')],
        values: [id('value', 'headphones')],
      }),
      question: { type: 'taxonomy', parts: { shelves: [], functions: [], features: {} } },
    });
    expect(await keyOf(b1!.id)).toBe(await keyHash(T, id('shelf', 'headphone-amps')));
    expect(Object.values(await marks('place-basics'))).toEqual([
      extractionTag(1),
      extractionTag(1),
      extractionTag(1),
    ]);

    // A1 is read again, its state unchanged: its place stands, and nothing is asked.
    world.web.routes.set(URLS.a1, { status: 200, body: A1('two') });
    const second = await refresh(world, 'place-basics');
    expect(second.summary.classify).toMatchObject({ reused: 1, accepted: 0, inputTokens: 0 });
    expect(world.taxonomyDecider.calls).toHaveLength(3);
    expect(await placedOf(a1!.id)).toEqual(['features llm open 0.95', 'shelf llm over-ear 0.96']);
  });

  it('asks a person only the parts the decider isn’t sure of, and publishes the rest', async () => {
    const {
      world,
      pages: [, a2],
    } = await taxonomyWorld(testTaxonomyDefinition('place-unsure'));
    world.ports.taxonomyDecider = fakeTaxonomyDecider((request) =>
      request.evidence.includes(URLS.a2)
        ? {
            shelves: { 'on-ear': 0.95 },
            functions: { headphones: 0.99, 'pre-amp': 0.5 },
            values: { open: 0.6, closed: 0.35 },
          }
        : taxonomyFor(request),
    ).decider;
    const run = await refresh(world, 'place-unsure');
    expect(run.summary.classify).toMatchObject({ accepted: 2, escalated: 1 });
    expect(await placedOf(a2!.id)).toEqual(['shelf llm on-ear 0.95']);
    const reviews = await listOpenReviews(db, 'place-unsure');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      kind: 'classify',
      subject: a2!.id,
      question: {
        type: 'taxonomy',
        parts: {
          shelves: [],
          functions: [id('function', 'pre-amp')],
          features: { [id('feature', 'back')]: [id('value', 'open'), id('value', 'closed')] },
        },
      },
      context: {
        url: URLS.a2,
        field: 'taxonomy',
        version: 1,
        settled: { shelf: id('shelf', 'on-ear'), functions: [], values: [] },
        proposed: {
          shelf: id('shelf', 'on-ear'),
          functions: [id('function', 'pre-amp')],
          values: [id('value', 'open')],
        },
      },
    });
  });

  it('puts a page on its category when the subcategories add up, and asks which one', async () => {
    const {
      world,
      pages: [, , b1],
    } = await taxonomyWorld(testTaxonomyDefinition('place-fallback'));
    world.ports.taxonomyDecider = fakeTaxonomyDecider((request) =>
      request.evidence.includes(URLS.b1)
        ? {
            shelves: { 'headphone-amps': 0.6, 'power-amps': 0.35 },
            functions: { amplifier: 0.97 },
            values: { headphones: 0.95 },
          }
        : taxonomyFor(request),
    ).decider;
    await refresh(world, 'place-fallback');
    // Amplifiers implies nothing, so B1's amplifier is stated; the family's probabilities add up.
    expect(await placedOf(b1!.id)).toEqual([
      'features llm headphones 0.95',
      'functions llm amplifier 0.97',
      'shelf llm amplifiers 0.95',
    ]);
    const [review] = await listOpenReviews(db, 'place-fallback');
    expect(review!.question).toEqual({
      type: 'taxonomy',
      prompt: 'Where does the one product this page is about sit in the taxonomy?',
      parts: {
        shelves: ['amplifiers', 'headphone-amps', 'preamps', 'power-amps'].map((slug) =>
          id('shelf', slug),
        ),
        functions: [],
        features: {},
      },
    });
  });

  it('settles the shelf a rule names, and leaves a person’s shelf to them', async () => {
    const definition = withShelfRule(
      testTaxonomyDefinition('place-rules'),
      'maker-b',
      'headphone-amps',
    );
    const {
      world,
      pages: [a1, , b1],
    } = await taxonomyWorld(definition);
    await refresh(world, 'place-rules');
    const asked = world.taxonomyDecider.calls.find((request) =>
      request.evidence.includes(URLS.b1),
    )!;
    expect(asked.parts.shelves).toEqual([]);
    expect(asked.shelf).toBe(id('shelf', 'headphone-amps'));
    expect(await placedOf(b1!.id)).toEqual([
      'features llm headphones 0.95',
      'functions llm dac 0.95',
      'shelf rule headphone-amps 1',
    ]);

    // A person puts A1 on On-ear. When A1 is read again, the cascade's shelf is withdrawn, the
    // person's stands, and the decider isn't asked: the earlier probabilities are read under it.
    await personSays(world, 'place-rules', a1!.id, id('shelf', 'on-ear'));
    world.web.routes.set(URLS.a1, { status: 200, body: A1('two') });
    await refresh(world, 'place-rules');
    expect(world.taxonomyDecider.calls).toHaveLength(3);
    expect(await placedOf(a1!.id)).toEqual(['features llm open 0.95', 'shelf human on-ear 1']);
  });

  it('asks a person the shelf alone when no decider can be asked, and takes a rule’s answer', async () => {
    const definition = withShelfRule(
      testTaxonomyDefinition('place-alone'),
      'maker-b',
      'headphone-amps',
    );
    const {
      world,
      pages: [a1, a2, b1],
    } = await taxonomyWorld(definition, standardRoutes(), { taxonomyDecider: false });
    const run = await refresh(world, 'place-alone');
    expect(run.summary.classify).toMatchObject({ rule: 1, escalated: 2, inputTokens: 0 });
    expect(await placedOf(a1!.id)).toEqual([]);
    expect(await placedOf(b1!.id)).toEqual(['shelf rule headphone-amps 1']);
    const reviews = await listOpenReviews(db, 'place-alone');
    expect(reviews.map((review) => review.subject).sort()).toEqual([a1!.id, a2!.id].sort());
    expect(reviews[0]!.question).toMatchObject({ parts: { functions: [], features: {} } });
  });

  it('keeps a page’s shelf, functions, and features when the page is read again', async () => {
    const definition = withShelfRule(
      testTaxonomyDefinition('place-kept'),
      'maker-b',
      'headphone-amps',
    );
    const {
      world,
      pages: [a1, , b1],
    } = await taxonomyWorld(definition);
    await refresh(world, 'place-kept');
    const before = { a1: await placedOf(a1!.id), b1: await placedOf(b1!.id) };
    expect(before.b1).toContain('shelf rule headphone-amps 1');
    // Both pages change, so both are read again: A1's text, so the LLM is asked anew, and B1's
    // heading, which a rule reads as its name. The decider fails, so nothing places them anew:
    // whatever is withdrawn now, the page's write or the LLM's withdrew.
    world.web.routes.set(URLS.a1, {
      status: 200,
      body: A1('two')
        .replace('<title>A1 | Maker A</title>', '<title>A1 (2026) | Maker A</title>')
        .replace('Weight: 350 g', 'Weight: 355 g'),
    });
    world.web.routes.set(URLS.b1, { status: 200, body: B1('<h1>B1 Amp II</h1>') });
    world.ports.taxonomyDecider = {
      name: 'llm:test-model',
      async decide() {
        throw new Error('the model is down');
      },
    };
    const second = await refresh(world, 'place-kept');
    expect(second.summary.llm.ran).toBe(2);
    expect(second.summary.classify).toMatchObject({ failed: 2 });
    expect(await placedOf(a1!.id)).toEqual(before.a1);
    expect(await placedOf(b1!.id)).toEqual(before.b1);
  });

  it('takes a page out on a sure "None of these"', async () => {
    const {
      world,
      pages: [, a2],
    } = await taxonomyWorld(testTaxonomyDefinition('place-none'));
    world.ports.taxonomyDecider = fakeTaxonomyDecider((request) =>
      request.evidence.includes(URLS.a2) ? { shelves: { none: 0.95 } } : taxonomyFor(request),
    ).decider;
    const run = await refresh(world, 'place-none');
    expect(run.summary.irrelevant).toBe(1);
    expect(await placedOf(a2!.id)).toEqual([]);
    expect((await listLiveItems(db, 'place-none')).map((item) => item.id)).not.toContain(a2!.id);
    expect(await keyOf(a2!.id)).toBe(await keyHash(T, null));
    expect(await listOpenReviews(db, 'place-none')).toEqual([]);
  });

  it('waits to place pages until the dataset has a taxonomy', async () => {
    const { world } = await worldFor(testTaxonomyDefinition('place-unseeded'), standardRoutes());
    const run = await refresh(world, 'place-unseeded');
    expect(run.names).toContain('taxonomy');
    expect(run.names.some((name) => name.startsWith('decide:'))).toBe(false);
    expect(run.summary.notes).toContain(
      'place-unseeded has no taxonomy yet, so its pages wait to be placed: seed one with pnpm spatula taxonomy seed',
    );
    // Not current, so the run after the seed places them.
    expect(Object.values(await marks('place-unseeded'))).toEqual([
      retryTag(1),
      retryTag(1),
      retryTag(1),
    ]);
  });
});

describe('placing pages with AI input only where it’s allowed', { timeout: 20_000 }, () => {
  it('asks a person, not the decider, where the dataset doesn’t declare ai-input', async () => {
    const policy = { purposes: [], perHostIntervalMs: 1000 };
    const definition = redefine(testTaxonomyDefinition('place-no-purpose'), { policy });
    const {
      world,
      pages: [a1, a2, b1],
    } = await taxonomyWorld(definition);
    const first = await refresh(world, 'place-no-purpose');
    expect(first.summary.classify).toMatchObject({ escalated: 3, accepted: 0, inputTokens: 0 });
    expect(world.taxonomyDecider.calls).toEqual([]);
    expect(world.llm.calls).toEqual([]);
    for (const page of [a1!, a2!, b1!]) expect(await placedOf(page.id)).toEqual([]);
    // Each page's shelf is a person's to choose, among every shelf and none.
    const open = await listOpenReviews(db, 'place-no-purpose');
    expect(open.map((review) => review.subject).sort()).toEqual([a1!.id, a2!.id, b1!.id].sort());
    const shelves = [
      ...['headphones', 'over-ear', 'on-ear', 'dacs', 'amplifiers', 'headphone-amps'],
      ...['preamps', 'power-amps'],
    ].map((slug) => id('shelf', slug));
    for (const review of open) {
      expect(review.question).toEqual({
        type: 'taxonomy',
        prompt: 'Where does the one product this page is about sit in the taxonomy?',
        parts: { shelves: [...shelves, NONE_SHELF], functions: [], features: {} },
      });
    }

    // Read again with nothing more to ask than before, it is the same escalation, not a new one.
    await applyDefinition(db, redefine(definition, { freshness: { maxAgeDays: 6 } }));
    const second = await refresh(world, 'place-no-purpose');
    expect(second.names).toContain(`decide:${a1!.id}`);
    expect(second.summary.classify).toMatchObject({ escalated: 3, accepted: 0 });
    expect(await placeDecisionsOf(a1!.id)).toBe(1);
    expect(world.taxonomyDecider.calls).toEqual([]);
  });

  it('takes back the decider’s parts once a site says ai-input=no, and keeps a rule’s shelf', async () => {
    // Without LLM extraction, a page read unchanged is current, so only the decider's statements
    // put it off, and only the consent check keeps its earlier decision from being used again.
    const definition = withShelfRule(
      testTaxonomyDefinition('place-consent'),
      'maker-b',
      'headphone-amps',
    );
    const {
      world,
      pages: [a1, a2, b1],
    } = await taxonomyWorld(definition, standardRoutes(), { llm: false });
    await refresh(world, 'place-consent');
    const before = {
      a1: await placedOf(a1!.id),
      a2: await placedOf(a2!.id),
      b1: await placedOf(b1!.id),
    };
    expect(before.a1).toEqual(['features llm open 0.95', 'shelf llm over-ear 0.96']);
    expect(before.b1).toEqual([
      'features llm headphones 0.95',
      'functions llm dac 0.95',
      'shelf rule headphone-amps 1',
    ]);
    expect(world.taxonomyDecider.calls).toHaveLength(3);

    // Both sites now refuse AI input. The pages are current and say what they said: only what
    // their sites now say puts them off, with no new revision.
    world.clock.advance(25 * HOUR);
    world.web.routes.set(ROBOTS.a, { status: 200, body: NO_AI_INPUT });
    world.web.routes.set(ROBOTS.b, { status: 200, body: NO_AI_INPUT });
    const second = await refresh(world, 'place-consent');
    for (const page of [a1!, a2!, b1!]) expect(second.names).toContain(`decide:${page.id}`);
    expect(second.summary.classify).toMatchObject({
      escalated: 2,
      rule: 1,
      reused: 0,
      inputTokens: 0,
    });
    expect(world.taxonomyDecider.calls).toHaveLength(3);
    expect(await placedOf(a1!.id)).toEqual([]);
    expect(await placedOf(a2!.id)).toEqual([]);
    expect(await placedOf(b1!.id)).toEqual(['shelf rule headphone-amps 1']);
    const open = await listOpenReviews(db, 'place-consent');
    expect(open.map((review) => review.subject).sort()).toEqual([a1!.id, a2!.id].sort());

    // That happens once: the pages are current now, and the sites' answers don't put them off.
    const third = await refresh(world, 'place-consent');
    expect(third.names.filter((name) => /^(?:extract|decide):/u.test(name))).toEqual([]);
    expect(world.taxonomyDecider.calls).toHaveLength(3);

    // The sites change their minds. Nothing was weighed without a decider, so once the pages are
    // read again, it's asked, and its answers close the questions.
    world.clock.advance(25 * HOUR);
    world.web.routes.set(ROBOTS.a, { status: 200, body: ROBOTS_OPEN });
    world.web.routes.set(ROBOTS.b, standardRoutes()[ROBOTS.b]!);
    await applyDefinition(db, redefine(definition, { freshness: { maxAgeDays: 6 } }));
    const fourth = await refresh(world, 'place-consent');
    expect(fourth.summary.classify).toMatchObject({ accepted: 3, escalated: 0 });
    expect(world.taxonomyDecider.calls).toHaveLength(6);
    expect(await listOpenReviews(db, 'place-consent')).toEqual([]);
    expect({
      a1: await placedOf(a1!.id),
      a2: await placedOf(a2!.id),
      b1: await placedOf(b1!.id),
    }).toEqual(before);
  });
});

/** A fake taxonomy decider that answers as the model named, so its decisions record `llm:<model>`. */
const named = (model: string, answer: (request: TaxonomyRequest) => SlugChances | null) => {
  const fake = fakeTaxonomyDecider(answer);
  return { ...fake, decider: { ...fake.decider, name: `llm:${model}` } };
};

/** A taxonomy decider that throws what a provider's failed call throws. */
const failing = (model: string, error: Error): TaxonomyDecider & { calls: number } => {
  const decider = {
    name: `llm:${model}`,
    calls: 0,
    async decide(): Promise<never> {
      decider.calls += 1;
      throw error;
    },
  };
  return decider;
};

/** The world's answer with each option it likes at one chance, and each other at 0.01. */
const allAt =
  (chance: number) =>
  (request: TaxonomyRequest): SlugChances => {
    const at = (chances: Record<string, number> = {}) =>
      Object.fromEntries(
        Object.entries(chances).map(([slug, p]) => [slug, p > 0.5 ? chance : 0.01]),
      );
    const given = taxonomyFor(request);
    return {
      shelves: at(given.shelves),
      functions: at(given.functions),
      values: at(given.values),
    };
  };

/** The answer for B1 when the page is B1, and the world's at 0.99 for any other. */
const forB1 = (answer: (request: TaxonomyRequest) => SlugChances) => (request: TaxonomyRequest) =>
  request.evidence.includes(URLS.b1) ? answer(request) : allAt(0.99)(request);

describe('placing through steps (ADR 0010)', { timeout: 20_000 }, () => {
  it('asks the next step when the first leaves a part open, and takes that step’s answer whole', async () => {
    const datasetId = 'place-steps';
    const {
      world,
      pages: [, , b1],
    } = await taxonomyWorld(
      redefine(testTaxonomyDefinition(datasetId), {
        models: { classify: [{ model: 'cheap/x', accept: 0.96 }, 'strong/y'] },
      }),
    );
    // The cheap model is sure B1 is a headphone amp, and unsure it's a DAC; the strong one is sure
    // of everything, on another shelf.
    const cheap = named(
      'cheap/x',
      forB1((request) => {
        const sure = allAt(0.99)(request);
        return { ...sure, functions: { ...sure.functions, dac: 0.5 } };
      }),
    );
    const strong = named(
      'strong/y',
      forB1(() => ({
        shelves: { 'power-amps': 0.99 },
        functions: { dac: 0.99 },
        values: { speakers: 0.99 },
      })),
    );
    world.ports.modelPorts = modelPortsOf(world, {
      taxonomyDecider: { 'cheap/x': cheap.decider, 'strong/y': strong.decider },
    });
    const run = await refresh(world, datasetId);
    expect(run.summary.classify).toMatchObject({
      accepted: 3,
      escalated: 0,
      failed: 0,
      inputTokens: 2400,
      outputTokens: 160,
    });
    // Only B1 had a part left open, so only B1 asked the strong model.
    expect(cheap.calls).toHaveLength(3);
    expect(strong.calls).toHaveLength(1);
    expect(strong.calls[0]!.evidence).toContain(URLS.b1);
    const [decision] = await db
      .select()
      .from(decisionRecords)
      .where(eq(decisionRecords.subjectKey, placeSubject(b1!.id)));
    expect(decision).toMatchObject({
      adapter: 'llm:strong/y',
      outcome: 'accepted',
      answer: answerText({
        shelf: id('shelf', 'power-amps'),
        functions: [id('function', 'dac')],
        values: [id('value', 'speakers')],
      }),
      thresholds: { accept: 0.9 },
      inputTokens: 1200,
      outputTokens: 80,
    });
    // The cheap model's sure shelf isn't kept: the strong model's answer is taken whole.
    expect(await placedOf(b1!.id)).toEqual([
      'features llm speakers 0.99',
      'functions llm dac 0.99',
      'shelf llm power-amps 0.99',
    ]);
    expect(run.summary.spend?.classify?.['cheap/x']).toMatchObject({ calls: 3, failed: 0 });
    expect(run.summary.spend?.classify?.['strong/y']).toMatchObject({
      calls: 1,
      failed: 0,
      inputTokens: 600,
      outputTokens: 40,
    });
  });

  it('asks the backup when the model fails, and marks its provider down for the run', async () => {
    const datasetId = 'place-step-backup';
    const {
      world,
      pages: [, , b1],
    } = await taxonomyWorld(
      redefine(testTaxonomyDefinition(datasetId), {
        models: { classify: [{ model: 'down/x', backup: 'up/y' }] },
      }),
    );
    const down = failing('down/x', new LlmHttpError(401, '401 invalid x-api-key'));
    const up = named('up/y', taxonomyFor);
    world.ports.modelPorts = modelPortsOf(world, {
      taxonomyDecider: { 'down/x': down, 'up/y': up.decider },
    });
    const run = await refresh(world, datasetId);
    expect(run.summary.classify).toMatchObject({ accepted: 3, failed: 0 });
    const [decision] = await db
      .select()
      .from(decisionRecords)
      .where(eq(decisionRecords.subjectKey, placeSubject(b1!.id)));
    expect(decision).toMatchObject({ adapter: 'llm:up/y', thresholds: { accept: 0.9 } });
    expect(await placedOf(b1!.id)).toEqual([
      'features llm headphones 0.95',
      'functions llm dac 0.95',
      'shelf llm headphone-amps 0.97',
    ]);
    // The first page found the provider down; the others sent it nothing.
    expect(down.calls).toBe(1);
    expect(up.calls).toHaveLength(3);
    expect(run.summary.llm.down?.down?.reason).toBe('the key was refused');
    expect(run.summary.spend?.classify?.['down/x']).toMatchObject({ calls: 3, failed: 3 });
    expect(run.summary.spend?.classify?.['up/y']).toMatchObject({ calls: 3, failed: 0 });
  });

  it('asks a person only what every step weighed', async () => {
    const datasetId = 'place-step-weighed';
    const {
      world,
      pages: [, , b1],
    } = await taxonomyWorld(
      redefine(testTaxonomyDefinition(datasetId), {
        models: { classify: ['cheap/x', 'strong/y'] },
      }),
    );
    // Both models are unsure whether B1 is a DAC, and the strong one is down at first.
    const unsure = forB1((request) => {
      const sure = allAt(0.99)(request);
      return { ...sure, functions: { ...sure.functions, dac: 0.6 } };
    });
    const cheap = named('cheap/x', unsure);
    const strong = named('strong/y', unsure);
    const strongFails = failing('strong/y', new LlmHttpError(503, '503 overloaded'));
    let strongDown = true;
    world.ports.modelPorts = modelPortsOf(world, {
      taxonomyDecider: {
        'cheap/x': cheap.decider,
        'strong/y': {
          name: 'llm:strong/y',
          decide: (request) =>
            strongDown ? strongFails.decide(request) : strong.decider.decide(request),
        },
      },
    });
    const first = await refresh(world, datasetId);
    // The strong model couldn't weigh B1, so no person is asked: the page is read again.
    expect(first.summary.classify).toMatchObject({ accepted: 2, escalated: 0, failed: 1 });
    expect(await listOpenReviews(db, datasetId)).toEqual([]);
    expect(await placeDecisionsOf(b1!.id)).toBe(0);
    expect(first.summary.notes).toContainEqual(
      expect.stringContaining(`${URLS.b1}: the decider failed: strong/y: 503 overloaded`),
    );
    expect((await marks(datasetId))[URLS.b1]).toBe(retryTag(1));
    // B1's failed step still counts the cheap model's answer, and the strong model's failed call.
    expect(first.summary.spend?.classify?.['cheap/x']).toMatchObject({ calls: 3, failed: 0 });
    expect(first.summary.spend?.classify?.['strong/y']).toMatchObject({
      calls: 1,
      failed: 1,
      inputTokens: 0,
    });

    // The strong model is back next run: it weighs B1, and a person is asked what it isn't sure of.
    strongDown = false;
    const second = await refresh(world, datasetId);
    expect(second.names).toContain(`decide:${b1!.id}`);
    expect(second.summary.classify).toMatchObject({ escalated: 1, failed: 0 });
    const reviews = await listOpenReviews(db, datasetId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      subject: b1!.id,
      question: { parts: { shelves: [], functions: [id('function', 'dac')], features: {} } },
    });
    const [decision] = await db
      .select()
      .from(decisionRecords)
      .where(eq(decisionRecords.subjectKey, placeSubject(b1!.id)));
    expect(decision).toMatchObject({ outcome: 'escalated', adapter: 'llm:strong/y' });
  });

  it('applies an answer again under the threshold of the step that gave it', async () => {
    const datasetId = 'place-step-threshold';
    const definition = (accept: number, maxAgeDays?: number) =>
      redefine(testTaxonomyDefinition(datasetId), {
        models: { classify: [{ model: 'cheap/x', accept }] },
        ...(maxAgeDays === undefined ? {} : { freshness: { maxAgeDays } }),
      });
    const {
      world,
      pages: [a1, a2, b1],
    } = await taxonomyWorld(definition(0.96));
    const cheap = named('cheap/x', allAt(0.97));
    world.ports.modelPorts = modelPortsOf(world, { taxonomyDecider: { 'cheap/x': cheap.decider } });
    const first = await refresh(world, datasetId);
    expect(first.summary.classify).toMatchObject({ accepted: 3, escalated: 0 });
    const settled = [
      'features llm headphones 0.97',
      'functions llm dac 0.97',
      'shelf llm headphone-amps 0.97',
    ];
    expect(await placedOf(b1!.id)).toEqual(settled);
    const [decision] = await db
      .select()
      .from(decisionRecords)
      .where(eq(decisionRecords.subjectKey, placeSubject(b1!.id)));
    expect(decision).toMatchObject({ adapter: 'llm:cheap/x', thresholds: { accept: 0.96 } });

    // The pages are read again, unchanged: the decisions apply again, and stay settled.
    await applyDefinition(db, definition(0.96, 6));
    const second = await refresh(world, datasetId);
    expect(second.summary.classify).toMatchObject({ reused: 3, escalated: 0, accepted: 0 });
    expect(cheap.calls).toHaveLength(3);
    expect(await placedOf(b1!.id)).toEqual(settled);
    expect(await listOpenReviews(db, datasetId)).toEqual([]);

    // The step now asks for more than its answers gave: what they settled at 0.97 is open again,
    // as a person's question, and the model isn't asked again.
    await applyDefinition(db, definition(0.98, 6));
    const third = await refresh(world, datasetId);
    expect(third.summary.classify).toMatchObject({ escalated: 3, reused: 0, accepted: 0 });
    expect(cheap.calls).toHaveLength(3);
    expect(await placedOf(b1!.id)).toEqual([]);
    const reviews = await listOpenReviews(db, datasetId);
    expect(reviews.map((review) => review.subject).sort()).toEqual([a1!.id, a2!.id, b1!.id].sort());
    expect(reviews.find((review) => review.subject === b1!.id)!.question).toMatchObject({
      parts: {
        shelves: expect.arrayContaining([id('shelf', 'headphone-amps')]),
        functions: [id('function', 'dac'), id('function', 'amplifier')],
        features: { [id('feature', 'drives')]: [id('value', 'headphones')] },
      },
    });
  });

  it('reports the placement it made when its step runs again, and counts its spend once', async () => {
    const datasetId = 'place-replayed';
    const { world } = await taxonomyWorld(testTaxonomyDefinition(datasetId));
    const runId = runIdFor(datasetId, world.clock.now());
    // Each decide step runs twice, as Workflows runs a step again after a crash.
    const ran = new Set<string>();
    const replaying: StepRunner = {
      async do(name, fn) {
        if (name.startsWith('decide:') && !ran.has(name)) {
          ran.add(name);
          await fn();
        }
        return JSON.parse(JSON.stringify((await fn()) ?? null)) as never;
      },
      async sleep(_name, ms) {
        world.clock.advance(ms);
      },
    };
    const summary = await runRefresh({ runId, datasetId, all: true }, replaying, world.ports);
    expect(world.taxonomyDecider.calls).toHaveLength(3);
    expect(summary.classify).toEqual({
      rule: 0,
      accepted: 3,
      escalated: 0,
      reused: 0,
      skipped: 0,
      failed: 0,
      inputTokens: 1800,
      outputTokens: 120,
    });
    // The replayed steps charge the saved decisions to the model that answered.
    expect(summary.spend?.classify?.['test-model']).toMatchObject({
      calls: 3,
      failed: 0,
      inputTokens: 1800,
      outputTokens: 120,
    });
  });
});

/** What each of the dataset's live pages is marked with, by page address. */
async function marks(datasetId: string): Promise<Record<string, string | null>> {
  return Object.fromEntries(
    (await listLiveItems(db, datasetId)).map((item) => [item.locator, item.extractedWith]),
  );
}
