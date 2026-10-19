import { createLlmDecider, runIdFor, sha256Hex } from '@spatula/core';
import { packs } from '@spatula/pack-products';
import {
  applyDefinition,
  decisionRecords,
  finalizeDecision,
  items,
  latestFetchId,
  listLiveItems,
  listOpenReviews,
  reviveItems,
  statements,
  writeStatements,
} from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import { fakeDecider, fakeLlm, type World } from '../test/node/fakes';
import {
  decidedDefinition as decided,
  entityOf,
  published,
  refresh,
  worldFor,
} from '../test/node/runs';
import { A1, A2, answerFor, decisionFor, ROBOTS_OPEN, standardRoutes, URLS } from '../test/pages';
import { cascadeField, CASCADE_METHODS, classifyTarget, likeliest } from './classify';
import { extractionTag, pageKey, runRefresh, type StepRunner } from './refresh';

const HOUR = 3_600_000;
const NO_AI_INPUT = 'User-agent: *\nContent-Signal: ai-input=no\nAllow: /\n';

const decisionsAbout = async (datasetId: string, itemId: string) =>
  (await db.select().from(decisionRecords).where(eq(decisionRecords.datasetId, datasetId))).filter(
    (row) => row.subject === itemId,
  );

/** When each of an item's current statements was last seen, as ISO text, by property and method. */
const seenOf = async (itemId: string) =>
  Object.fromEntries(
    (
      await db
        .select({
          property: statements.property,
          method: statements.method,
          lastSeen: statements.lastSeen,
        })
        .from(statements)
        .where(and(eq(statements.itemId, itemId), isNull(statements.withdrawnAt)))
    ).map((row) => [`${row.property}/${row.method}`, row.lastSeen.toISOString()]),
  );

/** What each of the dataset's live pages is marked with, by page address. */
const marksOf = async (datasetId: string) =>
  Object.fromEntries(
    (await listLiveItems(db, datasetId)).map((item) => [item.locator, item.extractedWith]),
  );

/** The method and value of each of an item's current category statements. */
const categoryOf = (itemId: string) =>
  db
    .select({ method: statements.method, value: statements.value })
    .from(statements)
    .where(
      and(
        eq(statements.itemId, itemId),
        eq(statements.property, 'category'),
        isNull(statements.withdrawnAt),
      ),
    );

/** A person's answer for an item's category, written beside whatever the cascade said of it. */
async function answerCategory(world: World, datasetId: string, itemId: string, value: string) {
  await writeStatements(db, {
    datasetId,
    itemId,
    fetchId: (await latestFetchId(db, itemId))!,
    seenAt: world.clock.now(),
    methods: ['human'],
    properties: ['category'],
    statements: [
      {
        property: 'category',
        value,
        valueKey: value,
        original: value,
        method: 'human',
        path: 'review:test',
        confidence: 1,
        position: null,
      },
    ],
  });
}

// Each test runs the pipeline against a real database, several runs in most, and a busy machine
// needs more than the five seconds a test gets by default.
describe('classifying pages', { timeout: 20_000 }, () => {
  it('classifies the pages its source leaves to the cascade, once, and publishes why', async () => {
    const {
      world,
      pages: [a1, a2, b1],
    } = await worldFor(decided('classify-basics'), standardRoutes());
    const first = await refresh(world, 'classify-basics');
    expect(first.names).toEqual([
      'load',
      'plan',
      'items:0',
      `fetch:${a1!.id}:0`,
      `extract:${a1!.id}`,
      `classify:${a1!.id}`,
      `fetch:${b1!.id}:0`,
      `extract:${b1!.id}`,
      `fetch:${a2!.id}:0`,
      `extract:${a2!.id}`,
      `classify:${a2!.id}`,
      'sources',
      'resolve',
      'snapshot',
      'finish',
    ]);
    expect(first.summary.classify).toEqual({
      rule: 0,
      accepted: 2,
      escalated: 0,
      reused: 0,
      skipped: 0,
      failed: 0,
      inputTokens: 1000,
      outputTokens: 40,
    });
    const file = (await published(world, 'classify-basics'))!;
    expect(file.byName.A1!.fields.category).toBe('Headphones');
    expect(file.byName.A1!.provenance.category).toMatchObject({ method: 'llm', confidence: 0.97 });
    expect(file.byName['B1 Amp']!.provenance.category).toMatchObject({ method: 'rule' });
    expect(await decisionsAbout('classify-basics', a1!.id)).toMatchObject([
      {
        type: 'classify',
        subjectKey: `classify:${a1!.id}`,
        adapter: 'llm:test-model',
        outcome: 'accepted',
        answer: 'Headphones',
        probabilities: { Headphones: 0.97 },
        thresholds: { accept: 0.9 },
        criteriaVersion: 1,
        inputTokens: 500,
        outputTokens: 20,
      },
    ]);
    // The decider read what the page says about itself, not its text.
    expect(world.decider.calls[0]!.evidence).toContain('Title: A1 | Maker A');

    // A new revision reads every page again, and the same evidence gets the same answer, unasked.
    await applyDefinition(db, decided('classify-basics', { freshness: { maxAgeDays: 6 } }));
    const second = await refresh(world, 'classify-basics');
    expect(second.summary.classify).toMatchObject({ accepted: 0, reused: 2 });
    expect(world.decider.calls).toHaveLength(2);
  });

  it('takes a page that is none of the values out of the dataset, until it is revived', async () => {
    const {
      world,
      pages: [, a2],
    } = await worldFor(decided('classify-none'), standardRoutes());
    const scripted = fakeDecider(
      (request): Record<string, number> =>
        request.evidence.includes(URLS.a2) ? { 'None of these': 0.96 } : { Headphones: 0.97 },
    );
    world.ports.decider = scripted.decider;
    const first = await refresh(world, 'classify-none');
    expect(first.summary).toMatchObject({ irrelevant: 1, classify: { accepted: 2 } });
    const [row] = await db.select({ status: items.status }).from(items).where(eq(items.id, a2!.id));
    expect(row!.status).toBe('irrelevant');
    const file = (await published(world, 'classify-none'))!;
    expect(Object.keys(file.byName).sort()).toEqual(['A1', 'B1 Amp']);

    // It isn't read again, until a person revives it; then it's asked afresh.
    const second = await refresh(world, 'classify-none');
    expect(second.names).not.toContain(`fetch:${a2!.id}:0`);
    await reviveItems(db, { datasetId: 'classify-none', pages: [a2!.locator] });
    const third = await refresh(world, 'classify-none');
    expect(third.names).toContain(`classify:${a2!.id}`);
    expect(scripted.calls).toHaveLength(3);
  });

  it('asks a person when the decider isn’t sure, and leaves the record out until then', async () => {
    const definition = decided('classify-unsure');
    const {
      world,
      pages: [a1],
    } = await worldFor(definition, standardRoutes());
    let sure = false;
    const scripted = fakeDecider(
      (request): Record<string, number> =>
        request.evidence.includes(URLS.a1) && !sure
          ? { Headphones: 0.45, 'DAC/Amp': 0.45 }
          : { Headphones: 0.97 },
    );
    world.ports.decider = scripted.decider;
    const first = await refresh(world, 'classify-unsure');
    expect(first.summary.classify).toMatchObject({ accepted: 1, escalated: 1 });
    expect(await listOpenReviews(db, 'classify-unsure')).toEqual([
      {
        id: expect.stringMatching(/^rv_/u),
        kind: 'classify',
        subject: a1!.id,
        question: {
          type: 'choice',
          prompt: 'Which category does the one product this page is about have?',
          options: ['Headphones', 'DAC/Amp', 'None of these'],
        },
        context: {
          url: URLS.a1,
          field: 'category',
          proposed: 'Headphones',
          probabilities: { Headphones: 0.45, 'DAC/Amp': 0.45 },
          reason: 'the test’s reason',
        },
        createdAt: expect.any(String),
      },
    ]);
    expect((await published(world, 'classify-unsure'))!.byName.A1).toBeUndefined();
    expect(first.summary.snapshot.excluded).toEqual([
      { canonicalId: await entityOf(a1!.id), missing: ['category'] },
    ]);

    // Read again on the same evidence, the question is the one already asked: the decider isn't
    // asked again, the page still waits, and the review stays open.
    await applyDefinition(db, decided('classify-unsure', { freshness: { maxAgeDays: 6 } }));
    const again = await refresh(world, 'classify-unsure');
    expect(again.summary.classify).toMatchObject({ escalated: 1, reused: 1, accepted: 0 });
    expect(scripted.calls).toHaveLength(2);
    expect((await listOpenReviews(db, 'classify-unsure')).map((review) => review.subject)).toEqual([
      a1!.id,
    ]);

    // New words for the values are a new question. The decider is sure of its answer to that one,
    // and the answer closes the review.
    sure = true;
    const product = definition.recordTypes.product!;
    const category = { ...product.fields.category!, description: 'Earbuds are headphones.' };
    await applyDefinition(db, {
      ...definition,
      recordTypes: { product: { ...product, fields: { ...product.fields, category } } },
    });
    const third = await refresh(world, 'classify-unsure');
    expect(third.summary.classify).toMatchObject({ accepted: 2, escalated: 0, reused: 0 });
    expect(await listOpenReviews(db, 'classify-unsure')).toEqual([]);
    expect((await published(world, 'classify-unsure'))!.byName.A1!.fields.category).toBe(
      'Headphones',
    );
  });

  it('takes a structured-data category as the answer, and asks no decider where AI input isn’t allowed', async () => {
    const routes = standardRoutes();
    routes[URLS.a1] = {
      status: 200,
      body: A1().replace('"sku":"A1-BLK"', '"sku":"A1-BLK","category":"Headphones"'),
    };
    routes['https://maker-a.example/robots.txt'] = { status: 200, body: NO_AI_INPUT };
    const {
      world,
      pages: [, a2],
    } = await worldFor(decided('classify-rule'), routes);
    const first = await refresh(world, 'classify-rule');
    expect(first.summary.classify).toMatchObject({ rule: 1, accepted: 0, escalated: 1 });
    expect(world.decider.calls).toEqual([]);
    const file = (await published(world, 'classify-rule'))!;
    expect(file.byName.A1!.provenance.category).toMatchObject({ method: 'rule', confidence: 1 });
    expect(await decisionsAbout('classify-rule', a2!.id)).toMatchObject([
      { adapter: null, outcome: 'escalated', answer: null, probabilities: {} },
    ]);
  });

  it('stops asking once the run’s LLM budget is spent, and asks the rest next run', async () => {
    const definition = decided('classify-budget');
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(
      { ...definition, budget: { ...definition.budget, llmTokensPerRun: 500 } },
      standardRoutes(),
      { llm: false },
    );
    // A1's question spends 520 tokens, so A2's waits.
    const first = await refresh(world, 'classify-budget');
    expect(first.summary.classify).toMatchObject({ accepted: 1, skipped: 1 });
    expect(first.summary.notes).toContain(
      '1 page waits for the next run: this run’s LLM budget of 500 tokens is spent',
    );
    const second = await refresh(world, 'classify-budget');
    expect(second.names).toContain(`classify:${a2!.id}`);
    expect(second.names).not.toContain(`classify:${a1!.id}`);
    expect(second.summary.classify).toMatchObject({ accepted: 1, skipped: 0 });
  });

  it('stops asking when the run’s LLM budget is spent to the token', async () => {
    const definition = decided('classify-budget-exact');
    const { world } = await worldFor(
      { ...definition, budget: { ...definition.budget, llmTokensPerRun: 520 } },
      standardRoutes(),
      { llm: false },
    );
    // A1's question spends 520 tokens, which is all of the budget, so A2's waits.
    const first = await refresh(world, 'classify-budget-exact');
    expect(first.summary.classify).toMatchObject({ accepted: 1, skipped: 1 });
    expect(world.decider.calls).toHaveLength(1);
  });

  it('counts reading and deciding against one budget, and a page that waits for both once', async () => {
    const definition = decided('classify-budget-both');
    const { world } = await worldFor(
      { ...definition, budget: { ...definition.budget, llmTokensPerRun: 2600 } },
      standardRoutes(),
    );
    // A1's reading spends 1,050 tokens and its question 520. B1's reading starts with 1,030 left,
    // and spends 1,050. A2 starts with none, so neither the LLM nor the decider is asked about it.
    // Without the question's 520, A2 would start with 500 left and be read.
    const first = await refresh(world, 'classify-budget-both');
    expect(first.summary.llm).toMatchObject({ ran: 2, skipped: 1 });
    expect(first.summary.classify).toMatchObject({ accepted: 1, skipped: 1 });
    expect(first.summary.notes).toContain(
      '1 page waits for the next run: this run’s LLM budget of 2,600 tokens is spent',
    );
    expect(world.llm.calls).toHaveLength(2);
    expect(world.decider.calls).toHaveLength(1);

    // The next run has a budget of its own: it reads A2 and asks about it.
    const second = await refresh(world, 'classify-budget-both');
    expect(second.summary.llm).toMatchObject({ ran: 1, skipped: 0 });
    expect(second.summary.classify).toMatchObject({ accepted: 1, skipped: 0 });
    expect(second.summary.notes).toEqual([]);
    expect(world.decider.calls).toHaveLength(2);
  });

  it('asks a person, not the decider, where the dataset doesn’t declare ai-input', async () => {
    const policy = { purposes: [], perHostIntervalMs: 1000 };
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(decided('classify-no-purpose', { policy }), standardRoutes());
    const first = await refresh(world, 'classify-no-purpose');
    expect(first.summary.classify).toMatchObject({ escalated: 2, accepted: 0 });
    expect(world.decider.calls).toEqual([]);
    expect(world.llm.calls).toEqual([]);
    const open = await listOpenReviews(db, 'classify-no-purpose');
    expect(open.map((review) => review.subject).sort()).toEqual([a1!.id, a2!.id].sort());

    // Read again with nothing more to ask than before, it is the same escalation, not a new one.
    await applyDefinition(
      db,
      decided('classify-no-purpose', { policy, freshness: { maxAgeDays: 6 } }),
    );
    const second = await refresh(world, 'classify-no-purpose');
    expect(second.summary.classify).toMatchObject({ escalated: 2, accepted: 0 });
    expect(await decisionsAbout('classify-no-purpose', a1!.id)).toHaveLength(1);
    expect(world.decider.calls).toEqual([]);
  });

  it('asks again when the words describing the values change', async () => {
    const definition = decided('classify-criteria');
    const { world } = await worldFor(definition, standardRoutes());
    await refresh(world, 'classify-criteria');
    expect(world.decider.calls).toHaveLength(2);

    // The description is part of what the decider is told, so a decision made without it isn't
    // reused: the evidence is the same, and the question isn't.
    const product = definition.recordTypes.product!;
    const category = {
      ...product.fields.category!,
      description: 'In-ear monitors are headphones too.',
    };
    await applyDefinition(db, {
      ...definition,
      recordTypes: { product: { ...product, fields: { ...product.fields, category } } },
    });
    const second = await refresh(world, 'classify-criteria');
    expect(second.summary.classify).toMatchObject({ accepted: 2, reused: 0 });
    expect(world.decider.calls).toHaveLength(4);
    expect(world.decider.calls[2]!.criteria).toContain('In-ear monitors are headphones too.');
  });

  it('doesn’t use the decider’s answer again once a site says ai-input=no', async () => {
    // Without LLM extraction the page's state stays the same, so the earlier decision is found,
    // and only the consent check keeps it from being used.
    const {
      world,
      pages: [a1],
    } = await worldFor(decided('classify-consent'), standardRoutes(), { llm: false });
    await refresh(world, 'classify-consent');
    world.clock.advance(25 * HOUR);
    world.web.routes.set('https://maker-a.example/robots.txt', { status: 200, body: NO_AI_INPUT });
    // A new revision marks every page's statements as older, so the next run reads them again.
    await applyDefinition(db, decided('classify-consent', { freshness: { maxAgeDays: 6 } }));
    const second = await refresh(world, 'classify-consent');
    expect(second.summary.classify).toMatchObject({ escalated: 2, reused: 0 });
    expect(world.decider.calls).toHaveLength(2);
    expect((await published(world, 'classify-consent'))!.byName.A1).toBeUndefined();
    const open = await listOpenReviews(db, 'classify-consent');
    expect(open.map((review) => review.subject)).toContain(a1!.id);

    // The site changes its mind. Those two were escalated with no decider asked, so now it is,
    // and its answers close the reviews.
    world.clock.advance(25 * HOUR);
    world.web.routes.set('https://maker-a.example/robots.txt', { status: 200, body: ROBOTS_OPEN });
    await applyDefinition(db, decided('classify-consent', { freshness: { maxAgeDays: 5 } }));
    const third = await refresh(world, 'classify-consent');
    expect(third.summary.classify).toMatchObject({ accepted: 2, escalated: 0 });
    expect(world.decider.calls).toHaveLength(4);
    expect(await listOpenReviews(db, 'classify-consent')).toEqual([]);
    expect((await published(world, 'classify-consent'))!.byName.A1!.fields.category).toBe(
      'Headphones',
    );
  });
});

describe('a page is current only once it is classified', { timeout: 20_000 }, () => {
  it('reads a page again next run when its classify step failed outside the decider', async () => {
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(decided('classify-throws'), standardRoutes());
    // The blob store goes down for A2's stored copy just as classifying it begins: extracting A2
    // reads the copy first, and classifying it reads the copy once more.
    const blobs = world.ports.blobs;
    const a2Key = pageKey(await sha256Hex(new TextEncoder().encode(A2())));
    let reads = 0;
    world.ports.blobs = {
      ...blobs,
      async get(key) {
        if (key === a2Key && (reads += 1) === 2) throw new Error('the blob store is down');
        return blobs.get(key);
      },
    };
    await expect(refresh(world, 'classify-throws', {})).rejects.toThrow('the blob store is down');
    // A1 was classified and is current. A2 was read, and isn't current until it is classified.
    expect(await marksOf('classify-throws')).toMatchObject({
      [URLS.a1]: extractionTag(1),
      [URLS.a2]: `${extractionTag(1)}.retry`,
    });

    // Nothing else is due, so A2 is read again for this alone, and classified.
    world.ports.blobs = blobs;
    world.clock.advance(5 * 60_000);
    const second = await refresh(world, 'classify-throws', {});
    expect((second.results.get('plan') as { ids: string[] }).ids).toEqual([a2!.id]);
    expect(second.names).toContain(`classify:${a2!.id}`);
    expect(second.names).not.toContain(`classify:${a1!.id}`);
    expect(second.summary.classify).toMatchObject({ accepted: 1 });
    expect(await marksOf('classify-throws')).toMatchObject({ [URLS.a2]: extractionTag(1) });
    expect((await published(world, 'classify-throws'))!.byName.A2!.fields.category).toBe(
      'Headphones',
    );
  });

  it('reads a page again when the decider failed, and classifies it then', async () => {
    const {
      world,
      pages: [a1],
    } = await worldFor(decided('classify-decider-fails'), standardRoutes());
    // The decider's message quotes what the model said, and runs past what a note may hold.
    const noisy = `overloaded \u0000 ${'x'.repeat(600)}`;
    const answers = fakeDecider(decisionFor);
    let failing = true;
    world.ports.decider = {
      name: answers.decider.name,
      async decide(request) {
        if (failing) throw new Error(noisy);
        return answers.decider.decide(request);
      },
    };
    const first = await refresh(world, 'classify-decider-fails', {});
    expect(first.summary.classify).toMatchObject({ failed: 2, accepted: 0 });
    // Workflows keep what a step returns, so the note is clean and short where it is made.
    const note = `${URLS.a1}: the decider failed: overloaded  ${'x'.repeat(600)}`.slice(0, 500);
    expect(first.summary.notes).toContain(note);
    expect(first.results.get(`classify:${a1!.id}`)).toMatchObject({ note });
    expect(await decisionsAbout('classify-decider-fails', a1!.id)).toEqual([]);
    expect(await marksOf('classify-decider-fails')).toMatchObject({
      [URLS.a1]: `${extractionTag(1)}.retry`,
      [URLS.a2]: `${extractionTag(1)}.retry`,
    });
    expect((await published(world, 'classify-decider-fails'))!.byName.A1).toBeUndefined();

    failing = false;
    const second = await refresh(world, 'classify-decider-fails', {});
    expect((second.results.get('plan') as { ids: string[] }).ids).toHaveLength(2);
    expect(second.summary.classify).toMatchObject({ accepted: 2, failed: 0 });
    expect(await marksOf('classify-decider-fails')).toMatchObject({
      [URLS.a1]: extractionTag(1),
      [URLS.a2]: extractionTag(1),
    });
    expect((await published(world, 'classify-decider-fails'))!.byName.A1!.fields.category).toBe(
      'Headphones',
    );
  });

  it('still asks the LLM again after it failed, though the page’s category was decided', async () => {
    const {
      world,
      pages: [a1],
    } = await worldFor(decided('classify-llm-retry'), standardRoutes());
    let failing = true;
    world.ports.llm = fakeLlm((user) =>
      failing && user.includes(URLS.a1) ? { specs: 'not a list' } : answerFor(user),
    ).llm;
    const first = await refresh(world, 'classify-llm-retry', {});
    expect(first.summary.llm).toMatchObject({ ran: 2, failed: 1 });
    expect(first.summary.classify).toMatchObject({ accepted: 2 });
    // A1 was classified, but its read didn't finish, so classifying it doesn't make it current.
    expect(await marksOf('classify-llm-retry')).toMatchObject({
      [URLS.a1]: `${extractionTag(1)}.retry`,
      [URLS.a2]: extractionTag(1),
    });

    failing = false;
    world.web.routes.set(URLS.a1, { status: 304 });
    const second = await refresh(world, 'classify-llm-retry', {});
    expect((second.results.get('plan') as { ids: string[] }).ids).toEqual([a1!.id]);
    expect(second.summary.llm).toMatchObject({ ran: 1, failed: 0 });
    expect(await marksOf('classify-llm-retry')).toMatchObject({ [URLS.a1]: extractionTag(1) });
    expect((await published(world, 'classify-llm-retry'))!.byName.A1!.fields).toMatchObject({
      category: 'Headphones',
      specs: [
        { label: 'Impedance', value: '300 Ω' },
        { label: 'Weight', value: '350 g' },
      ],
    });
  });

  it('classifies nothing on a page that couldn’t be read, and classifies it once it can be', async () => {
    const {
      world,
      pages: [a1],
    } = await worldFor(decided('classify-unread'), standardRoutes());
    const real = packs['products/product']!;
    world.ports.packs = {
      ...packs,
      'products/product': {
        ...real,
        extract(page) {
          if (page.url === URLS.a1) throw new Error('boom');
          return real.extract(page);
        },
      },
    };
    const first = await refresh(world, 'classify-unread', {});
    expect(first.summary.notes).toContain(`${URLS.a1}: the page couldn’t be read: boom`);
    expect(first.names).not.toContain(`classify:${a1!.id}`);
    expect(first.summary.classify).toMatchObject({ accepted: 1 });

    world.ports.packs = packs;
    const second = await refresh(world, 'classify-unread', {});
    expect(second.names).toContain(`classify:${a1!.id}`);
    expect(await marksOf('classify-unread')).toMatchObject({ [URLS.a1]: extractionTag(1) });
  });
});

describe('a site that no longer allows AI input', { timeout: 20_000 }, () => {
  it('takes back a decider’s answer on a page that was current, without a new revision', async () => {
    const {
      world,
      pages: [a1, a2, b1],
    } = await worldFor(decided('classify-consent-now'), standardRoutes(), { llm: false });
    await refresh(world, 'classify-consent-now');
    world.clock.advance(25 * HOUR);
    world.web.routes.set('https://maker-a.example/robots.txt', { status: 200, body: NO_AI_INPUT });
    // The pages are current and say what they said. Only what the site now says puts them off.
    const second = await refresh(world, 'classify-consent-now');
    expect(second.names).toContain(`classify:${a1!.id}`);
    expect(second.names).toContain(`classify:${a2!.id}`);
    // B1 is maker-b's, whose robots.txt still allows it, and its category is fixed.
    expect(second.names).not.toContain(`extract:${b1!.id}`);
    expect(second.summary.classify).toMatchObject({ escalated: 2, reused: 0 });
    expect(world.decider.calls).toHaveLength(2);
    const file = (await published(world, 'classify-consent-now'))!;
    expect(file.byName.A1).toBeUndefined();
    expect(file.byName['B1 Amp']).toBeDefined();
    const open = await listOpenReviews(db, 'classify-consent-now');
    expect(open.map((review) => review.subject).sort()).toEqual([a1!.id, a2!.id].sort());

    // That happens once: the escalated pages are current, and the site's answer doesn't put them off.
    const third = await refresh(world, 'classify-consent-now');
    expect(third.names).not.toContain(`extract:${a1!.id}`);
    expect(third.names).not.toContain(`classify:${a1!.id}`);
    expect(world.decider.calls).toHaveLength(2);
  });

  it('keeps a category a rule or a person gave, since neither read the page with AI', async () => {
    const routes = standardRoutes();
    routes[URLS.a1] = {
      status: 200,
      body: A1().replace('"sku":"A1-BLK"', '"sku":"A1-BLK","category":"Headphones"'),
    };
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(decided('classify-consent-kept'), routes, { llm: false });
    await refresh(world, 'classify-consent-kept');
    // A person decides A2: the decider's answer goes, and the person's takes its place.
    await writeStatements(db, {
      datasetId: 'classify-consent-kept',
      itemId: a2!.id,
      fetchId: (await latestFetchId(db, a2!.id))!,
      seenAt: world.clock.now(),
      methods: CASCADE_METHODS,
      properties: ['category'],
      statements: [],
    });
    await answerCategory(world, 'classify-consent-kept', a2!.id, 'DAC/Amp');

    world.clock.advance(25 * HOUR);
    world.web.routes.set('https://maker-a.example/robots.txt', { status: 200, body: NO_AI_INPUT });
    const second = await refresh(world, 'classify-consent-kept');
    expect(second.names).not.toContain(`extract:${a1!.id}`);
    expect(second.names).not.toContain(`extract:${a2!.id}`);
    const file = (await published(world, 'classify-consent-kept'))!;
    expect(file.byName.A1!.provenance.category).toMatchObject({ method: 'rule' });
    expect(file.byName.A2!.provenance.category).toMatchObject({ method: 'human' });
  });
});

describe('an earlier decision about the same evidence', { timeout: 20_000 }, () => {
  it('asks the decider about a page that was escalated before one could be asked', async () => {
    const {
      world,
      pages: [a1],
    } = await worldFor(decided('classify-late-decider'), standardRoutes(), { decider: false });
    const first = await refresh(world, 'classify-late-decider');
    expect(first.summary.classify).toMatchObject({ escalated: 2, accepted: 0 });
    expect(await listOpenReviews(db, 'classify-late-decider')).toHaveLength(2);

    // Read again with no decider yet, it is the same escalation, not a new decision.
    await applyDefinition(db, decided('classify-late-decider', { freshness: { maxAgeDays: 5 } }));
    const again = await refresh(world, 'classify-late-decider');
    expect(again.summary.classify).toMatchObject({ escalated: 2, accepted: 0 });
    expect(await decisionsAbout('classify-late-decider', a1!.id)).toHaveLength(1);

    // The decider is set up, and a new revision has every page read again.
    world.ports.decider = world.decider.decider;
    await applyDefinition(db, decided('classify-late-decider', { freshness: { maxAgeDays: 6 } }));
    const second = await refresh(world, 'classify-late-decider');
    expect(second.summary.classify).toMatchObject({ accepted: 2, escalated: 0, reused: 0 });
    expect(world.decider.calls).toHaveLength(2);
    expect(await listOpenReviews(db, 'classify-late-decider')).toEqual([]);
    const file = (await published(world, 'classify-late-decider'))!;
    expect(file.byName.A1!.fields.category).toBe('Headphones');
    expect(file.byName.A2!.fields.category).toBe('Headphones');
  });

  it('asks again about an escalation the decider gave no answer to', async () => {
    const {
      world,
      pages: [a1],
    } = await worldFor(decided('classify-off-schema'), standardRoutes());
    // A model's answer that doesn't fit the schema comes back as no probabilities at all.
    let fitting = false;
    const model = fakeLlm(() =>
      fitting
        ? { probabilities: [{ option: 'Headphones', probability: 0.97 }], reason: 'ok' }
        : null,
    );
    world.ports.decider = createLlmDecider(model.llm);
    const first = await refresh(world, 'classify-off-schema');
    expect(first.summary.classify).toMatchObject({ escalated: 2, accepted: 0 });
    expect(await decisionsAbout('classify-off-schema', a1!.id)).toMatchObject([
      { adapter: 'llm:test-model', outcome: 'escalated', answer: null, probabilities: {} },
    ]);

    // Read again, the decider is asked the same question, and this time it answers.
    fitting = true;
    await applyDefinition(db, decided('classify-off-schema', { freshness: { maxAgeDays: 6 } }));
    const second = await refresh(world, 'classify-off-schema');
    expect(second.summary.classify).toMatchObject({ accepted: 2, escalated: 0, reused: 0 });
    expect(model.calls).toHaveLength(4);
    expect(await listOpenReviews(db, 'classify-off-schema')).toEqual([]);
    expect((await published(world, 'classify-off-schema'))!.byName.A1!.fields.category).toBe(
      'Headphones',
    );
  });

  it('asks again about an answer that no longer reaches the threshold', async () => {
    const { world } = await worldFor(decided('classify-threshold'), standardRoutes());
    const unsure = fakeDecider((): Record<string, number> => ({ Headphones: 0.92 }));
    world.ports.decider = unsure.decider;
    const first = await refresh(world, 'classify-threshold');
    expect(first.summary.classify).toMatchObject({ accepted: 2 });

    // An answer as sure as the threshold asks is still enough.
    await applyDefinition(
      db,
      decided('classify-threshold', { decisions: { classify: { accept: 0.92 } } }),
    );
    const second = await refresh(world, 'classify-threshold');
    expect(second.summary.classify).toMatchObject({ reused: 2, escalated: 0, accepted: 0 });
    expect(unsure.calls).toHaveLength(2);

    // 0.92 was enough under 0.9, and a new revision asks for 0.95. The decider is as sure as it was,
    // which is no longer enough.
    await applyDefinition(
      db,
      decided('classify-threshold', { decisions: { classify: { accept: 0.95 } } }),
    );
    const third = await refresh(world, 'classify-threshold');
    expect(third.summary.classify).toMatchObject({ escalated: 2, accepted: 0, reused: 0 });
    expect(unsure.calls).toHaveLength(4);
    expect(await listOpenReviews(db, 'classify-threshold')).toHaveLength(2);
    expect((await published(world, 'classify-threshold'))!.byName.A1).toBeUndefined();
  });

  it('keeps a person’s answer to a question, though a decider can be asked now', async () => {
    const {
      world,
      pages: [a1],
    } = await worldFor(decided('classify-answered'), standardRoutes(), { decider: false });
    await refresh(world, 'classify-answered');
    // A person answers A1's question, and the decision records the answer.
    const [asked] = await decisionsAbout('classify-answered', a1!.id);
    await finalizeDecision(db, { id: asked!.id, finalAnswer: 'DAC/Amp', at: world.clock.now() });

    world.ports.decider = world.decider.decider;
    await applyDefinition(db, decided('classify-answered', { freshness: { maxAgeDays: 6 } }));
    const second = await refresh(world, 'classify-answered');
    expect(second.summary.classify).toMatchObject({ reused: 1, accepted: 1, escalated: 0 });
    // Only A2 is asked.
    expect(world.decider.calls.map((call) => call.evidence.includes(URLS.a2))).toEqual([true]);
    const file = (await published(world, 'classify-answered'))!;
    expect(file.byName.A1!.fields.category).toBe('DAC/Amp');
    expect(file.byName.A1!.provenance.category).toMatchObject({ method: 'human', confidence: 1 });
    expect(file.byName.A2!.fields.category).toBe('Headphones');
  });
});

describe('the classify step', { timeout: 20_000 }, () => {
  it('reports the decision it made when it runs again, and counts it once', async () => {
    const { world } = await worldFor(decided('classify-replayed'), standardRoutes());
    const runId = runIdFor('classify-replayed', world.clock.now());
    // Each classify step runs twice, as Workflows runs a step again after a crash.
    const ran = new Set<string>();
    const replaying: StepRunner = {
      async do(name, fn) {
        if (name.startsWith('classify:') && !ran.has(name)) {
          ran.add(name);
          await fn();
        }
        return JSON.parse(JSON.stringify((await fn()) ?? null)) as never;
      },
      async sleep(_name, ms) {
        world.clock.advance(ms);
      },
    };
    const summary = await runRefresh(
      { runId, datasetId: 'classify-replayed' },
      replaying,
      world.ports,
    );
    expect(world.decider.calls).toHaveLength(2);
    expect(summary.classify).toEqual({
      rule: 0,
      accepted: 2,
      escalated: 0,
      reused: 0,
      skipped: 0,
      failed: 0,
      inputTokens: 1000,
      outputTokens: 40,
    });
  });

  it('keeps the category statements it wrote when a page is read again, by the page or the LLM', async () => {
    const routes = standardRoutes();
    routes[URLS.a1] = {
      status: 200,
      body: A1().replace('"sku":"A1-BLK"', '"sku":"A1-BLK","category":"Headphones"'),
    };
    const {
      world,
      pages: [a1, a2],
    } = await worldFor(decided('classify-keeps'), routes);
    await refresh(world, 'classify-keeps');
    const category = async (itemId: string) => {
      const rows = await db
        .select()
        .from(statements)
        .where(and(eq(statements.itemId, itemId), eq(statements.property, 'category')));
      expect(rows).toHaveLength(1);
      return rows[0]!;
    };
    // A1's category is a rule's answer, and A2's is the decider's.
    const [ruled, decider] = [await category(a1!.id), await category(a2!.id)];
    expect(ruled).toMatchObject({ method: 'rule', value: 'Headphones', withdrawnAt: null });
    expect(decider).toMatchObject({ method: 'llm', value: 'Headphones', withdrawnAt: null });
    expect(decider.path).toMatch(/^decision:dc_/u);

    // A statement is never rewritten. A new revision has the page extracted again, and its
    // extraction doesn't withdraw the cascade's answers; classifying again on the same evidence
    // sees the same statements again.
    await applyDefinition(db, decided('classify-keeps', { freshness: { maxAgeDays: 6 } }));
    const second = await refresh(world, 'classify-keeps');
    expect(second.summary.classify).toMatchObject({ reused: 2, rule: 0, accepted: 0 });
    for (const [item, before] of [
      [a1!, ruled],
      [a2!, decider],
    ] as const) {
      const after = await category(item.id);
      expect(after).toMatchObject({ id: before.id, withdrawnAt: null });
      expect(after.lastSeen.getTime()).toBeGreaterThan(before.lastSeen.getTime());
    }

    // The same when the LLM reads A2 again, because its text changed and its specs didn't.
    const asked = world.llm.calls.length;
    world.web.routes.set(URLS.a2, {
      status: 200,
      body: A2().replace('<h1>A2</h1>', '<h1>A2</h1><p>New colorway</p>'),
    });
    await refresh(world, 'classify-keeps');
    expect(world.llm.calls.length).toBe(asked + 1);
    expect((await category(a2!.id)).id).toBe(decider.id);
    // A1's rule never asked a decider, and A2 was asked once.
    expect(world.decider.calls).toHaveLength(1);
  });

  it('withdraws what the LLM said for a field it no longer fills, and keeps the category', async () => {
    const definition = decided('classify-llm-field-off');
    const product = definition.recordTypes.product!;
    const withExtras = (llm: boolean) => ({
      ...definition,
      recordTypes: {
        product: {
          ...product,
          fields: { ...product.fields, extras: { ...product.fields.specs!, llm } },
        },
      },
    });
    const {
      world,
      pages: [a1, , b1],
    } = await worldFor(withExtras(true), standardRoutes());
    // The LLM says the same of a page in both of its fields.
    world.ports.llm = fakeLlm((user) => {
      const given = answerFor(user);
      return given === null ? null : { ...given, extras: given.specs };
    }).llm;
    const llmSaid = async (itemId: string) => [
      ...new Set(
        (
          await db
            .select({ property: statements.property })
            .from(statements)
            .where(
              and(
                eq(statements.itemId, itemId),
                eq(statements.method, 'llm'),
                isNull(statements.withdrawnAt),
              ),
            )
        ).map((row) => row.property),
      ),
    ];
    await refresh(world, 'classify-llm-field-off');
    expect((await llmSaid(a1!.id)).sort()).toEqual(['category', 'extras', 'specs']);
    expect((await llmSaid(b1!.id)).sort()).toEqual(['extras', 'specs']);

    // A new revision stops asking the LLM for extras. What it said of them is withdrawn, from a page
    // the cascade classifies and from one it doesn't, and the category the decider gave stays.
    await applyDefinition(db, withExtras(false));
    const second = await refresh(world, 'classify-llm-field-off');
    expect(second.summary.llm).toMatchObject({ ran: 3 });
    expect((await llmSaid(a1!.id)).sort()).toEqual(['category', 'specs']);
    expect((await llmSaid(b1!.id)).sort()).toEqual(['specs']);
  });

  it('leaves the category alone when the LLM’s answer is reused and classifying then fails', async () => {
    const definition = decided('classify-reuse-fails');
    const {
      world,
      pages: [a1],
    } = await worldFor(definition, standardRoutes());
    await refresh(world, 'classify-reuse-fails');
    const before = await seenOf(a1!.id);

    // New words for the values are a new question, and the decider is down. A1 is read again from
    // its stored copy and the LLM's question is the same, so its answer is reused and seen again.
    // The category isn't the LLM's to see again: nothing has confirmed it.
    world.ports.decider = {
      name: 'llm:test-model',
      async decide() {
        throw new Error('the decider is down');
      },
    };
    const product = definition.recordTypes.product!;
    const category = { ...product.fields.category!, description: 'Earbuds are headphones.' };
    await applyDefinition(db, {
      ...definition,
      recordTypes: { product: { ...product, fields: { ...product.fields, category } } },
    });
    const second = await refresh(world, 'classify-reuse-fails');
    expect(second.summary).toMatchObject({ llm: { reused: 3 }, classify: { failed: 2 } });
    const after = await seenOf(a1!.id);
    expect(after['specs/llm']).not.toBe(before['specs/llm']);
    expect(after['category/llm']).toBe(before['category/llm']);
  });

  it('leaves a person’s category alone, whatever the decider would be asked now', async () => {
    const definition = decided('classify-human');
    const {
      world,
      pages: [a1],
    } = await worldFor(definition, standardRoutes());
    await refresh(world, 'classify-human');
    // A person's answer is written while the decider's, which it replaces, is still current.
    await answerCategory(world, 'classify-human', a1!.id, 'DAC/Amp');

    // New words for the values are a new question for the decider, so A2 is asked again. A1 isn't:
    // the person's answer stands until a person changes it, and the decider's would be hidden by
    // it. Reading A1 again withdraws the decider's answer, which the person's has replaced.
    const product = definition.recordTypes.product!;
    const category = { ...product.fields.category!, description: 'Speakers are not headphones.' };
    await applyDefinition(db, {
      ...definition,
      recordTypes: { product: { ...product, fields: { ...product.fields, category } } },
    });
    const second = await refresh(world, 'classify-human');
    expect(second.summary.classify).toMatchObject({ reused: 1, accepted: 1 });
    const askedAbout = (url: string) =>
      world.decider.calls.filter((call) => call.evidence.includes(url)).length;
    expect(askedAbout(URLS.a1)).toBe(1);
    expect(askedAbout(URLS.a2)).toBe(2);
    expect(await categoryOf(a1!.id)).toEqual([{ method: 'human', value: 'DAC/Amp' }]);
    const file = (await published(world, 'classify-human'))!;
    expect(file.byName.A1!.fields.category).toBe('DAC/Amp');
    expect(file.byName.A1!.provenance.category).toMatchObject({ method: 'human', confidence: 1 });
    expect(file.byName.A2!.fields.category).toBe('Headphones');
  });

  it('withdraws a rule’s category too, when a person has answered', async () => {
    const routes = standardRoutes();
    routes[URLS.a1] = {
      status: 200,
      body: A1().replace('"sku":"A1-BLK"', '"sku":"A1-BLK","category":"Headphones"'),
    };
    const {
      world,
      pages: [a1],
    } = await worldFor(decided('classify-human-rule'), routes);
    await refresh(world, 'classify-human-rule');
    expect(await categoryOf(a1!.id)).toEqual([{ method: 'rule', value: 'Headphones' }]);

    // A person's answer is written while the rule's, which it replaces, is still current.
    await answerCategory(world, 'classify-human-rule', a1!.id, 'DAC/Amp');
    await applyDefinition(db, decided('classify-human-rule', { freshness: { maxAgeDays: 6 } }));
    await refresh(world, 'classify-human-rule');
    expect(await categoryOf(a1!.id)).toEqual([{ method: 'human', value: 'DAC/Amp' }]);
  });
});

describe('what the cascade classifies', () => {
  const definition = decided('classify-target');
  const recordType = definition.recordTypes.product!;
  const [makerA, makerB] = definition.sources;

  it('is the decided field, where the source leaves it to the cascade', () => {
    expect(cascadeField(makerA!, recordType)).toEqual(['category', recordType.fields.category]);
    // Maker B fixes the category, and a source may read it with a rule of its own.
    expect(cascadeField(makerB!, recordType)).toBeNull();
    const reads = { ...makerA!, extract: { category: { css: '.category' } } };
    expect(cascadeField(reads, recordType)).toBeNull();
    // A record type that decides no field has nothing to leave.
    const plain = testDefinition('classify-plain');
    expect(cascadeField(plain.sources[0]!, plain.recordTypes.product!)).toBeNull();
  });

  it('is named for a page by its source and record type', async () => {
    await applyDefinition(db, definition);
    const [a1, , b1] = await listLiveItems(db, 'classify-target');
    expect(classifyTarget(definition, a1!)).toEqual({
      name: 'category',
      field: recordType.fields.category,
      recordType,
    });
    expect(classifyTarget(definition, b1!)).toBeNull();
    // A page whose source or record type left the definition has nothing to classify.
    expect(classifyTarget(definition, { ...a1!, sourceId: 'maker-z' })).toBeNull();
    expect(classifyTarget(definition, { ...a1!, recordType: 'cable' })).toBeNull();
  });

  it('names the likeliest answer, and on a tie the option offered first', () => {
    const options = ['Headphones', 'DAC/Amp', 'None of these'];
    expect(likeliest({}, options)).toBeNull();
    expect(likeliest({ Headphones: 0.6, 'DAC/Amp': 0.3 }, options)).toBe('Headphones');
    expect(likeliest({ Headphones: 0.2, 'DAC/Amp': 0.7 }, options)).toBe('DAC/Amp');
    // Postgres hands an object's keys back shortest first, so a tie can't go to the key met first.
    expect(likeliest({ 'DAC/Amp': 0.45, Headphones: 0.45 }, options)).toBe('Headphones');
    expect(likeliest({ Headphones: 0.45, 'DAC/Amp': 0.45 }, options)).toBe('Headphones');
    expect(likeliest({ 'None of these': 0.4, 'DAC/Amp': 0.4 }, options)).toBe('DAC/Amp');
    // An answer the question doesn't offer is not one to propose, and an option is a key of its own.
    expect(likeliest({ Speakers: 0.9 }, options)).toBeNull();
    expect(likeliest({ Headphones: 0.5 }, ['constructor', 'Headphones'])).toBe('Headphones');
  });
});
