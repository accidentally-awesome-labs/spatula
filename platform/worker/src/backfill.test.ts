import {
  applyChanges,
  findItem,
  newId,
  NONE_OF_THESE,
  NONE_SHELF,
  parseDefinition,
  runIdFor,
  type Taxonomy,
  type TaxonomyChange,
  type TaxonomySubject,
} from '@spatula/core';
import {
  captures,
  commitTaxonomy,
  currentTaxonomy,
  datasets,
  finalizeDecision,
  getDataset,
  getRun,
  items,
  listLiveItems,
  listOpenReviews,
  saveDecision,
  setItemStatus,
  setTaxonomyKey,
  sources,
  statements,
} from '@spatula/store';
import { testTaxonomy, testTaxonomyDefinition } from '@spatula/store/fixtures';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import { fakeTaxonomyDecider, modelPortsOf, type World } from '../test/node/fakes';
import {
  decidedDefinition,
  fetchOf,
  published,
  refresh,
  taxonomyWorld,
  worldFor,
} from '../test/node/runs';
import { standardRoutes, taxonomyFor, URLS } from '../test/pages';
import { LlmHttpError } from './llm-openai';
import { keyHash } from './taxonomy';

const T = testTaxonomy();
const id = (subject: TaxonomySubject, slug: string) => findItem(T, subject, slug)!.id;
const SUBJECTS = { shelf: 'shelf', functions: 'function', features: 'value' } as const;
const DAY = 24 * 60 * 60 * 1000;

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

/** When each of an item's current taxonomy statements was last seen, in ms. */
async function seenOf(itemId: string): Promise<number[]> {
  const rows = await db
    .select({ property: statements.property, lastSeen: statements.lastSeen })
    .from(statements)
    .where(and(eq(statements.itemId, itemId), isNull(statements.withdrawnAt)));
  return rows.filter((row) => row.property in SUBJECTS).map((row) => row.lastSeen.getTime());
}

const keyOf = async (itemId: string) =>
  (await db.select({ key: items.taxonomyKey }).from(items).where(eq(items.id, itemId)))[0]!.key;

const statusOf = async (itemId: string) =>
  (await db.select({ status: items.status }).from(items).where(eq(items.id, itemId)))[0]!.status;

const markOf = async (itemId: string) =>
  (await db.select({ mark: items.extractedWith }).from(items).where(eq(items.id, itemId)))[0]!.mark;

/** A subcategory under Amplifiers: it changes B1's question, and no headphone's. */
const PHONO_STAGES: TaxonomyChange = {
  kind: 'add-subcategory',
  parent: 'amplifiers',
  slug: 'phono-stages',
  name: 'Phono stages',
  description: 'Raise and equalize a turntable cartridge’s signal',
  implies: [],
  scopeClause: 'amplifiers',
};

/** A new category: it changes the question a page on no shelf, or on none, was asked. */
const SPEAKERS: TaxonomyChange = {
  kind: 'add-category',
  slug: 'speakers',
  name: 'Speakers',
  description: 'Loudspeakers',
  implies: [],
  scopeClause: 'speakers',
};

/** Commits changes as the owner, as the dataset's next taxonomy version, and returns it. */
async function commitChange(
  world: World,
  datasetId: string,
  changes: TaxonomyChange[],
): Promise<Taxonomy> {
  const current = (await currentTaxonomy(db, datasetId))!;
  const next = applyChanges(current.taxonomy, changes, () => newId('tx'));
  if (!next.ok) throw new Error(next.issues.join('\n'));
  expect(
    await commitTaxonomy(db, {
      datasetId,
      base: current.version,
      taxonomy: next.taxonomy,
      changes: next.applied,
      actor: { role: 'owner', client: 'cli' },
      at: world.clock.now(),
    }),
  ).toEqual({ committed: true, version: current.version + 1 });
  return next.taxonomy;
}

/** A person's "None of these" about a page, as a classification kept it before the taxonomy. */
async function personSaidNone(world: World, datasetId: string, itemId: string) {
  const decision = await saveDecision(db, {
    id: `dc_none_${itemId}`,
    datasetId,
    type: 'classify',
    subject: itemId,
    subjectKey: `classify:${itemId}`,
    state: {},
    stateHash: 'hash',
    question: { type: 'choice', prompt: 'Which?', options: ['Headphones', NONE_OF_THESE] },
    criteriaVersion: 1,
    adapter: null,
    probabilities: {},
    evidence: 'A person’s answer.',
    thresholds: { accept: 0.9 },
    outcome: 'escalated',
    answer: null,
    inputTokens: 0,
    outputTokens: 0,
    decidedAt: world.clock.now(),
  });
  await finalizeDecision(db, {
    id: decision.id,
    finalAnswer: NONE_OF_THESE,
    at: world.clock.now(),
  });
  await setItemStatus(db, itemId, 'irrelevant');
}

// Each test runs the pipeline against a real database, several runs in each.
describe('backfilling from the archive', { timeout: 20_000 }, () => {
  it('decides a page again from its capture when a change touches its question, with no request', async () => {
    const {
      world,
      pages: [, , b1],
    } = await taxonomyWorld(testTaxonomyDefinition('backfill-key'));
    const first = await refresh(world, 'backfill-key');
    expect(first.summary.backfill).toEqual({ due: 0, decided: 0, fetch: 0, waiting: 0 });
    const read = await fetchOf(first.runId, URLS.b1);
    const v2 = await commitChange(world, 'backfill-key', [PHONO_STAGES]);

    const before = world.web.requests.length;
    const second = await refresh(world, 'backfill-key', {});
    expect(world.web.requests.length).toBe(before);
    expect(second.names.filter((name) => name.startsWith('backfill:'))).toEqual([
      'backfill:plan',
      'backfill:items:0',
      `backfill:${b1!.id}`,
    ]);
    expect(second.summary.backfill).toEqual({ due: 1, decided: 1, fetch: 0, waiting: 0 });
    expect(second.summary.classify).toMatchObject({ accepted: 1, inputTokens: 600 });
    // Asked again under version 2, the decider places B1 where it was.
    expect(world.taxonomyDecider.calls).toHaveLength(4);
    expect(world.taxonomyDecider.calls[3]!.taxonomy.version).toBe(2);
    expect(await placedOf(b1!.id)).toEqual([
      'features llm headphones 0.95',
      'functions llm dac 0.95',
      'shelf llm headphone-amps 0.97',
    ]);
    expect(await keyOf(b1!.id)).toBe(await keyHash(v2, id('shelf', 'headphone-amps')));
    // Its statements count as seen at the fetch that captured the page.
    expect(await seenOf(b1!.id)).toEqual([
      read.startedAt.getTime(),
      read.startedAt.getTime(),
      read.startedAt.getTime(),
    ]);
  });

  it('counts a backfilled page’s calls in the run’s spend, and the providers it found down', async () => {
    const parsed = parseDefinition({
      ...testTaxonomyDefinition('backfill-spend'),
      models: { classify: [{ model: 'down/x', backup: 'up/y' }] },
    });
    if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
    const {
      world,
      pages: [, , b1],
    } = await taxonomyWorld(parsed.definition);
    await refresh(world, 'backfill-spend');
    await commitChange(world, 'backfill-spend', [PHONO_STAGES]);
    // The step's model now refuses its key, and its backup answers.
    const up = fakeTaxonomyDecider(taxonomyFor);
    world.ports.modelPorts = modelPortsOf(world, {
      taxonomyDecider: {
        'down/x': {
          name: 'llm:down/x',
          async decide() {
            throw new LlmHttpError(401, '401 invalid x-api-key');
          },
        },
        'up/y': { ...up.decider, name: 'llm:up/y' },
      },
    });

    const second = await refresh(world, 'backfill-spend', {});
    expect(second.names).toContain(`backfill:${b1!.id}`);
    expect(second.summary.backfill).toEqual({ due: 1, decided: 1, fetch: 0, waiting: 0 });
    expect(up.calls).toHaveLength(1);
    expect(second.summary.spend?.classify).toEqual({
      'down/x': { calls: 1, failed: 1, inputTokens: 0, outputTokens: 0, usd: 0 },
      'up/y': { calls: 1, failed: 0, inputTokens: 600, outputTokens: 40, usd: 0.00064 },
    });
    expect(second.summary.llm.down?.down?.reason).toBe('the key was refused');
  });

  it('marks a page with no capture to be fetched, and the next run fetches and decides it', async () => {
    const {
      world,
      pages: [, , b1],
    } = await taxonomyWorld(testTaxonomyDefinition('backfill-fetch'));
    await refresh(world, 'backfill-fetch');
    const v2 = await commitChange(world, 'backfill-fetch', [PHONO_STAGES]);
    // B1's captures are gone, as a purge leaves a page.
    await db.delete(captures).where(eq(captures.itemId, b1!.id));

    const second = await refresh(world, 'backfill-fetch', {});
    expect(second.summary.backfill).toEqual({ due: 1, decided: 0, fetch: 1, waiting: 0 });
    expect(world.taxonomyDecider.calls).toHaveLength(3);
    expect(await markOf(b1!.id)).toBeNull();

    const third = await refresh(world, 'backfill-fetch', {});
    expect(third.names).toContain(`fetch:${b1!.id}:0`);
    expect(third.names).toContain(`decide:${b1!.id}`);
    expect(third.summary.backfill).toEqual({ due: 0, decided: 0, fetch: 0, waiting: 0 });
    expect(await keyOf(b1!.id)).toBe(await keyHash(v2, id('shelf', 'headphone-amps')));
  });

  it('brings back a page the decider took out, when deciding it again finds it a shelf', async () => {
    const {
      world,
      pages: [, a2],
    } = await taxonomyWorld(testTaxonomyDefinition('backfill-back'));
    world.ports.taxonomyDecider = fakeTaxonomyDecider((request) =>
      request.evidence.includes(URLS.a2) ? { shelves: { none: 0.95 } } : taxonomyFor(request),
    ).decider;
    const first = await refresh(world, 'backfill-back');
    expect(first.summary.irrelevant).toBe(1);

    // A new category changes the question a page on none was asked, and the decider now finds A2
    // a closed on-ear headphone.
    const v2 = await commitChange(world, 'backfill-back', [SPEAKERS]);
    world.ports.taxonomyDecider = world.taxonomyDecider.decider;
    const second = await refresh(world, 'backfill-back', {});
    expect(second.summary.backfill).toEqual({ due: 1, decided: 1, fetch: 0, waiting: 0 });
    expect(second.summary.irrelevant).toBeUndefined();
    expect((await listLiveItems(db, 'backfill-back')).map((item) => item.id)).toContain(a2!.id);
    expect(await placedOf(a2!.id)).toEqual(['features llm closed 0.94', 'shelf llm on-ear 0.95']);
    expect(await keyOf(a2!.id)).toBe(await keyHash(v2, id('shelf', 'on-ear')));
  });

  it('only backfills in a backfill run: no discovery, probe, plan, request, or verdict', async () => {
    const {
      world,
      pages: [, , b1],
    } = await taxonomyWorld(testTaxonomyDefinition('backfill-only'));
    await refresh(world, 'backfill-only');
    await commitChange(world, 'backfill-only', [PHONO_STAGES]);
    // maker-a is refused, and a week on every page is due: a backfill run still reads none.
    await db
      .update(sources)
      .set({ refusedAt: world.clock.now() })
      .where(and(eq(sources.datasetId, 'backfill-only'), eq(sources.id, 'maker-a')));
    world.clock.advance(8 * DAY);

    const before = world.web.requests.length;
    const run = await refresh(world, 'backfill-only', { backfill: true });
    expect(world.web.requests.length).toBe(before);
    expect(run.names.slice(0, 6)).toEqual([
      'load',
      'taxonomy',
      'backfill:plan',
      'backfill:items:0',
      `backfill:${b1!.id}`,
      'resolve',
    ]);
    expect(run.names.slice(-3)).toEqual(['captures', 'taxonomy:review', 'finish']);
    expect(run.names).not.toContain('plan');
    expect(run.names).not.toContain('sources');
    expect(run.names.some((name) => /^(?:probe|fetch|reread):/u.test(name))).toBe(false);
    expect(run.summary).toMatchObject({
      items: 0,
      backfill: { due: 1, decided: 1, fetch: 0, waiting: 0 },
    });
    expect(run.summary.live).toBeUndefined();
    expect(run.summary.due).toBeUndefined();
    expect(run.summary.sources).toBeUndefined();
  });

  it('reopens a person’s "None of these" that a change touches, when no capture shows the page', async () => {
    const {
      world,
      pages: [, a2],
    } = await taxonomyWorld(testTaxonomyDefinition('backfill-person'));
    await refresh(world, 'backfill-person');
    // A person took A2 out under version 1, and its captures are gone since.
    await personSaidNone(world, 'backfill-person', a2!.id);
    await setTaxonomyKey(db, a2!.id, await keyHash(T, null));
    await db.delete(captures).where(eq(captures.itemId, a2!.id));
    const v2 = await commitChange(world, 'backfill-person', [SPEAKERS]);

    const second = await refresh(world, 'backfill-person', {});
    expect(second.summary.backfill).toEqual({ due: 1, decided: 1, fetch: 0, waiting: 0 });
    expect(second.summary.classify).toMatchObject({ escalated: 1, inputTokens: 0 });
    expect(world.taxonomyDecider.calls).toHaveLength(3);
    const reviews = await listOpenReviews(db, 'backfill-person');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      subject: a2!.id,
      context: { earlier: { shelf: NONE_SHELF, functions: [], values: [] } },
    });
    // It stays out until the person answers, and isn't marked to be fetched.
    expect((await listLiveItems(db, 'backfill-person')).map((item) => item.id)).not.toContain(
      a2!.id,
    );
    expect(await placedOf(a2!.id)).toEqual([]);
    expect(await keyOf(a2!.id)).toBe(await keyHash(v2, null));
  });

  it('decides again within the run’s LLM budget, and leaves the rest for the next run', async () => {
    const {
      world,
      pages: [a1, a2],
    } = await taxonomyWorld(testTaxonomyDefinition('backfill-budget'));
    await refresh(world, 'backfill-budget');
    // A function's description is in every shelved page's question.
    await commitChange(world, 'backfill-budget', [
      {
        kind: 'describe',
        subject: 'function',
        item: 'dac',
        description: 'Turns a digital signal into an analog one',
      },
    ]);
    // Room for two of the decider's answers, at 640 tokens each. The budget is lowered without a
    // new revision, so no page is due and only the backfill asks.
    const { definition } = (await getDataset(db, 'backfill-budget'))!;
    await db
      .update(datasets)
      .set({
        definition: { ...definition, budget: { ...definition.budget, llmUsdPerRun: 0.001 } },
      })
      .where(eq(datasets.id, 'backfill-budget'));

    const second = await refresh(world, 'backfill-budget', {});
    expect(second.summary.backfill).toEqual({ due: 3, decided: 2, fetch: 0, waiting: 1 });
    expect(second.names.filter((name) => name.startsWith('backfill:'))).toEqual([
      'backfill:plan',
      'backfill:items:0',
      `backfill:${a1!.id}`,
      `backfill:${a2!.id}`,
    ]);
    expect(second.summary.classify).toMatchObject({ accepted: 2, inputTokens: 1200 });
    // The next run has a budget of its own for the last.
    const third = await refresh(world, 'backfill-budget', {});
    expect(third.summary.backfill).toEqual({ due: 1, decided: 1, fetch: 0, waiting: 0 });
  });
  it('takes only the pages the run’s item budget has left, and leaves the rest for the next run', async () => {
    const {
      world,
      pages: [a1, a2, b1],
    } = await taxonomyWorld(testTaxonomyDefinition('backfill-items'));
    await refresh(world, 'backfill-items');
    await commitChange(world, 'backfill-items', [
      {
        kind: 'describe',
        subject: 'function',
        item: 'dac',
        description: 'Turns a digital signal into an analog one',
      },
    ]);
    // Room for two pages a run. The budget is lowered without a new revision, so no page is due and
    // only the backfill reads.
    const { definition } = (await getDataset(db, 'backfill-items'))!;
    await db
      .update(datasets)
      .set({ definition: { ...definition, budget: { ...definition.budget, itemsPerRun: 2 } } })
      .where(eq(datasets.id, 'backfill-items'));

    const second = await refresh(world, 'backfill-items', {});
    expect(second.summary.backfill).toEqual({ due: 3, decided: 2, fetch: 0, waiting: 1 });
    expect(second.names.filter((name) => name.startsWith('backfill:'))).toEqual([
      'backfill:plan',
      'backfill:items:0',
      `backfill:${a1!.id}`,
      `backfill:${a2!.id}`,
    ]);
    const third = await refresh(world, 'backfill-items', {});
    expect(third.summary.backfill).toEqual({ due: 1, decided: 1, fetch: 0, waiting: 0 });
    expect(await keyOf(b1!.id)).toBe(
      await keyHash(
        (await currentTaxonomy(db, 'backfill-items'))!.taxonomy,
        id('shelf', 'headphone-amps'),
      ),
    );
  });

  it('doesn’t count a page that was out and stays out, and counts one it takes out', async () => {
    const {
      world,
      pages: [a1, a2, b1],
    } = await taxonomyWorld(testTaxonomyDefinition('backfill-count'));
    const none = (request: Parameters<typeof taxonomyFor>[0]) =>
      request.evidence.includes(URLS.a1) || request.evidence.includes(URLS.a2)
        ? { shelves: { none: 0.95 } }
        : taxonomyFor(request);
    world.ports.taxonomyDecider = fakeTaxonomyDecider((request) =>
      request.evidence.includes(URLS.a2) ? { shelves: { none: 0.95 } } : taxonomyFor(request),
    ).decider;
    const first = await refresh(world, 'backfill-count');
    expect(first.summary.irrelevant).toBe(1);

    // A new category touches A2's question, out on none, and a function's description touches the
    // shelved pages': A1's and B1's. The decider now finds A1 none too, and A2 none again.
    await commitChange(world, 'backfill-count', [SPEAKERS]);
    await commitChange(world, 'backfill-count', [
      {
        kind: 'describe',
        subject: 'function',
        item: 'dac',
        description: 'Turns a digital signal into an analog one',
      },
    ]);
    world.ports.taxonomyDecider = fakeTaxonomyDecider(none).decider;
    const second = await refresh(world, 'backfill-count', {});
    expect(second.summary.backfill).toEqual({ due: 3, decided: 3, fetch: 0, waiting: 0 });
    // Only A1 was taken out now: A2 was out already.
    expect(second.summary.irrelevant).toBe(1);
    expect(await statusOf(a1!.id)).toBe('irrelevant');
    expect(await statusOf(a2!.id)).toBe('irrelevant');
    expect(await statusOf(b1!.id)).toBe('live');
  });

  it('keeps a person’s "None of these" out when its capture shows the page and the decider finds a shelf', async () => {
    const {
      world,
      pages: [, a2],
    } = await taxonomyWorld(testTaxonomyDefinition('backfill-person-seen'));
    await refresh(world, 'backfill-person-seen');
    // A person took A2 out, which withdrew what had been said of it.
    await personSaidNone(world, 'backfill-person-seen', a2!.id);
    await db
      .update(statements)
      .set({ withdrawnAt: world.clock.now() })
      .where(eq(statements.itemId, a2!.id));
    await setTaxonomyKey(db, a2!.id, await keyHash(T, null));
    await commitChange(world, 'backfill-person-seen', [SPEAKERS]);

    const before = world.web.requests.length;
    const second = await refresh(world, 'backfill-person-seen', {});
    expect(world.web.requests.length).toBe(before);
    expect(second.summary.backfill).toEqual({ due: 1, decided: 1, fetch: 0, waiting: 0 });
    // The decider read the page from its capture and found it a shelf, but a person's answer
    // keeps it out until they give another, and their question reopens, showing it.
    expect(world.taxonomyDecider.calls).toHaveLength(4);
    expect(await statusOf(a2!.id)).toBe('irrelevant');
    expect(second.summary.irrelevant).toBeUndefined();
    const reviews = await listOpenReviews(db, 'backfill-person-seen');
    expect(reviews.map((review) => review.subject)).toEqual([a2!.id]);
    expect(reviews[0]!.context).toMatchObject({ earlier: { shelf: NONE_SHELF } });
    expect(Object.keys((await published(world, 'backfill-person-seen'))!.byName)).not.toContain(
      'A2',
    );
  });

  it('puts a live page back out when a person took it out, before it decides it again', async () => {
    const {
      world,
      pages: [, a2],
    } = await taxonomyWorld(testTaxonomyDefinition('backfill-person-live'));
    await refresh(world, 'backfill-person-live');
    // A person took A2 out, and it was revived since, with the key it was decided under.
    await personSaidNone(world, 'backfill-person-live', a2!.id);
    await setItemStatus(db, a2!.id, 'live');
    await setTaxonomyKey(db, a2!.id, await keyHash(T, null));
    await commitChange(world, 'backfill-person-live', [SPEAKERS]);

    const second = await refresh(world, 'backfill-person-live', {});
    expect(second.summary.backfill).toEqual({ due: 1, decided: 1, fetch: 0, waiting: 0 });
    expect(await statusOf(a2!.id)).toBe('irrelevant');
    expect(second.summary.irrelevant).toBeUndefined();
    expect((await listOpenReviews(db, 'backfill-person-live')).map((r) => r.subject)).toEqual([
      a2!.id,
    ]);
    expect(Object.keys((await published(world, 'backfill-person-live'))!.byName)).not.toContain(
      'A2',
    );
  });

  it('refuses a backfill-only run for a dataset with no taxonomy to backfill, and asks no site', async () => {
    // A decided enum isn't a taxonomy, though its run has no taxonomy version as an unseeded one
    // doesn't.
    const decided = await worldFor(decidedDefinition('backfill-run-enum'), standardRoutes());
    const unseeded = await worldFor(testTaxonomyDefinition('backfill-run-bare'), standardRoutes());
    for (const [dataset, { world }] of [
      ['backfill-run-enum', decided],
      ['backfill-run-bare', unseeded],
    ] as const) {
      const runId = runIdFor(dataset, world.clock.now());
      await expect(refresh(world, dataset, { backfill: true })).rejects.toThrow(
        `${dataset} has no taxonomy to backfill`,
      );
      expect(world.web.requests).toHaveLength(0);
      expect(await getRun(db, runId)).toMatchObject({
        status: 'failed',
        error: `${dataset} has no taxonomy to backfill`,
      });
    }
  });
});
