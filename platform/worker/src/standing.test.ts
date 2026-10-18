import { REFUSE_AFTER_RUNS, runIdFor } from '@spatula/core';
import { applyDefinition, sources, sourceStates } from '@spatula/store';
import { testDefinition, testSitemapDefinition } from '@spatula/store/fixtures';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import { fakeStep, makeWorld, type StepCache, type World } from '../test/node/fakes';
import { refresh } from '../test/node/runs';
import { SITEMAPS, sitemapRoutes, standardRoutes, URLS, URLS_C, type Reply } from '../test/pages';
import { runRefresh, type StepRunner } from './refresh';

/*
 * A source's standing across runs (ADR 0006): blocked runs are counted, the third refuses the
 * source, a refused source gets one probe a run, and its hosts are asked more slowly after each
 * blocked run.
 */

const CHALLENGE: Reply = { status: 403, headers: { 'cf-mitigated': 'challenge' } };

/** Each source's standing, by ID. */
async function standing(datasetId: string) {
  return Object.fromEntries(
    (await sourceStates(db, datasetId)).map((state) => [
      state.id,
      {
        blockedRuns: state.blockedRuns,
        refused: state.refusedAt !== null,
        lastProbe: state.lastProbe,
      },
    ]),
  );
}

/**
 * The test dataset, reading `itemsPerRun` pages a run. A page is refused after three blocks of its
 * own (ADR 0005). Read in full, maker-a's two pages would both be blocked in each of three runs and
 * be refused along with their source, leaving nothing live to probe or to plan. A smaller budget
 * keeps every page below three blocks, so the pages of a refused source stay live, as the spec has it.
 */
function budgeted(datasetId: string, itemsPerRun: number) {
  const definition = testDefinition(datasetId);
  return { ...definition, budget: { ...definition.budget, itemsPerRun } };
}

/** Refuses a source, as three blocked runs in a row would. */
async function refuse(datasetId: string, sourceId: string) {
  await db
    .update(sources)
    .set({ blockedRuns: REFUSE_AFTER_RUNS, refusedAt: new Date(Date.UTC(2026, 9, 1)) })
    .where(and(eq(sources.datasetId, datasetId), eq(sources.id, sourceId)));
}

/** What the web was asked for on a host since request `from`, robots.txt left out. */
function askedOn(world: World, host: string, from: number): string[] {
  return world.web.requests
    .slice(from)
    .map((sent) => sent.url)
    .filter((url) => new URL(url).host === host && new URL(url).pathname !== '/robots.txt');
}

/** Keeps the interval each request asked its host's gate for. */
function pacing(world: World) {
  const asked: { host: string; minIntervalMs: number }[] = [];
  const gate = world.ports.gate;
  world.ports.gate = {
    async reserve(url, request) {
      asked.push({ host: new URL(url).host, minIntervalMs: request.minIntervalMs });
      return gate.reserve(url, request);
    },
    record: (url, response) => gate.record(url, response),
  };
  /** The intervals asked for on a host since entry `from`, each once. */
  const on = (host: string, from: number) => [
    ...new Set(
      asked
        .slice(from)
        .filter((row) => row.host === host)
        .map((row) => row.minIntervalMs),
    ),
  ];
  return { asked, on };
}

// Each test runs several refreshes against a real database.
describe('a source’s standing across runs', { timeout: 30_000 }, () => {
  it('counts a run that read nothing of a source and met a refusal, and not one that met an outage', async () => {
    const datasetId = 'standing-blocked';
    await applyDefinition(db, testDefinition(datasetId));
    const routes = standardRoutes();
    routes[URLS.b1] = CHALLENGE;
    // maker-a is blocked only in part: a2 gets through, so its run isn't blocked.
    routes[URLS.a1] = CHALLENGE;
    const world = makeWorld(db, routes);

    const blocked = await refresh(world, datasetId);
    expect(blocked.names).toContain('sources');
    expect(blocked.summary.sources).toEqual({
      blocked: [{ id: 'maker-b', blockedRuns: 1 }],
      refused: [],
      probed: [],
    });
    expect(await standing(datasetId)).toEqual({
      'maker-a': { blockedRuns: 0, refused: false, lastProbe: null },
      'maker-b': { blockedRuns: 1, refused: false, lastProbe: null },
    });

    // An outage says nothing either way, so the count stays where it was.
    world.web.routes.set(URLS.b1, { status: 503 });
    const down = await refresh(world, datasetId);
    expect(down.summary.sources).toBeUndefined();
    expect((await standing(datasetId))['maker-b']!.blockedRuns).toBe(1);

    // A 404 is the site answering: the count starts again.
    world.web.routes.set(URLS.b1, { status: 404 });
    await refresh(world, datasetId);
    expect((await standing(datasetId))['maker-b']!.blockedRuns).toBe(0);
  });

  it('refuses a source at its third blocked run, asking its hosts more slowly each time, then only probes it', async () => {
    const datasetId = 'standing-refused';
    // A run reads one page of maker-a and B1, so no page of maker-a is blocked three times.
    await applyDefinition(db, budgeted(datasetId, 2));
    const routes = standardRoutes();
    routes[URLS.a1] = CHALLENGE;
    routes[URLS.a2] = CHALLENGE;
    const world = makeWorld(db, routes);
    const pace = pacing(world);

    // The test definition asks for a second between requests to a host.
    const intervals: number[][] = [];
    for (let run = 1; run <= REFUSE_AFTER_RUNS; run += 1) {
      const from = pace.asked.length;
      const result = await refresh(world, datasetId);
      intervals.push(pace.on('maker-a.example', from));
      expect(pace.on('maker-b.example', from)).toEqual([1000]);
      expect(result.summary.sources?.blocked).toEqual([{ id: 'maker-a', blockedRuns: run }]);
      expect(result.summary.sources?.refused).toEqual(run === REFUSE_AFTER_RUNS ? ['maker-a'] : []);
    }
    expect(intervals).toEqual([[1000], [2000], [4000]]);
    expect((await standing(datasetId))['maker-a']).toEqual({
      blockedRuns: 3,
      refused: true,
      lastProbe: null,
    });

    // Refused, it gets one probe a run, though this run counts every page as due (Review Focus 3),
    // and its hosts stay at four times the interval. A probe that's refused counts no fourth run.
    const from = world.web.requests.length;
    const fromPace = pace.asked.length;
    const probing = await refresh(world, datasetId, { all: true });
    expect(probing.names).toContain('probe:maker-a');
    expect(probing.names).not.toContain('sources:back');
    expect(askedOn(world, 'maker-a.example', from)).toHaveLength(1);
    expect(pace.on('maker-a.example', fromPace)).toEqual([4000]);
    expect(probing.summary.sources).toEqual({
      blocked: [],
      refused: [],
      probed: [{ id: 'maker-a', outcome: 'blocked' }],
    });
    expect(probing.summary.notes).toContain('maker-a: still refused; its probe was blocked');
    expect((await standing(datasetId))['maker-a']).toEqual({
      blockedRuns: 3,
      refused: true,
      lastProbe: 'blocked',
    });
  });

  it('makes a refused source live again when its probe gets through, and reads its due pages in that run', async () => {
    const datasetId = 'standing-back';
    // A run reads one page, the least recently read of maker-a's, so none is blocked three times.
    await applyDefinition(db, budgeted(datasetId, 1));
    const routes = standardRoutes();
    routes[URLS.a1] = CHALLENGE;
    routes[URLS.a2] = CHALLENGE;
    const world = makeWorld(db, routes);
    for (let run = 1; run <= REFUSE_AFTER_RUNS; run += 1) {
      await refresh(world, datasetId, { all: false });
    }
    expect((await standing(datasetId))['maker-a']!.refused).toBe(true);

    const open = standardRoutes();
    world.web.routes.set(URLS.a1, open[URLS.a1]!);
    world.web.routes.set(URLS.a2, open[URLS.a2]!);
    const from = world.web.requests.length;
    const back = await refresh(world, datasetId, { all: false });
    expect(back.names).toContain('sources:back');
    expect(back.summary.sources).toEqual({
      blocked: [],
      refused: [],
      probed: [{ id: 'maker-a', outcome: 'through' }],
    });
    // The probe read one page. The plan, made once the source was live again, read the other,
    // which was due after its blocks. Neither was asked for twice.
    expect(askedOn(world, 'maker-a.example', from).sort()).toEqual([URLS.a1, URLS.a2]);
    expect((await standing(datasetId))['maker-a']).toEqual({
      blockedRuns: 0,
      refused: false,
      lastProbe: null,
    });

    // The run after the first clean one asks at the definition's interval again.
    const pace = pacing(world);
    await refresh(world, datasetId, { all: true });
    expect(pace.on('maker-a.example', 0)).toEqual([1000]);
  });

  it('probes a refused sitemap source with its first sitemap, and reads the rest once that gets through', async () => {
    const datasetId = 'standing-sitemap';
    await applyDefinition(db, testSitemapDefinition(datasetId));
    const world = makeWorld(db, sitemapRoutes());
    await refresh(world, datasetId);
    await refuse(datasetId, 'maker-c');
    const pace = pacing(world);

    world.web.routes.set(SITEMAPS.index, CHALLENGE);
    const from = world.web.requests.length;
    const blocked = await refresh(world, datasetId);
    expect(blocked.names).toContain('sitemap:maker-c:0:0');
    expect(blocked.names).not.toContain('sitemap:maker-c:1:0');
    // Only the probe: no other sitemap, and none of the source's pages, though every page is due.
    expect(askedOn(world, 'maker-c.example', from)).toEqual([SITEMAPS.index]);
    expect(pace.on('maker-c.example', 0)).toEqual([4000]);
    expect(blocked.summary.sources).toEqual({
      blocked: [],
      refused: [],
      probed: [{ id: 'maker-c', outcome: 'blocked' }],
    });
    // A read that stopped at its probe is incomplete, so nothing of the source is marked missing.
    expect(blocked.summary.discovery).toMatchObject({ missing: 0, gone: 0 });
    expect((await standing(datasetId))['maker-c']).toEqual({
      blockedRuns: 3,
      refused: true,
      lastProbe: 'blocked',
    });

    world.web.routes.set(SITEMAPS.index, sitemapRoutes()[SITEMAPS.index]!);
    const fromBack = world.web.requests.length;
    const back = await refresh(world, datasetId);
    expect(back.names).toContain('sitemap:maker-c:1:0');
    expect(back.summary.sources?.probed).toEqual([{ id: 'maker-c', outcome: 'through' }]);
    expect(askedOn(world, 'maker-c.example', fromBack)).toEqual(
      expect.arrayContaining([SITEMAPS.index, SITEMAPS.products, URLS_C.c1, URLS_C.c2]),
    );
    expect((await standing(datasetId))['maker-c']).toEqual({
      blockedRuns: 0,
      refused: false,
      lastProbe: null,
    });
  });

  it('reads a load without standing, and fetches without a site, as nothing (Review Focus 2)', async () => {
    const datasetId = 'standing-old-results';
    await applyDefinition(db, testDefinition(datasetId));
    const routes = standardRoutes();
    routes[URLS.b1] = CHALLENGE;
    const world = makeWorld(db, routes);
    const cache: StepCache = new Map();
    const params = { runId: runIdFor(datasetId, world.clock.now()), datasetId };

    // The run stops at its sources step. Its finished steps are then kept as an earlier version
    // kept them: a load without standing, and fetches without a site.
    const first = fakeStep(world.clock, cache);
    const stopping: StepRunner = {
      async do(name, fn) {
        if (name === 'sources') throw new Error('the Worker was replaced');
        return first.step.do(name, fn);
      },
      sleep: (name, ms) => first.step.sleep(name, ms),
    };
    await expect(runRefresh(params, stopping, world.ports)).rejects.toThrow(
      'the Worker was replaced',
    );
    for (const [name, kept] of cache) {
      if (kept === undefined) continue;
      const result = JSON.parse(kept) as Record<string, unknown>;
      if (name === 'load') delete result.standing;
      if (name.startsWith('fetch:') && result.kind === 'done') {
        delete (result.fetched as Record<string, unknown>).site;
      }
      cache.set(name, JSON.stringify(result));
    }

    // The replay reads every source as live, and every answer as neither, so nothing is counted.
    const replay = fakeStep(world.clock, cache);
    const summary = await runRefresh(params, replay.step, world.ports);
    expect(replay.replayed).toEqual(expect.arrayContaining(['load', 'plan']));
    expect(summary.sources).toBeUndefined();
    expect((await standing(datasetId))['maker-b']!.blockedRuns).toBe(0);
  });
});

/*
 * What the steps above leave to their neighbours: whose answers a verdict is made of, which page a
 * probe is, how many sitemaps it reads, and what a step that runs again counts.
 */
describe('what a run counts of a source', { timeout: 30_000 }, () => {
  /** A world after one clean run, with maker-a refused and its pages live. */
  async function refusedWorld(datasetId: string) {
    await applyDefinition(db, testDefinition(datasetId));
    const world = makeWorld(db, standardRoutes());
    await refresh(world, datasetId);
    await refuse(datasetId, 'maker-a');
    return world;
  }

  it('says when a run refuses a source', async () => {
    const datasetId = 'standing-says-refused';
    await applyDefinition(db, testDefinition(datasetId));
    await db
      .update(sources)
      .set({ blockedRuns: REFUSE_AFTER_RUNS - 1 })
      .where(and(eq(sources.datasetId, datasetId), eq(sources.id, 'maker-b')));
    const routes = standardRoutes();
    routes[URLS.b1] = CHALLENGE;
    const world = makeWorld(db, routes);

    const run = await refresh(world, datasetId);
    expect(run.summary.sources).toEqual({
      blocked: [{ id: 'maker-b', blockedRuns: 3 }],
      refused: ['maker-b'],
      probed: [],
    });
    expect(run.summary.notes).toContain(
      'maker-b: refused after 3 blocked runs in a row; later runs only probe it, until a probe gets through or it’s revived',
    );
  });

  it('counts the sitemaps a run read as getting through, though every page they listed was challenged', async () => {
    const datasetId = 'standing-sitemaps-through';
    await applyDefinition(db, testSitemapDefinition(datasetId));
    const routes = sitemapRoutes();
    routes[URLS_C.c1] = CHALLENGE;
    routes[URLS_C.c2] = CHALLENGE;
    const world = makeWorld(db, routes);

    const run = await refresh(world, datasetId);
    expect(run.summary.fetches.blocked).toBe(2);
    expect(run.summary.sources).toBeUndefined();
    expect((await standing(datasetId))['maker-c']!.blockedRuns).toBe(0);
  });

  it('reads a probed page once, though every page is due', async () => {
    const datasetId = 'standing-probed-once';
    const world = await refusedWorld(datasetId);

    // --all counts A1 and A2 as due. The probe reads one, and the plan, made once the source is live
    // again, must leave it out and read the other: asking for a page twice runs its steps twice,
    // which the fake Workflow refuses.
    const from = world.web.requests.length;
    const back = await refresh(world, datasetId, { all: true });
    expect(back.summary.sources?.probed).toEqual([{ id: 'maker-a', outcome: 'through' }]);
    expect(askedOn(world, 'maker-a.example', from).sort()).toEqual([URLS.a1, URLS.a2]);
  });

  it('counts a probe that got through with the pages read after it, so a challenge among them is no blocked run', async () => {
    const datasetId = 'standing-probe-then-challenge';
    const world = await refusedWorld(datasetId);
    world.web.routes.set(URLS.a2, CHALLENGE);

    // A1, the probe, gets through. A2, read by the plan once the source is live again, is challenged.
    const run = await refresh(world, datasetId, { all: true });
    expect(run.summary.sources).toEqual({
      blocked: [],
      refused: [],
      probed: [{ id: 'maker-a', outcome: 'through' }],
    });
    expect((await standing(datasetId))['maker-a']).toEqual({
      blockedRuns: 0,
      refused: false,
      lastProbe: null,
    });
  });

  it('keeps a refused source refused when its probe meets an outage, and says so', async () => {
    const datasetId = 'standing-probe-outage';
    const world = await refusedWorld(datasetId);
    world.web.routes.set(URLS.a1, { status: 503 });
    world.web.routes.set(URLS.a2, { status: 503 });

    const run = await refresh(world, datasetId, { all: true });
    expect(run.names).not.toContain('sources:back');
    expect(run.summary.sources).toEqual({
      blocked: [],
      refused: [],
      probed: [{ id: 'maker-a', outcome: 'no answer' }],
    });
    expect(run.summary.notes).toContain('maker-a: still refused; its probe got no answer');
    expect((await standing(datasetId))['maker-a']).toEqual({
      blockedRuns: 3,
      refused: true,
      lastProbe: 'no answer',
    });
  });

  it('sends a refused sitemap source one request, though its definition lists two sitemaps', async () => {
    const datasetId = 'standing-two-sitemaps';
    const definition = testSitemapDefinition(datasetId);
    await applyDefinition(db, {
      ...definition,
      sources: definition.sources.map((source) =>
        source.kind === 'sitemap'
          ? { ...source, sitemaps: [SITEMAPS.index, SITEMAPS.pages] }
          : source,
      ),
    });
    const world = makeWorld(db, sitemapRoutes());
    await refresh(world, datasetId);
    await refuse(datasetId, 'maker-c');

    world.web.routes.set(SITEMAPS.index, CHALLENGE);
    const from = world.web.requests.length;
    const run = await refresh(world, datasetId);
    expect(run.names).not.toContain('sitemap:maker-c:1:0');
    expect(askedOn(world, 'maker-c.example', from)).toEqual([SITEMAPS.index]);
    expect(run.summary.sources?.probed).toEqual([{ id: 'maker-c', outcome: 'blocked' }]);
  });

  it('counts a blocked run once, however often its sources step runs (Review Focus 1)', async () => {
    const datasetId = 'standing-counted-once';
    await applyDefinition(db, testDefinition(datasetId));
    const routes = standardRoutes();
    routes[URLS.b1] = CHALLENGE;
    const world = makeWorld(db, routes);
    const cache: StepCache = new Map();
    const params = { runId: runIdFor(datasetId, world.clock.now()), datasetId };

    // The sources step counts the run, and the Worker goes before the Workflow keeps its result.
    const first = fakeStep(world.clock, cache);
    const dying: StepRunner = {
      async do(name, fn) {
        if (name !== 'sources') return first.step.do(name, fn);
        await fn();
        throw new Error('the Worker went away');
      },
      sleep: (name, ms) => first.step.sleep(name, ms),
    };
    await expect(runRefresh(params, dying, world.ports)).rejects.toThrow('the Worker went away');
    expect((await standing(datasetId))['maker-b']!.blockedRuns).toBe(1);

    // The step runs again later, as the same run: it counts nothing more, and says what it counted.
    world.clock.advance(10 * 60_000);
    const replay = fakeStep(world.clock, cache);
    const summary = await runRefresh(params, replay.step, world.ports);
    expect(replay.replayed).not.toContain('sources');
    expect(summary.sources).toEqual({
      blocked: [{ id: 'maker-b', blockedRuns: 1 }],
      refused: [],
      probed: [],
    });
    expect((await standing(datasetId))['maker-b']!.blockedRuns).toBe(1);
  });
});
