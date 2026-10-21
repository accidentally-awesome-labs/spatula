import { NONE_OF_THESE, NONE_SHELF, runIdFor, sha256Hex } from '@spatula/core';
import {
  applyDefinition,
  fetches,
  finalizeDecision,
  items,
  listLiveItems,
  listOpenReviews,
  reviveItems,
  saveDecision,
  seedTaxonomyVersion,
  setItemStatus,
  statements,
} from '@spatula/store';
import { testDefinition, testTaxonomy, testTaxonomyDefinition } from '@spatula/store/fixtures';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import { fakeStep, fakeTaxonomyDecider, type World } from '../test/node/fakes';
import {
  decidedDefinition,
  fetchOf,
  published,
  refresh,
  taxonomyWorld,
  worldFor,
} from '../test/node/runs';
import { A1, standardRoutes, taxonomyFor, URLS } from '../test/pages';
import { extractionTag, pageKey } from './pipeline';
import { runRefresh, type StepRunner } from './refresh';

/** The product pages the world was asked for since `from`, in order. */
const pagesAsked = (requests: { url: string }[], from: number) =>
  requests
    .slice(from)
    .map((request) => request.url)
    .filter((url) => url.includes('/products/'));

/** What each of the dataset's live pages is marked with, in the live pages' order. */
const marks = async (datasetId: string) =>
  (await listLiveItems(db, datasetId)).map((item) => item.extractedWith);

// Each test runs the pipeline against a real database, several runs in each.
describe('reading a page again from its capture', { timeout: 20_000 }, () => {
  it('reads each page again with no request when only its code is older, and --all still fetches', async () => {
    const {
      world,
      pages: [a1, a2, b1],
    } = await worldFor(decidedDefinition('reread-apply'), standardRoutes());
    const first = await refresh(world, 'reread-apply');
    const read = await fetchOf(first.runId, URLS.a1);

    // A new revision: every page is due, only because the code that read it is older.
    await applyDefinition(db, decidedDefinition('reread-apply', { freshness: { maxAgeDays: 8 } }));
    const before = world.web.requests.length;
    const second = await refresh(world, 'reread-apply', {});
    expect(world.web.requests.length).toBe(before);
    expect(
      second.names.filter((name) => /^(?:reread|fetch|extract|classify):/u.test(name)),
    ).toEqual([
      `reread:${a1!.id}`,
      `extract:${a1!.id}`,
      `classify:${a1!.id}`,
      `reread:${b1!.id}`,
      `extract:${b1!.id}`,
      `reread:${a2!.id}`,
      `extract:${a2!.id}`,
      `classify:${a2!.id}`,
    ]);
    expect(second.summary).toMatchObject({
      items: 3,
      due: 3,
      reread: 3,
      fetches: { changed: 0, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
      llm: { ran: 0, reused: 3 },
      classify: { accepted: 0, reused: 2 },
    });
    expect(await db.select().from(fetches).where(eq(fetches.runId, second.runId))).toEqual([]);
    // A1's statements count as seen at the fetch that read it, whose log stays as it was.
    const current = await db
      .select({ lastSeen: statements.lastSeen, lastFetchId: statements.lastFetchId })
      .from(statements)
      .where(and(eq(statements.itemId, a1!.id), isNull(statements.withdrawnAt)));
    expect(current.length).toBeGreaterThan(0);
    expect(new Set(current.map((row) => row.lastFetchId))).toEqual(new Set([read.id]));
    expect(new Set(current.map((row) => row.lastSeen.getTime()))).toEqual(
      new Set([read.startedAt.getTime()]),
    );
    expect((await fetchOf(first.runId, URLS.a1)).llm).toBe(read.llm);
    expect(await marks('reread-apply')).toEqual([
      extractionTag(2),
      extractionTag(2),
      extractionTag(2),
    ]);

    // --all counts every page as due, so each is fetched, though only its code is older.
    await applyDefinition(db, decidedDefinition('reread-apply', { freshness: { maxAgeDays: 9 } }));
    const all = await refresh(world, 'reread-apply', { all: true });
    expect(all.names.some((name) => name.startsWith('reread:'))).toBe(false);
    expect(all.summary).toMatchObject({ reread: 0, fetches: { unchanged: 3 } });
    expect(await marks('reread-apply')).toEqual([
      extractionTag(3),
      extractionTag(3),
      extractionTag(3),
    ]);
  });

  it('fetches a page whose captured copy is gone, and reads the others again from theirs', async () => {
    const definition = testDefinition('reread-gone');
    const {
      world,
      pages: [a1, a2, b1],
    } = await worldFor(definition, standardRoutes());
    await refresh(world, 'reread-gone');
    // A1's copy is gone from the archive, and its page has changed since.
    world.stored.delete(pageKey(await sha256Hex(A1())));
    world.web.routes.set(URLS.a1, { status: 200, body: A1('two') });
    await applyDefinition(db, { ...definition, freshness: { maxAgeDays: 8 } });
    const before = world.web.requests.length;
    const second = await refresh(world, 'reread-gone', {});
    expect(second.names.filter((name) => /^(?:reread|fetch):/u.test(name))).toEqual([
      `reread:${a1!.id}`,
      `fetch:${a1!.id}:0`,
      `reread:${b1!.id}`,
      `reread:${a2!.id}`,
    ]);
    expect(second.results.get(`reread:${a1!.id}`)).toBeNull();
    expect(pagesAsked(world.web.requests, before)).toEqual([URLS.a1]);
    expect(second.summary).toMatchObject({ items: 3, reread: 2, fetches: { changed: 1 } });
  });

  it('reads the pages of a taxonomy dataset again from their captures while it has no taxonomy', async () => {
    const {
      world,
      pages: [a1, a2, b1],
    } = await worldFor(testTaxonomyDefinition('reread-unseeded'), standardRoutes());
    // Not placed, so not current: the next run reads them again, which asks nothing of their sites.
    await refresh(world, 'reread-unseeded');
    const before = world.web.requests.length;
    const second = await refresh(world, 'reread-unseeded', {});
    expect(world.web.requests.length).toBe(before);
    expect(second.names.filter((name) => /^(?:reread|fetch):/u.test(name))).toEqual([
      `reread:${a1!.id}`,
      `reread:${b1!.id}`,
      `reread:${a2!.id}`,
    ]);
    expect(second.summary).toMatchObject({ reread: 3, fetches: { unchanged: 0, changed: 0 } });
  });

  it('fetches the pages of a plan an earlier version kept, which names none to read again', async () => {
    const definition = testDefinition('reread-older');
    const { world } = await worldFor(definition, standardRoutes());
    await refresh(world, 'reread-older');
    await applyDefinition(db, { ...definition, freshness: { maxAgeDays: 8 } });
    const { step, names } = fakeStep(world.clock);
    const older: StepRunner = {
      ...step,
      async do(name, fn) {
        const result = await step.do(name, fn);
        // As an earlier version kept the plan's result: without `reread`.
        if (name === 'plan') delete (result as { reread?: string[] }).reread;
        return result;
      },
    };
    const runId = runIdFor('reread-older', world.clock.now());
    const summary = await runRefresh({ runId, datasetId: 'reread-older' }, older, world.ports);
    expect(names.some((name) => name.startsWith('reread:'))).toBe(false);
    expect(names.filter((name) => name.startsWith('fetch:'))).toHaveLength(3);
    expect(summary).toMatchObject({ items: 3, due: 3, reread: 0, fetches: { unchanged: 3 } });
  });
});

/**
 * A person's "None of these" about a page, as a classification kept it before the taxonomy, which
 * took the page out.
 */
async function personTookOut(world: World, datasetId: string, itemId: string) {
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

const statusOf = async (itemId: string) =>
  (await db.select({ status: items.status }).from(items).where(eq(items.id, itemId)))[0]!.status;

/**
 * A taxonomy dataset whose pages were read before its taxonomy was seeded, as the switch leaves
 * them: not placed, and due. A page a person took out is revived from its capture, and the taxonomy
 * is seeded.
 */
async function switched(datasetId: string, tookOut: string) {
  const made = await worldFor(testTaxonomyDefinition(datasetId), standardRoutes());
  await refresh(made.world, datasetId);
  const page = made.pages.find((item) => item.locator === tookOut)!;
  await personTookOut(made.world, datasetId, page.id);
  expect(await reviveItems(db, { datasetId, irrelevant: true, fromCaptures: true })).toBe(1);
  await seedTaxonomyVersion(db, {
    datasetId,
    taxonomy: testTaxonomy(),
    actor: { role: 'owner', client: 'cli' },
    at: made.world.clock.now(),
  });
  return { ...made, page };
}

describe('reading a page a person took out', { timeout: 20_000 }, () => {
  it('keeps it out and reopens its question when it is live again and read from its capture', async () => {
    const { world, page } = await switched('reread-none', URLS.a1);
    const before = world.web.requests.length;
    const second = await refresh(world, 'reread-none', {});
    expect(world.web.requests.length).toBe(before);
    expect(second.names).toEqual(
      expect.arrayContaining([`reread:${page.id}`, `decide:${page.id}`]),
    );
    // The decider found A1 a shelf, but a person's "None of these" keeps it out until they answer.
    expect(await statusOf(page.id)).toBe('irrelevant');
    expect(Object.keys((await published(world, 'reread-none'))!.byName)).not.toContain('A1');
    const open = await listOpenReviews(db, 'reread-none');
    expect(open.map((review) => review.subject)).toEqual([page.id]);
    expect(open[0]!.context).toMatchObject({
      earlier: { shelf: NONE_SHELF, functions: [], values: [] },
    });
  });

  it('keeps a placed page out when it is revived, read from its capture, and found a shelf', async () => {
    const definition = testTaxonomyDefinition('reread-none-placed');
    const {
      world,
      pages: [a1, a2, b1],
    } = await taxonomyWorld(definition);
    await refresh(world, 'reread-none-placed');
    // After its placement, a person said "None of these", and the page was revived from its
    // capture. Only A1 is due, and it's read again.
    await personTookOut(world, 'reread-none-placed', a1!.id);
    expect(
      await reviveItems(db, {
        datasetId: 'reread-none-placed',
        irrelevant: true,
        fromCaptures: true,
      }),
    ).toBe(1);
    const before = world.web.requests.length;
    const second = await refresh(world, 'reread-none-placed', {});
    expect(world.web.requests.length).toBe(before);
    expect(second.names.filter((name) => /^(?:reread|fetch|decide):/u.test(name))).toEqual([
      `reread:${a1!.id}`,
      `decide:${a1!.id}`,
    ]);
    expect(second.summary).toMatchObject({ items: 1, due: 1, reread: 1 });
    expect(await statusOf(a1!.id)).toBe('irrelevant');
    expect(await statusOf(a2!.id)).toBe('live');
    expect(await statusOf(b1!.id)).toBe('live');
    const open = await listOpenReviews(db, 'reread-none-placed');
    expect(open.map((review) => review.subject)).toEqual([a1!.id]);
    expect(open[0]!.context).toMatchObject({ earlier: { shelf: NONE_SHELF } });
    expect(Object.keys((await published(world, 'reread-none-placed'))!.byName).sort()).toEqual([
      'A2',
      'B1 Amp',
    ]);
  });

  it('keeps it out, and asks nothing, when the decider finds it none of these too', async () => {
    const { world, page } = await switched('reread-none-again', URLS.a1);
    world.ports.taxonomyDecider = fakeTaxonomyDecider((request) =>
      request.evidence.includes(URLS.a1) ? { shelves: { none: 0.95 } } : taxonomyFor(request),
    ).decider;
    const second = await refresh(world, 'reread-none-again', {});
    expect(second.names).toContain(`reread:${page.id}`);
    expect(await statusOf(page.id)).toBe('irrelevant');
    expect(await listOpenReviews(db, 'reread-none-again')).toEqual([]);
  });

  it('keeps it out and reopens its question when it is fetched instead', async () => {
    const { world, page } = await switched('reread-none-fetched', URLS.a1);
    // --all fetches every page, a revived one included.
    const second = await refresh(world, 'reread-none-fetched', { all: true });
    expect(second.names).toContain(`fetch:${page.id}:0`);
    expect(await statusOf(page.id)).toBe('irrelevant');
    const open = await listOpenReviews(db, 'reread-none-fetched');
    expect(open.map((review) => review.subject)).toEqual([page.id]);
    expect(open[0]!.context).toMatchObject({ earlier: { shelf: NONE_SHELF } });
  });
});
