import {
  answerText,
  findItem,
  NONE_SHELF,
  parseDefinition,
  type Definition,
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
import { fakeTaxonomyDecider, type World } from '../test/node/fakes';
import { refresh, taxonomyWorld, worldFor } from '../test/node/runs';
import { A1, B1, ROBOTS_OPEN, standardRoutes, taxonomyFor, URLS } from '../test/pages';
import { extractionTag, retryTag } from './pipeline';
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

/** What each of the dataset's live pages is marked with, by page address. */
async function marks(datasetId: string): Promise<Record<string, string | null>> {
  return Object.fromEntries(
    (await listLiveItems(db, datasetId)).map((item) => [item.locator, item.extractedWith]),
  );
}
