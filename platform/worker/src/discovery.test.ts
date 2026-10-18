import { gzipSync } from 'node:zlib';
import { applyDefinition, fetches, getRun, items, listLiveItems, startRun } from '@spatula/store';
import { testSitemapDefinition } from '@spatula/store/fixtures';
import { runIdFor, type Definition } from '@spatula/core';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import { fakeStep, makeWorld, type StepCache, type World } from '../test/node/fakes';
import {
  C1,
  C2,
  productSitemap,
  ROBOTS_OPEN,
  SITEMAPS,
  sitemapIndex,
  sitemapRoutes,
  URLS_C,
  type Reply,
} from '../test/pages';
import { discoverSource, SITEMAP_MAX_BYTES } from './discovery';
import { runRefresh, type StepRunner } from './refresh';

/**
 * One run, then five minutes, as in the pipeline's tests; it reads every page that's due. Workflows
 * keep each step's result, so the run keeps them too, for tests that look at what a step returned.
 */
async function refresh(world: World, datasetId: string) {
  const runId = runIdFor(datasetId, world.clock.now());
  const { step, names } = fakeStep(world.clock);
  const results = new Map<string, unknown>();
  const recording: StepRunner = {
    ...step,
    async do(name, fn) {
      const result = await step.do(name, fn);
      results.set(name, result);
      return result;
    },
  };
  const summary = await runRefresh({ runId, datasetId }, recording, world.ports);
  world.clock.advance(5 * 60_000);
  return { summary, names, runId, results };
}

async function setUp(
  datasetId: string,
  routes: Record<string, Reply> = sitemapRoutes(),
  change: (definition: Definition) => Definition = (definition) => definition,
) {
  await applyDefinition(db, change(testSitemapDefinition(datasetId)));
  return makeWorld(db, routes);
}

/** Maker C's pages, by address, with their status and listing. */
async function makerC(datasetId: string) {
  const rows = await db
    .select({
      locator: items.locator,
      status: items.status,
      missingStreak: items.missingStreak,
      listedLastmod: items.listedLastmod,
    })
    .from(items)
    .where(and(eq(items.datasetId, datasetId), eq(items.sourceId, 'maker-c')));
  return Object.fromEntries(rows.map((row) => [row.locator, row]));
}

/** A sitemap index naming these sitemaps. */
const indexOf = (locs: string[]) =>
  '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  locs.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join('') +
  '</sitemapindex>';

// Each test runs the pipeline against a real database, several runs in some, and a busy machine
// needs more than the five seconds a test gets by default.
describe('discovery', { timeout: 20_000 }, () => {
  it('lists a source’s pages from its sitemaps, following only the children it names', async () => {
    const world = await setUp('discovery-basics');
    const { summary, names, runId } = await refresh(world, 'discovery-basics');
    expect(names.slice(0, 5)).toEqual([
      'load',
      'sitemap:maker-c:0:0',
      'sitemap:maker-c:1:0',
      'listed:maker-c',
      'plan',
    ]);
    expect(summary.discovery).toEqual({
      sources: 1,
      sitemaps: 2,
      listed: 2,
      added: 2,
      revived: 0,
      missing: 0,
      gone: 0,
      incomplete: [],
    });
    const asked = world.web.requests.map((sent) => sent.url);
    expect(asked).not.toContain(SITEMAPS.pages);
    expect(asked).toEqual(expect.arrayContaining([URLS_C.c1, URLS_C.c2]));
    expect(summary).toMatchObject({ items: 5, fetches: { changed: 5 } });
    expect(await makerC('discovery-basics')).toEqual({
      [URLS_C.c1]: {
        locator: URLS_C.c1,
        status: 'live',
        missingStreak: 0,
        listedLastmod: '2026-10-01T00:00:00.000Z',
      },
      [URLS_C.c2]: { locator: URLS_C.c2, status: 'live', missingStreak: 0, listedLastmod: null },
    });
    const logged = await db
      .select({ kind: fetches.kind, url: fetches.url, outcome: fetches.outcome })
      .from(fetches)
      .where(and(eq(fetches.runId, runId), eq(fetches.sourceId, 'maker-c')))
      .orderBy(fetches.startedAt);
    expect(logged).toEqual([
      { kind: 'sitemap', url: SITEMAPS.index, outcome: 'changed' },
      { kind: 'sitemap', url: SITEMAPS.products, outcome: 'changed' },
    ]);
  });

  it('marks nothing missing when a read fails partway, or reads a page that isn’t a sitemap', async () => {
    const routes = sitemapRoutes();
    const world = await setUp('discovery-partial', routes);
    await refresh(world, 'discovery-partial');

    world.web.routes.set(SITEMAPS.products, { status: 503 });
    const failed = await refresh(world, 'discovery-partial');
    expect(failed.summary.discovery?.incomplete).toEqual([
      `maker-c: ${SITEMAPS.products}: failed (HTTP 503)`,
    ]);
    expect(failed.names).not.toContain('listed:maker-c');

    world.web.routes.set(SITEMAPS.products, {
      status: 200,
      body: '<!doctype html><html><body>Not found</body></html>',
    });
    const soft = await refresh(world, 'discovery-partial');
    expect(soft.summary.discovery?.incomplete).toEqual([
      `maker-c: ${SITEMAPS.products}: not a sitemap (its root element is <html>, not a sitemap’s)`,
    ]);

    world.web.routes.set(SITEMAPS.products, { status: 200, body: productSitemap([]) });
    const empty = await refresh(world, 'discovery-partial');
    expect(empty.summary.discovery?.incomplete).toEqual([
      'maker-c: its sitemaps list no pages that match',
    ]);

    const pages = await makerC('discovery-partial');
    expect(Object.values(pages).map((row) => [row.status, row.missingStreak])).toEqual([
      ['live', 0],
      ['live', 0],
    ]);
  });

  it('calls a page gone after three complete reads without it', async () => {
    const world = await setUp('discovery-gone');
    await refresh(world, 'discovery-gone');
    world.web.routes.set(SITEMAPS.products, {
      status: 200,
      body: productSitemap([{ loc: URLS_C.c1, lastmod: '2026-10-01' }]),
    });
    const runs = [];
    for (let read = 0; read < 3; read += 1) runs.push(await refresh(world, 'discovery-gone'));
    expect(
      runs.map((run) => [run.summary.discovery?.missing, run.summary.discovery?.gone]),
    ).toEqual([
      [1, 0],
      [1, 0],
      [1, 1],
    ]);
    expect((await makerC('discovery-gone'))[URLS_C.c2]!.status).toBe('gone');
    expect((await listLiveItems(db, 'discovery-gone')).map((item) => item.locator)).not.toContain(
      URLS_C.c2,
    );
  });

  it('reads a gzipped sitemap, and ignores lastmods a source doesn’t trust', async () => {
    const routes = sitemapRoutes();
    routes[SITEMAPS.products] = {
      status: 200,
      bytes: gzipSync(
        productSitemap([{ loc: URLS_C.c1, lastmod: '2026-10-01' }, { loc: URLS_C.c2 }]),
      ),
      headers: { 'content-type': 'application/gzip' },
    };
    const world = await setUp('discovery-gzip', routes, (definition) => ({
      ...definition,
      sources: definition.sources.map((source) =>
        source.kind === 'sitemap' ? { ...source, useLastmod: false } : source,
      ),
    }));
    const { summary } = await refresh(world, 'discovery-gzip');
    expect(summary.discovery).toMatchObject({ listed: 2, incomplete: [] });
    expect((await makerC('discovery-gzip'))[URLS_C.c1]!.listedLastmod).toBeNull();
  });

  it('keeps at most maxPages, and calls a read that had more incomplete', async () => {
    const world = await setUp('discovery-capped', sitemapRoutes(), (definition) => ({
      ...definition,
      sources: definition.sources.map((source) =>
        source.kind === 'sitemap' ? { ...source, maxPages: 1 } : source,
      ),
    }));
    const { summary } = await refresh(world, 'discovery-capped');
    expect(summary.discovery).toMatchObject({
      listed: 1,
      incomplete: ['maker-c: it lists more than 1 page; only the first were kept'],
    });
  });

  it('calls a page gone after it redirects away twice in a row', async () => {
    // A discontinued product's page often redirects to a collection, an address the source's
    // include patterns wouldn't list.
    const routes = sitemapRoutes();
    routes[URLS_C.c2] = { status: 301, headers: { location: '/collections/all' } };
    routes['https://maker-c.example/collections/all'] = { status: 200, body: C2() };
    const world = await setUp('discovery-away', routes);
    const reads = async (runId: string) =>
      db
        .select({ outcome: fetches.outcome, finalUrl: fetches.finalUrl, error: fetches.error })
        .from(fetches)
        .where(and(eq(fetches.runId, runId), eq(fetches.url, URLS_C.c2)));
    const away = {
      outcome: 'gone',
      finalUrl: 'https://maker-c.example/collections/all',
      error: 'redirected away, to https://maker-c.example/collections/all',
    };

    const first = await refresh(world, 'discovery-away');
    expect(await reads(first.runId)).toEqual([away]);
    expect((await makerC('discovery-away'))[URLS_C.c2]!.status).toBe('live');
    const second = await refresh(world, 'discovery-away');
    expect(await reads(second.runId)).toEqual([away]);
    expect((await makerC('discovery-away'))[URLS_C.c2]!.status).toBe('gone');
  });

  it('marks nothing missing when a sitemap is larger than the cap, zipped or not', async () => {
    const world = await setUp('discovery-cap');
    await refresh(world, 'discovery-cap');

    world.web.routes.set(SITEMAPS.products, {
      status: 200,
      body: productSitemap([{ loc: URLS_C.c1 }]),
      truncated: true,
    });
    const cut = await refresh(world, 'discovery-cap');
    expect(cut.summary.discovery?.incomplete).toEqual([
      `maker-c: ${SITEMAPS.products}: failed (larger than 20 MB)`,
    ]);

    world.web.routes.set(SITEMAPS.products, {
      status: 200,
      bytes: gzipSync(Buffer.alloc(SITEMAP_MAX_BYTES + 1, 0x20)),
      headers: { 'content-type': 'application/gzip' },
    });
    const unzipped = await refresh(world, 'discovery-cap');
    expect(unzipped.summary.discovery?.incomplete).toEqual([
      `maker-c: ${SITEMAPS.products}: failed (larger than 20 MB unzipped)`,
    ]);

    const pages = await makerC('discovery-cap');
    expect(
      [URLS_C.c1, URLS_C.c2].map((url) => [pages[url]!.status, pages[url]!.missingStreak]),
    ).toEqual([
      ['live', 0],
      ['live', 0],
    ]);
  });

  it('refuses a sitemap that redirects to another site, and lists nothing from it', async () => {
    // A sitemap's pages are its site's. If a redirect could make another site's pages the source's,
    // a maker could point Spatula at any host.
    const elsewhere = 'https://other-site.example/sitemap_products_1.xml';
    const routes = sitemapRoutes();
    routes[SITEMAPS.products] = { status: 301, headers: { location: elsewhere } };
    routes['https://other-site.example/robots.txt'] = { status: 200, body: ROBOTS_OPEN };
    routes[elsewhere] = {
      status: 200,
      body: productSitemap([{ loc: 'https://other-site.example/products/x1' }]),
    };
    const world = await setUp('discovery-other-site', routes);
    const { summary, names, runId } = await refresh(world, 'discovery-other-site');

    expect(summary.discovery).toMatchObject({
      listed: 0,
      incomplete: [
        `maker-c: ${SITEMAPS.products}: failed (redirected to another site, other-site.example)`,
      ],
    });
    expect(names).not.toContain('listed:maker-c');
    expect(await makerC('discovery-other-site')).toEqual({});
    const logged = await db
      .select({
        url: fetches.url,
        finalUrl: fetches.finalUrl,
        outcome: fetches.outcome,
        error: fetches.error,
      })
      .from(fetches)
      .where(and(eq(fetches.runId, runId), eq(fetches.url, SITEMAPS.products)));
    expect(logged).toEqual([
      {
        url: SITEMAPS.products,
        finalUrl: elsewhere,
        outcome: 'failed',
        error: 'redirected to another site, other-site.example',
      },
    ]);
  });

  it('follows a sitemap’s redirect on its own host when the host’s interval is longer than a step waits', async () => {
    // Each hop waits a full 20 s after the answer before it, which a step may not wait (15 s), so
    // the hop after the first is put off. It is asked for again where it left off, not from the
    // top.
    const moved = 'https://maker-c.example/sitemaps/index.xml';
    const routes = sitemapRoutes();
    routes[SITEMAPS.index] = { status: 301, headers: { location: moved } };
    routes[moved] = {
      status: 200,
      body: sitemapIndex(),
      headers: { 'content-type': 'application/xml' },
    };
    const world = await setUp('discovery-slow-redirect', routes, (definition) => ({
      ...definition,
      policy: { ...definition.policy, perHostIntervalMs: 20_000 },
    }));
    const { summary } = await refresh(world, 'discovery-slow-redirect');

    const asked = world.web.requests.map((sent) => sent.url);
    expect(asked.filter((url) => url === SITEMAPS.index)).toHaveLength(1);
    expect(asked.filter((url) => url === moved)).toHaveLength(1);
    expect(summary.discovery).toMatchObject({ sitemaps: 2, listed: 2, incomplete: [] });
  });

  it('lists the pages of a sitemap that moved from the apex to www', async () => {
    const www = 'https://www.maker-c.example';
    const routes = sitemapRoutes();
    routes[SITEMAPS.index] = { status: 301, headers: { location: `${www}/sitemap.xml` } };
    routes[`${www}/robots.txt`] = { status: 200, body: ROBOTS_OPEN };
    routes[`${www}/sitemap.xml`] = {
      status: 200,
      body: sitemapIndex().replaceAll('https://maker-c.example/', `${www}/`),
    };
    routes[`${www}/sitemap_products_1.xml?from=1&to=9`] = {
      status: 200,
      body: productSitemap([{ loc: `${www}/products/c1` }, { loc: `${www}/products/c2` }]),
    };
    routes[`${www}/products/c1`] = { status: 200, body: C1() };
    routes[`${www}/products/c2`] = { status: 200, body: C2() };
    const world = await setUp('discovery-www', routes);
    const { summary } = await refresh(world, 'discovery-www');

    expect(summary.discovery).toMatchObject({ listed: 2, incomplete: [] });
    expect(Object.keys(await makerC('discovery-www')).sort()).toEqual([
      `${www}/products/c1`,
      `${www}/products/c2`,
    ]);
  });

  it('lists the pages of a sitemap that moved from www to the apex', async () => {
    const routes = sitemapRoutes();
    routes['https://www.maker-c.example/robots.txt'] = { status: 200, body: ROBOTS_OPEN };
    routes['https://www.maker-c.example/sitemap.xml'] = {
      status: 301,
      headers: { location: SITEMAPS.index },
    };
    const world = await setUp('discovery-apex', routes, (definition) => ({
      ...definition,
      sources: definition.sources.map((source) =>
        source.kind === 'sitemap'
          ? { ...source, sitemaps: ['https://www.maker-c.example/sitemap.xml'] }
          : source,
      ),
    }));
    const { summary } = await refresh(world, 'discovery-apex');

    expect(summary.discovery).toMatchObject({ listed: 2, incomplete: [] });
    expect(Object.keys(await makerC('discovery-apex')).sort()).toEqual([URLS_C.c1, URLS_C.c2]);
  });

  it('keeps what a sitemap quotes out of the fetch log and the step’s result', async () => {
    // The root element's name is the site's to choose, and the reason a file is refused quotes it.
    // Postgres refuses U+0000 in the log's text, and Workflows cap the size of a step's result.
    const name = `${'x'.repeat(5000)}${String.fromCodePoint(0)}y`;
    const world = await setUp('discovery-quoted');
    world.web.routes.set(SITEMAPS.products, { status: 200, body: `<${name}>z</${name}>` });
    const { summary, runId, results } = await refresh(world, 'discovery-quoted');

    const reason = `its root element is <${'x'.repeat(179)}`;
    expect(summary.discovery?.incomplete).toEqual([
      `maker-c: ${SITEMAPS.products}: not a sitemap (${reason})`,
    ]);
    const step = results.get('sitemap:maker-c:1:0') as { read: { incomplete: string } };
    expect(step.read.incomplete).toBe(`${SITEMAPS.products}: not a sitemap (${reason})`);
    const logged = await db
      .select({ error: fetches.error })
      .from(fetches)
      .where(and(eq(fetches.runId, runId), eq(fetches.url, SITEMAPS.products)));
    expect(logged).toEqual([{ error: `not a sitemap: ${reason}` }]);
  });

  it('resumes from the sitemaps it finished when a run is replayed', async () => {
    const world = await setUp('discovery-replayed');
    // What the Workflow keeps of its finished steps, which the second run replays.
    const cache: StepCache = new Map();
    const params = {
      runId: runIdFor('discovery-replayed', world.clock.now()),
      datasetId: 'discovery-replayed',
    };

    // The first run stops at the product sitemap: its request fails once, after the index was read.
    const web = world.ports.http;
    let failing = true;
    world.ports.http = {
      async get(url, headers, options) {
        if (failing && url === SITEMAPS.products) {
          failing = false;
          throw new Error('the connection was reset');
        }
        return web.get(url, headers, options);
      },
    };
    const first = fakeStep(world.clock, cache);
    await expect(runRefresh(params, first.step, world.ports)).rejects.toThrow(
      'the connection was reset',
    );
    expect(first.names).toEqual(['load', 'sitemap:maker-c:0:0', 'sitemap:maker-c:1:0', 'fail']);
    const askedBefore = world.web.requests.length;

    // The index's step comes from the cache, children and all, so the product sitemap is still read.
    const second = fakeStep(world.clock, cache);
    const summary = await runRefresh(params, second.step, world.ports);
    expect(second.replayed).toEqual(['load', 'sitemap:maker-c:0:0']);
    expect(world.web.requests.slice(askedBefore).map((sent) => sent.url)).not.toContain(
      SITEMAPS.index,
    );
    expect(summary.discovery).toEqual({
      sources: 1,
      sitemaps: 2,
      listed: 2,
      added: 2,
      revived: 0,
      missing: 0,
      gone: 0,
      incomplete: [],
    });
    const logged = await db
      .select({ url: fetches.url })
      .from(fetches)
      .where(and(eq(fetches.runId, params.runId), eq(fetches.kind, 'sitemap')));
    expect(logged.map((row) => row.url).sort()).toEqual([SITEMAPS.index, SITEMAPS.products]);
  });

  it('doesn’t ask for a sitemap robots.txt disallows, and logs it as blocked', async () => {
    const routes = sitemapRoutes();
    routes['https://maker-c.example/robots.txt'] = {
      status: 200,
      body: 'User-agent: *\nDisallow: /sitemap_products\n',
    };
    const world = await setUp('discovery-disallowed', routes);
    const { summary, runId } = await refresh(world, 'discovery-disallowed');

    const why = 'robots.txt disallows /sitemap_products_1.xml?from=1&to=9 for Spatula';
    expect(world.web.requests.map((sent) => sent.url)).not.toContain(SITEMAPS.products);
    expect(summary.discovery?.incomplete).toEqual([
      `maker-c: ${SITEMAPS.products}: blocked (${why})`,
    ]);
    const logged = await db
      .select({
        policy: fetches.policy,
        policyReason: fetches.policyReason,
        outcome: fetches.outcome,
        httpStatus: fetches.httpStatus,
      })
      .from(fetches)
      .where(and(eq(fetches.runId, runId), eq(fetches.url, SITEMAPS.products)));
    expect(logged).toEqual([
      { policy: 'denied', policyReason: why, outcome: 'blocked', httpStatus: null },
    ]);
  });

  it('logs how a missing or refused sitemap went, and marks nothing missing', async () => {
    const cases = [
      { id: 'discovery-404', reply: { status: 404 }, outcome: 'gone', error: 'HTTP 404' },
      { id: 'discovery-403', reply: { status: 403 }, outcome: 'blocked', error: 'HTTP 403' },
      {
        id: 'discovery-challenge',
        reply: { status: 200, headers: { 'cf-mitigated': 'challenge' } },
        outcome: 'blocked',
        error: 'the site answered with a challenge',
      },
    ];
    for (const { id, reply, outcome, error } of cases) {
      const world = await setUp(id, { ...sitemapRoutes(), [SITEMAPS.index]: reply });
      const { summary, names, runId } = await refresh(world, id);
      expect(summary.discovery?.incomplete).toEqual([
        `maker-c: ${SITEMAPS.index}: ${outcome} (${error})`,
      ]);
      expect(names).not.toContain('listed:maker-c');
      const logged = await db
        .select({ outcome: fetches.outcome, httpStatus: fetches.httpStatus, error: fetches.error })
        .from(fetches)
        .where(and(eq(fetches.runId, runId), eq(fetches.kind, 'sitemap')));
      expect(logged).toEqual([{ outcome, httpStatus: reply.status, error }]);
    }
  });

  it('keeps what each sitemap’s answer says of the site', async () => {
    const routes = sitemapRoutes();
    routes[SITEMAPS.products] = { status: 403, headers: { 'cf-mitigated': 'challenge' } };
    const world = await setUp('discovery-site-answers', routes);
    const run = await refresh(world, 'discovery-site-answers');
    const siteOf = (name: string) =>
      (run.results.get(name) as { kind: 'done'; read: { site?: string | null } }).read.site;
    expect(siteOf('sitemap:maker-c:0:0')).toBe('through');
    expect(siteOf('sitemap:maker-c:1:0')).toBe('refused');
  });

  it('lists what each sitemap the read asked for says of the site, in the order asked', async () => {
    const datasetId = 'discovery-sites';
    const routes = sitemapRoutes();
    routes[SITEMAPS.products] = { status: 403, headers: { 'cf-mitigated': 'challenge' } };
    const definition = testSitemapDefinition(datasetId);
    const world = await setUp(datasetId, routes);
    const runId = runIdFor(datasetId, world.clock.now());
    await startRun(db, { id: runId, datasetId });
    const source = definition.sources.find((one) => one.kind === 'sitemap')!;
    const found = await discoverSource(
      { runId, datasetId, definition, startedAt: world.clock.now() },
      source,
      fakeStep(world.clock).step,
      world.ports,
    );
    expect(found).toMatchObject({ sitemaps: 2, sites: ['through', 'refused'] });
  });

  it('puts a sitemap off while its host has a break, then reads it', async () => {
    const a = 'https://maker-c.example/sitemap-a.xml';
    const b = 'https://maker-c.example/sitemap-b.xml';
    const routes = sitemapRoutes();
    routes[a] = { status: 503 };
    routes[b] = { status: 200, body: productSitemap([{ loc: URLS_C.c1 }, { loc: URLS_C.c2 }]) };
    const world = await setUp('discovery-later', routes, (definition) => ({
      ...definition,
      sources: definition.sources.map((source) =>
        source.kind === 'sitemap' ? { ...source, sitemaps: [a, b] } : source,
      ),
    }));
    const { summary, names } = await refresh(world, 'discovery-later');

    // The 503 gives the host a break longer than a step waits, so B sleeps and is asked again.
    expect(names.filter((name) => name.startsWith('sitemap'))).toEqual([
      'sitemap:maker-c:0:0',
      'sitemap:maker-c:1:0',
      'sitemap-wait:maker-c:1:0',
      'sitemap:maker-c:1:1',
    ]);
    expect(summary.discovery).toMatchObject({
      sitemaps: 2,
      listed: 2,
      incomplete: [`maker-c: ${a}: failed (HTTP 503)`],
    });
  });

  it('lists the pages around an address too long to store', async () => {
    // Each of these characters is nine characters long once percent-encoded, so the address Spatula
    // keeps is far longer than the index on a page's address can hold. The characters differ, as
    // Postgres compresses what it can. A run that tried to store the address would fail every time.
    const characters = Array.from({ length: 1000 }, (_, n) =>
      String.fromCodePoint(0x4e00 + ((n * 7919) % 20_000)),
    );
    const long = `https://maker-c.example/products/${characters.join('')}`;
    const routes = sitemapRoutes();
    routes[SITEMAPS.products] = {
      status: 200,
      body: productSitemap([{ loc: URLS_C.c1 }, { loc: URLS_C.c2 }, { loc: long }]),
    };
    const world = await setUp('discovery-too-long', routes);
    const { summary } = await refresh(world, 'discovery-too-long');

    expect(summary.discovery).toMatchObject({ listed: 2, incomplete: [] });
    expect(summary.notes).toContain(
      `maker-c: ${SITEMAPS.products} lists 1 address on other hosts or that Spatula doesn’t fetch`,
    );
    expect(Object.keys(await makerC('discovery-too-long')).sort()).toEqual([URLS_C.c1, URLS_C.c2]);
  });

  it('keeps what a redirect quotes out of the fetch log and the summary', async () => {
    // A Location that isn't an address is quoted in the reason a read failed, and a site chooses it.
    // Postgres refuses U+0000 in the log's text, and the summary is jsonb, which refuses it too.
    const nul = String.fromCodePoint(0);
    const world = await setUp('discovery-quoted-location');
    world.web.routes.set(SITEMAPS.products, {
      status: 301,
      headers: { location: `https://${nul} bad` },
    });
    const { summary, runId, results } = await refresh(world, 'discovery-quoted-location');

    const why = 'redirected to https:// bad, which isn’t an address';
    expect(summary.discovery?.incomplete).toEqual([
      `maker-c: ${SITEMAPS.products}: failed (${why})`,
    ]);
    const step = results.get('sitemap:maker-c:1:0') as { read: { incomplete: string } };
    expect(step.read.incomplete).toBe(`${SITEMAPS.products}: failed (${why})`);
    const logged = await db
      .select({ error: fetches.error, httpStatus: fetches.httpStatus })
      .from(fetches)
      .where(and(eq(fetches.runId, runId), eq(fetches.url, SITEMAPS.products)));
    expect(logged).toEqual([{ error: why, httpStatus: 301 }]);
    expect(await getRun(db, runId)).toMatchObject({ status: 'complete' });
  });

  it('keeps what a robots.txt redirect quotes out of the fetch log', async () => {
    // The gate quotes a robots.txt redirect's address in the reason it refuses the host's requests.
    const nul = String.fromCodePoint(0);
    const routes = sitemapRoutes();
    routes['https://maker-c.example/robots.txt'] = {
      status: 301,
      headers: { location: `https://${nul} bad` },
    };
    const world = await setUp('discovery-quoted-robots', routes);
    const { summary, runId } = await refresh(world, 'discovery-quoted-robots');

    const why =
      'robots.txt is unreachable (robots.txt redirected to https:// bad, which isn’t an HTTPS address), so nothing on maker-c.example is fetched until it answers';
    expect(summary.discovery?.incomplete).toEqual([`maker-c: ${SITEMAPS.index}: failed (${why})`]);
    const logged = await db
      .select({ policy: fetches.policy, policyReason: fetches.policyReason, error: fetches.error })
      .from(fetches)
      .where(and(eq(fetches.runId, runId), eq(fetches.url, SITEMAPS.index)));
    expect(logged).toEqual([{ policy: 'denied', policyReason: why, error: why }]);
    expect(await getRun(db, runId)).toMatchObject({ status: 'complete' });
  });

  it('reads a sitemap once, however many times and however spelled the definition lists it', async () => {
    const world = await setUp('discovery-listed-twice', sitemapRoutes(), (definition) => ({
      ...definition,
      sources: definition.sources.map((source) =>
        source.kind === 'sitemap'
          ? {
              ...source,
              sitemaps: [SITEMAPS.index, SITEMAPS.index, 'https://MAKER-C.example:443/sitemap.xml'],
            }
          : source,
      ),
    }));
    const { summary, names } = await refresh(world, 'discovery-listed-twice');

    expect(world.web.requests.filter((sent) => sent.url === SITEMAPS.index)).toHaveLength(1);
    expect(names.filter((name) => name.startsWith('sitemap:'))).toEqual([
      'sitemap:maker-c:0:0',
      'sitemap:maker-c:1:0',
    ]);
    expect(summary.discovery).toMatchObject({ sitemaps: 2, listed: 2, incomplete: [] });
  });

  it('reads a gzipped sitemap whose multi-byte characters straddle the chunks it unzips in', async () => {
    // The file is far larger than a chunk of the unzipped stream, and its addresses are CJK
    // characters of three bytes each, so some chunk ends in the middle of one.
    const locs = Array.from(
      { length: 200 },
      (_, n) =>
        `https://maker-c.example/products/${Array.from({ length: 150 }, (_, i) => String.fromCodePoint(0x4e00 + n * 150 + i)).join('')}`,
    );
    const routes = sitemapRoutes();
    routes[SITEMAPS.products] = {
      status: 200,
      bytes: gzipSync(productSitemap(locs.map((loc) => ({ loc })))),
      headers: { 'content-type': 'application/gzip' },
    };
    // One page is read, since the pages themselves aren't what this is about.
    const world = await setUp('discovery-multibyte', routes, (definition) => ({
      ...definition,
      budget: { ...definition.budget, itemsPerRun: 1 },
    }));
    const { summary } = await refresh(world, 'discovery-multibyte');

    expect(summary.discovery).toMatchObject({ listed: 200, incomplete: [] });
    expect(Object.keys(await makerC('discovery-multibyte')).sort()).toEqual(
      locs.map((loc) => new URL(loc).href).sort(),
    );
  });

  it('calls a read incomplete when a text sitemap has more than 50,000 entries', async () => {
    const world = await setUp('discovery-50001');
    await refresh(world, 'discovery-50001');

    // Only the first address is a product. A file cut off at the limit may have left out the rest
    // of the products too, so this read can't say that the page it doesn't list is missing.
    const lines = [
      URLS_C.c1,
      ...Array.from({ length: 50_000 }, (_, n) => `https://maker-c.example/blog/post-${n}`),
    ];
    world.web.routes.set(SITEMAPS.products, {
      status: 200,
      body: lines.join('\n'),
      headers: { 'content-type': 'text/plain' },
    });
    const { summary, names } = await refresh(world, 'discovery-50001');

    expect(summary.discovery).toMatchObject({
      listed: 1,
      missing: 0,
      gone: 0,
      incomplete: [`maker-c: ${SITEMAPS.products}: it has more entries than a sitemap may hold`],
    });
    expect(names).not.toContain('listed:maker-c');
    const pages = await makerC('discovery-50001');
    expect(
      [URLS_C.c1, URLS_C.c2].map((url) => [pages[url]!.status, pages[url]!.missingStreak]),
    ).toEqual([
      ['live', 0],
      ['live', 0],
    ]);
  });

  it('follows the children of a child index, and counts them toward the cap', async () => {
    const child = 'https://maker-c.example/sitemap_products_index.xml';
    const grandchild = (n: number) => `https://maker-c.example/sitemap_products_g${n}.xml`;
    const notFollowed = 'https://maker-c.example/sitemap_pages_9.xml';
    // The root index names one sitemap, an index, and that names `count` more.
    const readIndexes = async (datasetId: string, count: number) => {
      const routes = sitemapRoutes();
      routes[SITEMAPS.index] = { status: 200, body: indexOf([child]) };
      routes[child] = {
        status: 200,
        body: indexOf([...Array.from({ length: count }, (_, n) => grandchild(n)), notFollowed]),
      };
      for (let n = 0; n < count; n += 1) {
        const pages = n === 0 ? [{ loc: URLS_C.c1 }, { loc: URLS_C.c2 }] : [];
        routes[grandchild(n)] = { status: 200, body: productSitemap(pages) };
      }
      const world = await setUp(datasetId, routes);
      return { world, ...(await refresh(world, datasetId)) };
    };

    // The root, the child index, and 48 more make 50 sitemaps, which the cap allows.
    const fits = await readIndexes('discovery-indexes-fit', 48);
    expect(fits.summary.discovery).toMatchObject({ sitemaps: 50, listed: 2, incomplete: [] });
    expect(fits.names.filter((name) => name.startsWith('sitemap:')).slice(0, 3)).toEqual([
      'sitemap:maker-c:0:0',
      'sitemap:maker-c:1:0',
      'sitemap:maker-c:2:0',
    ]);
    expect(fits.names).toContain('listed:maker-c');
    const asked = fits.world.web.requests.map((sent) => sent.url);
    expect(asked).toEqual(expect.arrayContaining([child, grandchild(0), grandchild(47)]));
    expect(asked).not.toContain(notFollowed);

    // One more makes 51, though neither index names more than 50.
    const over = await readIndexes('discovery-indexes-over', 49);
    expect(over.summary.discovery).toMatchObject({
      sitemaps: 50,
      listed: 2,
      incomplete: ['maker-c: it names more than 50 sitemaps'],
    });
    expect(over.names).not.toContain('listed:maker-c');
  });

  it('calls a body with a gzip header that doesn’t unzip a failed read', async () => {
    const world = await setUp('discovery-bad-gzip');
    await refresh(world, 'discovery-bad-gzip');

    const whole = gzipSync(productSitemap([{ loc: URLS_C.c1 }, { loc: URLS_C.c2 }]));
    const bodies = {
      'a header and then no deflate stream': Buffer.concat([
        whole.subarray(0, 10),
        Buffer.from('this is not what a deflate stream looks like'),
      ]),
      'a file cut off before its end': whole.subarray(0, whole.length - 12),
    };
    for (const bytes of Object.values(bodies)) {
      world.web.routes.set(SITEMAPS.products, {
        status: 200,
        bytes,
        headers: { 'content-type': 'application/gzip' },
      });
      const { summary, names, runId } = await refresh(world, 'discovery-bad-gzip');

      expect(summary.discovery?.incomplete).toEqual([
        expect.stringContaining(`maker-c: ${SITEMAPS.products}: failed (not gzip that unzips: `),
      ]);
      expect(names).not.toContain('listed:maker-c');
      const logged = await db
        .select({ outcome: fetches.outcome, httpStatus: fetches.httpStatus, error: fetches.error })
        .from(fetches)
        .where(and(eq(fetches.runId, runId), eq(fetches.url, SITEMAPS.products)));
      expect(logged).toEqual([
        {
          outcome: 'failed',
          httpStatus: 200,
          error: expect.stringMatching(/^not gzip that unzips: /u),
        },
      ]);
    }
    const pages = await makerC('discovery-bad-gzip');
    expect(
      [URLS_C.c1, URLS_C.c2].map((url) => [pages[url]!.status, pages[url]!.missingStreak]),
    ).toEqual([
      ['live', 0],
      ['live', 0],
    ]);
  });

  it('reads a listed page once, and again only when its lastmod moves', async () => {
    const world = await setUp('discovery-lastmod');
    const first = await refresh(world, 'discovery-lastmod');
    // Maker C's pages extract like the other makers'.
    expect(first.summary.llm).toMatchObject({ ran: 5, failed: 0 });

    const second = await refresh(world, 'discovery-lastmod');
    expect(second.summary).toMatchObject({ items: 0, due: 0, live: 5 });

    world.web.routes.set(SITEMAPS.products, {
      status: 200,
      body: productSitemap([{ loc: URLS_C.c1, lastmod: '2026-10-11' }, { loc: URLS_C.c2 }]),
    });
    const third = await refresh(world, 'discovery-lastmod');
    expect(third.summary).toMatchObject({ items: 1, due: 1, live: 5 });
    const read = await db
      .select({ url: fetches.url })
      .from(fetches)
      .where(and(eq(fetches.runId, third.runId), eq(fetches.kind, 'page')));
    expect(read).toEqual([{ url: URLS_C.c1 }]);
  });

  it('follows a redirect that keeps the page’s name, and calls one that leaves it gone', async () => {
    // A store may send a region to a path of its own, as /en-gb/products/c1, which the source's
    // patterns don't list. That is the same page. A collection or the home page is not.
    const cases = [
      { name: 'c1', to: '/en-gb/products/c1', away: false },
      { name: 'c2', to: '/en-gb/products/c2/', away: false },
      { name: 'caf%C3%A9', to: '/en-gb/products/caf%c3%a9', away: false },
      { name: 'old', to: '/products/new', away: false },
      { name: 'collection', to: '/collections/all', away: true },
      { name: 'home', to: '/', away: true },
    ];
    const address = (path: string) => `https://maker-c.example${path}`;
    const routes = sitemapRoutes();
    routes[SITEMAPS.products] = {
      status: 200,
      body: productSitemap(cases.map((one) => ({ loc: address(`/products/${one.name}`) }))),
    };
    for (const one of cases) {
      routes[address(`/products/${one.name}`)] = { status: 301, headers: { location: one.to } };
      routes[address(one.to)] = { status: 200, body: C1() };
    }
    const world = await setUp('discovery-regions', routes);
    const reads = async (runId: string) =>
      Object.fromEntries(
        (
          await db
            .select({ url: fetches.url, outcome: fetches.outcome, finalUrl: fetches.finalUrl })
            .from(fetches)
            .where(and(eq(fetches.runId, runId), eq(fetches.kind, 'page')))
        ).map((row) => [row.url, row]),
      );

    const first = await refresh(world, 'discovery-regions');
    const read = await reads(first.runId);
    for (const one of cases) {
      const url = address(`/products/${one.name}`);
      expect(read[url], one.name).toMatchObject({
        outcome: one.away ? 'gone' : 'changed',
        finalUrl: address(one.to),
      });
    }

    // Two redirects away in a row make a page gone, as two 404s do. The followed pages stay live.
    await refresh(world, 'discovery-regions');
    const pages = await makerC('discovery-regions');
    for (const one of cases) {
      const row = pages[address(`/products/${one.name}`)];
      expect(row?.status, one.name).toBe(one.away ? 'gone' : 'live');
    }
  });

  it('reads at most 50 sitemaps, and keeps an index’s long list of children out of its step', async () => {
    const children = Array.from(
      { length: 60 },
      (_, n) => `https://maker-c.example/sitemap_products_${n + 1}.xml`,
    );
    const routes = sitemapRoutes();
    routes[SITEMAPS.index] = {
      status: 200,
      body:
        '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        children.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join('') +
        '</sitemapindex>',
    };
    for (const loc of children) routes[loc] = { status: 200, body: productSitemap([]) };
    routes[children[0]!] = {
      status: 200,
      body: productSitemap([{ loc: URLS_C.c1 }, { loc: URLS_C.c2 }]),
    };
    const world = await setUp('discovery-many', routes);
    const { summary, names, results } = await refresh(world, 'discovery-many');

    expect(summary.discovery).toMatchObject({
      sitemaps: 50,
      listed: 2,
      incomplete: ['maker-c: it names more than 50 sitemaps'],
    });
    expect(names.filter((name) => name.startsWith('sitemap:'))).toHaveLength(50);
    expect(names).not.toContain('listed:maker-c');
    // Workflows cap a step's result, and an index may name 50,000 sitemaps. No more than the
    // fifty that can be read are needed, and one more shows that there were too many.
    const index = results.get('sitemap:maker-c:0:0') as { read: { children: string[] } };
    expect(index.read.children).toEqual(children.slice(0, 51));
  });
});
