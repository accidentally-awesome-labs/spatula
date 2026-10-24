import {
  extractFromPage,
  legacyLlmInputHash,
  llmFields,
  llmInputHash,
  normalizeGtin,
  parseDefinition,
  parsePage,
  runIdFor,
  type Candidate,
  type GateDecision,
  type LlmPort,
  type Page,
  type PagesSource,
} from '@spatula/core';
import { packs } from '@spatula/pack-products';
import { applyDefinition, fetches, getRun, items, listLiveItems, statements } from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import {
  fakeLlm,
  fakeStep,
  makeWorld,
  testModelSetup,
  type StepCache,
  type World,
} from '../test/node/fakes';
import { entityOf, fetchOf, published, refresh } from '../test/node/runs';
import {
  A1,
  A2,
  answerFor,
  B1,
  productPage,
  standardRoutes,
  URLS,
  type Reply,
} from '../test/pages';
import {
  classifyResponse,
  DatasetMissingError,
  extractionTag,
  MAX_NOTES,
  MAX_PAGE_STATEMENTS,
  runRefresh,
  type HttpResult,
  type StepRunner,
} from './refresh';
import { LlmHttpError } from './llm-openai';
import { MAX_REDIRECTS, MAX_WAITS, requestThroughGate } from './requests';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A new dataset from the test definition, and a world whose pages answer as `routes` say. */
async function setUp(
  datasetId: string,
  routes = standardRoutes(),
  options: { llm?: boolean } = {},
) {
  await applyDefinition(db, testDefinition(datasetId));
  const world = makeWorld(db, routes, options);
  const [a1, a2, b1] = await listLiveItems(db, datasetId);
  return { world, a1: a1!, a2: a2!, b1: b1! };
}

/** When each of an item's current statements was last seen, as ISO text, in order. */
const lastSeenOf = async (itemId: string) =>
  (
    await db
      .select({ lastSeen: statements.lastSeen })
      .from(statements)
      .where(and(eq(statements.itemId, itemId), isNull(statements.withdrawnAt)))
  )
    .map((row) => row.lastSeen.toISOString())
    .sort();

/** The products pack, with what it finds changed for the pages `alter` picks, so a page can misbehave. */
function alterPack(world: World, alter: (page: Page, found: Candidate[]) => Candidate[]) {
  const real = packs['products/product']!;
  world.ports.packs = {
    ...packs,
    'products/product': { ...real, extract: (page) => alter(page, real.extract(page)) },
  };
}

/** Applies the test definition with maker-a listing these pages, and returns their addresses. */
async function makerAPages(datasetId: string, names: string[]): Promise<string[]> {
  const base = testDefinition(datasetId);
  const pages = names.map((name) => `https://maker-a.example/products/${name}`);
  await applyDefinition(db, {
    ...base,
    sources: base.sources.map((source) =>
      source.id === 'maker-a' && source.kind === 'pages' ? { ...source, pages } : source,
    ),
  });
  return pages;
}

/**
 * Has the web answer each of these pages with `reply` while `strain.on` holds; every other request
 * goes on to the world's web. `asked` lists every page asked for, answered or not.
 */
function straining(world: World, pages: string[], reply: HttpResult) {
  const strain = { on: true };
  const asked: string[] = [];
  const web = world.ports.http;
  world.ports.http = {
    async get(url, headers, options) {
      asked.push(url);
      if (strain.on && pages.includes(url)) return reply;
      return web.get(url, headers, options);
    },
  };
  return { strain, asked };
}

/**
 * What a page's fetch step returned in a run: its last attempt's, since a page that waited behind
 * its host's break took more than one. Undefined when no attempt finished.
 */
function lastFetched(run: { results: Map<string, unknown> }, itemId: string) {
  const attempts = [...run.results.keys()].filter((name) => name.startsWith(`fetch:${itemId}:`));
  const result = run.results.get(attempts.at(-1) ?? '') as
    | { kind: 'done'; fetched: { site?: string | null; hostAnswered: boolean; outcome: string } }
    | { kind: 'later' }
    | undefined;
  return result?.kind === 'done' ? result.fetched : undefined;
}

describe('runRefresh', () => {
  it('collects, identifies, and publishes, then publishes nothing when nothing changed', async () => {
    const { world, a1, a2, b1 } = await setUp('refresh-basics');

    const first = await refresh(world, 'refresh-basics');
    expect(first.names).toEqual([
      'load',
      'plan',
      'items:0',
      `fetch:${a1.id}:0`,
      `extract:${a1.id}`,
      `fetch:${b1.id}:0`,
      `extract:${b1.id}`,
      `fetch:${a2.id}:0`,
      `extract:${a2.id}`,
      'sources',
      'resolve',
      'snapshot',
      'captures',
      'finish',
    ]);
    expect(first.summary).toMatchObject({
      items: 3,
      live: 3,
      due: 3,
      fetches: { changed: 3, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
      statements: { added: 19, reseen: 0, withdrawn: 0 },
      llm: { ran: 3, reused: 0, skipped: 0, failed: 0, inputTokens: 3000, outputTokens: 150 },
      entities: { created: 3, linked: 0, conflicts: 0, unresolved: 0 },
      snapshot: { published: true, generation: 1, records: 3, excluded: [] },
    });
    expect(first.summary.notes).toEqual([`${URLS.b1}: dropped 1 of the LLM’s values`]);

    const file = (await published(world, 'refresh-basics'))!;
    expect(file.row).toMatchObject({ generation: 1, runId: first.runId, recordCount: 3 });
    expect(file.snapshot).toMatchObject({ project: 'refresh-basics', generation: 1 });
    // The UPC in A1's mpn is published as a GTIN, never as a part number.
    expect(file.byName.A1!.fields).toEqual({
      brand: 'Maker A',
      name: 'A1',
      category: 'Headphones',
      gtins: ['00036000291452'],
      officialUrl: URLS.a1,
      specs: [
        { label: 'Impedance', value: '300 Ω' },
        { label: 'Weight', value: '350 g' },
      ],
    });
    expect(file.byName.A1!.provenance.gtins).toMatchObject({
      sourceUrl: URLS.a1,
      method: 'jsonld',
      confidence: 0.8,
    });
    expect(file.byName.A2!.fields).toMatchObject({ gtins: ['04006381333931'], mpns: ['A2-100'] });
    // B1's name comes from the element its source declares, not from the padded og:title.
    expect(file.byName['B1 Amp']!.fields).toMatchObject({
      brand: 'Maker B',
      category: 'DAC/Amp',
      specs: [{ label: 'Output power', value: '1 W' }],
    });
    expect(file.byName.A1!.canonicalId).toBe(await entityOf(a1.id));

    // A1 hasn't changed, A2's HTML has but its text hasn't, and B1's server is struggling.
    world.web.routes.set(URLS.a1, { status: 304 });
    world.web.routes.set(URLS.a2, { status: 200, body: A2('two') });
    world.web.routes.set(URLS.b1, { status: 503 });
    const second = await refresh(world, 'refresh-basics');
    expect(second.summary).toMatchObject({
      fetches: { changed: 1, unchanged: 1, gone: 0, failed: 1, blocked: 0 },
      statements: { added: 0, reseen: 14, withdrawn: 0 },
      llm: { ran: 0, reused: 1, skipped: 0, failed: 0, inputTokens: 0 },
      snapshot: { published: false, reason: 'nothing changed since generation 1' },
    });
    expect(second.summary.notes).toEqual([`${URLS.b1}: failed (HTTP 503)`]);
    // A2's text was the same, so the LLM wasn't asked again.
    expect(world.llm.calls).toHaveLength(3);
    const a1Requests = world.web.requests.filter((sent) => sent.url === URLS.a1);
    expect(a1Requests.at(-1)!.headers).toEqual({ 'if-none-match': '"a1-v1"' });
  });

  it('fetches nothing from a host whose robots.txt fails, and keeps its values', async () => {
    const { world } = await setUp('refresh-robots-down');
    await refresh(world, 'refresh-robots-down');

    world.clock.advance(25 * HOUR);
    world.web.routes.set('https://maker-b.example/robots.txt', { status: 503 });
    const before = world.web.requests.length;
    const second = await refresh(world, 'refresh-robots-down');
    const asked = world.web.requests.slice(before).map((sent) => sent.url);
    // robots.txt was asked for, and the page wasn't.
    expect(asked).toContain('https://maker-b.example/robots.txt');
    expect(asked).not.toContain(URLS.b1);
    expect(second.summary.fetches).toMatchObject({ unchanged: 2, failed: 1 });
    expect(second.summary.notes).toEqual([
      expect.stringContaining(`${URLS.b1}: failed (robots.txt is unreachable`),
    ]);
    expect(second.summary.snapshot).toMatchObject({
      published: false,
      reason: 'nothing changed since generation 1',
    });
    expect(await fetchOf(second.runId, URLS.b1)).toMatchObject({
      policy: 'denied',
      outcome: 'failed',
      httpStatus: null,
    });
    expect((await published(world, 'refresh-robots-down'))!.byName['B1 Amp']).toBeDefined();
  });

  it('records a page robots.txt disallows as blocked, without asking for it', async () => {
    const routes = standardRoutes();
    routes['https://maker-a.example/robots.txt'] = {
      status: 200,
      body: 'User-agent: *\nDisallow: /products/a2\n',
    };
    const { world } = await setUp('refresh-disallowed', routes);
    const first = await refresh(world, 'refresh-disallowed');
    expect(world.web.requests.map((sent) => sent.url)).not.toContain(URLS.a2);
    expect(first.summary).toMatchObject({
      fetches: { changed: 2, blocked: 1 },
      entities: { created: 2, unresolved: 1 },
      snapshot: { published: true, records: 2 },
    });
    expect(await fetchOf(first.runId, URLS.a2)).toMatchObject({
      policy: 'denied',
      outcome: 'blocked',
      policyReason: 'robots.txt disallows /products/a2 for Spatula',
    });
  });

  it('asks the LLM only where the site allows AI input', async () => {
    const routes = standardRoutes();
    routes['https://maker-a.example/robots.txt'] = {
      status: 200,
      body: 'User-agent: *\nContent-Signal: search=yes, ai-input=no\nAllow: /\n',
    };
    const { world } = await setUp('refresh-signals', routes);
    const first = await refresh(world, 'refresh-signals');
    expect(first.summary.llm).toMatchObject({ ran: 1, skipped: 2 });
    expect(world.llm.calls).toEqual([expect.stringContaining(URLS.b1)]);
    expect(await fetchOf(first.runId, URLS.a1)).toMatchObject({
      llm: 'skipped: the site says ai-input=no',
      signals: { search: 'yes', 'ai-input': 'no' },
    });
    // A1 is still published, without the specs only the LLM could read.
    expect((await published(world, 'refresh-signals'))!.byName.A1!.fields).not.toHaveProperty(
      'specs',
    );
  });

  it('skips the LLM when none is configured', async () => {
    const { world } = await setUp('refresh-no-llm', standardRoutes(), { llm: false });
    const first = await refresh(world, 'refresh-no-llm');
    expect(first.summary.llm).toMatchObject({ ran: 0, skipped: 3 });
    expect(first.summary.snapshot).toMatchObject({ published: true, records: 3 });
  });

  it('calls a page gone after two 404s, and stops asking for it', async () => {
    const { world, a2 } = await setUp('refresh-gone');
    await refresh(world, 'refresh-gone');
    world.web.routes.delete(URLS.a2);

    const second = await refresh(world, 'refresh-gone');
    expect(second.summary.fetches).toMatchObject({ gone: 1 });
    // One 404 could be a mistake, so A2 stays published.
    expect(second.summary.snapshot).toMatchObject({ published: false });

    const third = await refresh(world, 'refresh-gone');
    expect(third.summary.snapshot).toMatchObject({ published: true, generation: 2, records: 2 });
    expect((await published(world, 'refresh-gone'))!.byName.A2).toBeUndefined();

    const fourth = await refresh(world, 'refresh-gone');
    expect(fourth.summary.items).toBe(2);
    expect(fourth.names).not.toContain(`fetch:${a2.id}:0`);
  });

  it('follows redirects through the gate, but only to HTTPS', async () => {
    const routes = standardRoutes();
    routes[URLS.a1] = { status: 301, headers: { location: '/products/a1-new' } };
    routes['https://maker-a.example/products/a1-new'] = { status: 200, body: A1() };
    routes[URLS.a2] = { status: 302, headers: { location: 'http://maker-a.example/products/a2' } };
    const { world } = await setUp('refresh-redirects', routes);
    const first = await refresh(world, 'refresh-redirects');
    expect(first.summary.fetches).toMatchObject({ changed: 2, failed: 1 });
    expect(await fetchOf(first.runId, URLS.a1)).toMatchObject({
      outcome: 'changed',
      finalUrl: 'https://maker-a.example/products/a1-new',
      httpStatus: 200,
    });
    expect(await fetchOf(first.runId, URLS.a2)).toMatchObject({
      outcome: 'failed',
      error: 'redirected to http://maker-a.example/products/a2, which isn’t HTTPS',
    });
    // The LLM is told the page that was listed, not where the site sent the request: that address
    // is the site's text, and it would sit outside the wrapper around untrusted content.
    expect(world.llm.calls).toContainEqual(expect.stringContaining(`Page address: ${URLS.a1}\n`));
    expect(world.llm.calls.join('\n')).not.toContain('a1-new');
  });

  it('follows a redirect on the same host when its interval is longer than a step waits', async () => {
    // Every hop waits a full 20 s after the answer before it, which a step may not wait (15 s), so
    // each hop is put off. A hop that was put off is asked for again where it left off: the page
    // that redirected is not asked for a second time, which would only be put off again.
    const base = testDefinition('refresh-slow-redirect');
    await applyDefinition(db, { ...base, policy: { ...base.policy, perHostIntervalMs: 20_000 } });
    const moved = 'https://maker-a.example/products/a1-new';
    const routes = standardRoutes();
    routes[URLS.a1] = { status: 301, headers: { location: '/products/a1-new' } };
    routes[moved] = { status: 200, body: A1() };
    const world = makeWorld(db, routes, { llm: false });
    const [a1] = await listLiveItems(db, 'refresh-slow-redirect');
    const run = await refresh(world, 'refresh-slow-redirect', {});

    const asked = world.web.requests.map((sent) => sent.url);
    expect(asked.filter((url) => url === URLS.a1)).toHaveLength(1);
    expect(asked.filter((url) => url === moved)).toHaveLength(1);
    expect(run.names.filter((name) => name.includes(a1!.id))).toEqual([
      `fetch:${a1!.id}:0`,
      `wait:${a1!.id}:0`,
      `fetch:${a1!.id}:1`,
      `wait:${a1!.id}:1`,
      `fetch:${a1!.id}:2`,
      `extract:${a1!.id}`,
    ]);
    expect(await fetchOf(run.runId, URLS.a1)).toMatchObject({
      outcome: 'changed',
      finalUrl: moved,
      httpStatus: 200,
    });
    expect(run.summary.fetches).toMatchObject({ changed: 3, failed: 0 });
  });

  it('keeps what a redirect quotes out of the fetch log, the step’s result, and the summary', async () => {
    // A Location that isn't an address is quoted in the reason a fetch failed, and the site chose
    // it. Postgres refuses U+0000 in the log's text and in the summary's jsonb, and a step's result
    // is kept by Workflows, so the text is clean and short where it is made.
    const nul = String.fromCodePoint(0);
    const routes = standardRoutes();
    routes[URLS.a1] = {
      status: 301,
      headers: { location: `https://${nul} bad ${'x'.repeat(600)}` },
    };
    const { world, a1 } = await setUp('refresh-quoted-location', routes);
    const first = await refresh(world, 'refresh-quoted-location');

    const why = `redirected to https:// bad ${'x'.repeat(600)}, which isn’t an address`.slice(
      0,
      500,
    );
    expect(await fetchOf(first.runId, URLS.a1)).toMatchObject({
      outcome: 'failed',
      httpStatus: 301,
      error: why,
    });
    const note = `${URLS.a1}: failed (${why})`.slice(0, 500);
    const step = first.results.get(`fetch:${a1.id}:0`) as { fetched: { note: string } };
    expect(step.fetched.note).toBe(note);
    expect(first.summary.notes).toContain(note);
    expect(await getRun(db, first.runId)).toMatchObject({ status: 'complete' });
  });

  it('keeps what a robots.txt redirect quotes out of the fetch log', async () => {
    // The gate quotes the address a robots.txt redirected to in the reason it refuses the host.
    const nul = String.fromCodePoint(0);
    const routes = standardRoutes();
    routes['https://maker-b.example/robots.txt'] = {
      status: 301,
      headers: { location: `https://${nul} bad` },
    };
    const { world } = await setUp('refresh-quoted-robots', routes);
    const first = await refresh(world, 'refresh-quoted-robots');

    const why =
      'robots.txt is unreachable (robots.txt redirected to https:// bad, which isn’t an HTTPS address), so nothing on maker-b.example is fetched until it answers';
    expect(await fetchOf(first.runId, URLS.b1)).toMatchObject({
      policy: 'denied',
      policyReason: why,
      outcome: 'failed',
    });
    expect(first.summary.notes).toContain(`${URLS.b1}: failed (${why})`);
    expect(await getRun(db, first.runId)).toMatchObject({ status: 'complete' });
  });

  it('puts a page off while its host has a break, then fetches it', async () => {
    const routes = standardRoutes();
    routes[URLS.a1] = { status: 503 };
    const { world, a2 } = await setUp('refresh-later', routes);
    const first = await refresh(world, 'refresh-later');
    expect(first.names).toEqual(
      expect.arrayContaining([
        `fetch:${a2.id}:0`,
        `wait:${a2.id}:0`,
        `fetch:${a2.id}:1`,
        `extract:${a2.id}`,
      ]),
    );
    expect(first.summary.fetches).toMatchObject({ changed: 2, failed: 1 });
  });

  it('leaves out a record whose declared element disappears, and says which field it lacks', async () => {
    const { world, b1 } = await setUp('refresh-lost-name');
    await refresh(world, 'refresh-lost-name');
    world.web.routes.set(URLS.b1, { status: 200, body: B1('<h2>B1 Amp</h2>') });

    const second = await refresh(world, 'refresh-lost-name');
    // The name isn't taken from og:title; the record is left out and listed.
    expect(second.summary.snapshot).toEqual({
      published: true,
      generation: 2,
      snapshotId: expect.stringMatching(/^sn_/u),
      records: 2,
      excluded: [{ canonicalId: await entityOf(b1.id), missing: ['name'] }],
    });
    const file = (await published(world, 'refresh-lost-name'))!;
    expect(JSON.stringify(file.snapshot)).not.toContain('Desktop Amplifier');
  });

  it('re-extracts stored pages when the definition changes, without asking the LLM again', async () => {
    const { world } = await setUp('refresh-revised');
    await refresh(world, 'refresh-revised');

    const revised = testDefinition('refresh-revised');
    revised.sources[0] = {
      ...revised.sources[0]!,
      fixed: { ...revised.sources[0]!.fixed, category: 'DAC/Amp' },
    };
    await applyDefinition(db, revised);
    world.web.routes.set(URLS.a1, { status: 304 });
    const second = await refresh(world, 'refresh-revised');
    expect(second.summary).toMatchObject({
      fetches: { unchanged: 3 },
      statements: { added: 2, reseen: 17, withdrawn: 2 },
      llm: { ran: 0, reused: 3 },
      snapshot: { published: true, generation: 2, records: 3 },
    });
    expect(world.llm.calls).toHaveLength(3);
    expect((await published(world, 'refresh-revised'))!.byName.A1!.fields).toMatchObject({
      category: 'DAC/Amp',
    });
  });

  it('fails the run when the dataset doesn’t exist', async () => {
    const world = makeWorld(db, standardRoutes());
    const { step, names } = fakeStep(world.clock);
    await expect(
      runRefresh(
        { runId: 'refresh-missing-202610100000', datasetId: 'refresh-missing' },
        step,
        world.ports,
      ),
    ).rejects.toBeInstanceOf(DatasetMissingError);
    expect(names).toEqual(['load', 'fail']);
  });

  it('asks the LLM again after it failed, even when the page is unchanged', async () => {
    const { world } = await setUp('refresh-llm-retry');
    let failing = true;
    const scripted = fakeLlm((user) =>
      failing && user.includes(URLS.a1) ? { specs: 'not a list' } : answerFor(user),
    );
    world.ports.llm = scripted.llm;

    const first = await refresh(world, 'refresh-llm-retry');
    expect(first.summary.llm).toMatchObject({ ran: 2, failed: 1 });
    expect(first.summary.notes).toContain(`${URLS.a1}: the LLM’s answer didn’t fit the schema`);
    expect((await published(world, 'refresh-llm-retry'))!.byName.A1!.fields).not.toHaveProperty(
      'specs',
    );

    // A1's page is unchanged, but the LLM never read it, so the stored copy is read again.
    failing = false;
    world.web.routes.set(URLS.a1, { status: 304 });
    const second = await refresh(world, 'refresh-llm-retry');
    expect(second.summary).toMatchObject({
      fetches: { unchanged: 3 },
      llm: { ran: 1, reused: 0, skipped: 0, failed: 0 },
      snapshot: { published: true, generation: 2, records: 3 },
    });
    expect((await published(world, 'refresh-llm-retry'))!.byName.A1!.fields).toMatchObject({
      specs: [
        { label: 'Impedance', value: '300 Ω' },
        { label: 'Weight', value: '350 g' },
      ],
    });
  });

  it('withdraws what the LLM read once a site says ai-input=no', async () => {
    const { world, a1, a2 } = await setUp('refresh-consent-withdrawn');
    await refresh(world, 'refresh-consent-withdrawn');

    // A day later maker-a's robots.txt says no to AI input. A1 answers 304 and A2's page is the
    // same bytes, so neither changed, yet what the LLM read from them is withdrawn. Maker-b still
    // allows it, so B1 is only re-seen.
    world.clock.advance(25 * HOUR);
    world.web.routes.set('https://maker-a.example/robots.txt', {
      status: 200,
      body: 'User-agent: *\nContent-Signal: ai-input=no\nAllow: /\n',
    });
    world.web.routes.set(URLS.a1, { status: 304 });
    const second = await refresh(world, 'refresh-consent-withdrawn');
    expect(second.summary).toMatchObject({
      fetches: { unchanged: 3 },
      // A1 and A2 are read from their stored copies: A1 re-sees its 5 page statements and loses
      // its 2 specs, and A2 re-sees its 6 and loses its 1. B1 re-sees its 4 and its 1 spec.
      statements: { added: 0, reseen: 16, withdrawn: 3 },
      llm: { ran: 0, reused: 0, skipped: 2, failed: 0 },
      snapshot: { published: true, generation: 2, records: 3 },
    });
    expect(await fetchOf(second.runId, URLS.a1)).toMatchObject({
      outcome: 'unchanged',
      llm: 'skipped: the site says ai-input=no',
    });
    const file = (await published(world, 'refresh-consent-withdrawn'))!;
    expect(file.byName.A1!.fields).not.toHaveProperty('specs');
    expect(file.byName.A2!.fields).not.toHaveProperty('specs');
    expect(file.byName['B1 Amp']!.fields).toMatchObject({
      specs: [{ label: 'Output power', value: '1 W' }],
    });

    // That happens once: the question's hash is cleared, so the pages are current again.
    const third = await refresh(world, 'refresh-consent-withdrawn');
    expect(third.names).not.toContain(`extract:${a1.id}`);
    expect(third.names).not.toContain(`extract:${a2.id}`);
    expect(third.summary).toMatchObject({
      statements: { added: 0, reseen: 16, withdrawn: 0 },
      snapshot: { published: false, reason: 'nothing changed since generation 2' },
    });
  });

  it('withdraws what the page and the LLM said of a field that left the record type', async () => {
    const base = testDefinition('refresh-field-removed');
    const product = base.recordTypes.product!;
    const without = <T>(values: Record<string, T>, name: string) =>
      Object.fromEntries(Object.entries(values).filter(([key]) => key !== name));
    // The LLM fills a second field, and each page's canonical address is read into officialUrl.
    await applyDefinition(db, {
      ...base,
      recordTypes: {
        product: {
          ...product,
          fields: { ...product.fields, extras: { ...product.fields.specs!, llm: true } },
        },
      },
    });
    const world = makeWorld(db, standardRoutes());
    world.ports.llm = fakeLlm((user) => {
      const given = answerFor(user);
      return given === null ? null : { ...given, extras: given.specs };
    }).llm;
    const [a1] = await listLiveItems(db, 'refresh-field-removed');
    const said = async () =>
      [
        ...new Set(
          (
            await db
              .select({ property: statements.property, method: statements.method })
              .from(statements)
              .where(and(eq(statements.itemId, a1!.id), isNull(statements.withdrawnAt)))
          )
            .filter((row) => ['extras', 'officialUrl'].includes(row.property))
            .map((row) => `${row.property}/${row.method}`),
        ),
      ].sort();
    await refresh(world, 'refresh-field-removed');
    expect(await said()).toEqual(['extras/llm', 'officialUrl/rule']);

    // A new revision has neither field. With no field left to the cascade, the page and the LLM
    // each speak for every statement they gave, so both are withdrawn.
    const revised = parseDefinition({
      ...base,
      recordTypes: { product: { ...product, fields: without(product.fields, 'officialUrl') } },
      sources: base.sources.map((source) => ({
        ...source,
        extract: without(source.extract, 'officialUrl'),
      })),
    });
    if (!revised.ok) throw new Error(revised.issues.join('\n'));
    await applyDefinition(db, revised.definition);
    await refresh(world, 'refresh-field-removed');
    expect(await said()).toEqual([]);
  });

  it('notes a page that can’t be read, and reads it next time', async () => {
    const { world, a1 } = await setUp('refresh-unreadable');
    alterPack(world, (page, found) => {
      if (page.url === URLS.a1) throw new Error('boom');
      return found;
    });

    // One page that can't be read costs only itself: the run still completes.
    const first = await refresh(world, 'refresh-unreadable');
    expect(first.names).toContain('finish');
    expect(first.names).not.toContain('fail');
    expect((await getRun(db, first.runId))!.status).toBe('complete');
    expect(first.summary.notes).toContain(`${URLS.a1}: the page couldn’t be read: boom`);
    expect(first.summary).toMatchObject({
      fetches: { changed: 3 },
      statements: { added: 12, reseen: 0, withdrawn: 0 },
      llm: { ran: 2, skipped: 1 },
      entities: { created: 2, unresolved: 1 },
      snapshot: { published: true, generation: 1, records: 2 },
    });
    // No statement was written for A1, and it's marked for another try rather than as read.
    expect(await db.select().from(statements).where(eq(statements.itemId, a1.id))).toEqual([]);
    const unread = (await listLiveItems(db, 'refresh-unreadable')).find(
      (item) => item.id === a1.id,
    )!;
    expect(unread.extractedWith).toBe(`${extractionTag(1)}.retry`);

    // The page answers 304 and is still not current, so its stored copy is read again.
    world.ports.packs = packs;
    world.web.routes.set(URLS.a1, { status: 304 });
    const second = await refresh(world, 'refresh-unreadable');
    expect(second.names).toContain(`extract:${a1.id}`);
    expect(second.summary).toMatchObject({
      fetches: { unchanged: 3 },
      statements: { added: 7, reseen: 12, withdrawn: 0 },
      llm: { ran: 1 },
      entities: { created: 1, unresolved: 0 },
      snapshot: { published: true, generation: 2, records: 3 },
    });
  });

  it('tries again a page that stopped being readable', async () => {
    const { world, a1 } = await setUp('refresh-unreadable-again');
    await refresh(world, 'refresh-unreadable-again');
    const readAt = await lastSeenOf(a1.id);

    // A1 was read and is current. Then its HTML changes into something the pack can't read.
    alterPack(world, (page, found) => {
      if (page.url === URLS.a1) throw new Error('boom');
      return found;
    });
    world.web.routes.set(URLS.a1, { status: 200, body: A1('two') });
    const second = await refresh(world, 'refresh-unreadable-again');
    expect(second.summary.notes).toContain(`${URLS.a1}: the page couldn’t be read: boom`);
    // Its old statements stay as they were: A2's 7 and B1's 5 are the only ones re-seen.
    expect(second.summary.statements).toMatchObject({ added: 0, reseen: 12, withdrawn: 0 });

    // The same bytes again, with the pack still failing. The page isn't current, so it's tried
    // and noted again, and its old statements aren't re-seen as if it had been read.
    const third = await refresh(world, 'refresh-unreadable-again');
    expect(third.names).toContain(`extract:${a1.id}`);
    expect(third.summary.notes).toContain(`${URLS.a1}: the page couldn’t be read: boom`);
    expect(third.summary).toMatchObject({
      fetches: { unchanged: 3 },
      statements: { added: 0, reseen: 12, withdrawn: 0 },
      snapshot: { published: false, reason: 'nothing changed since generation 1' },
    });
    expect(await lastSeenOf(a1.id)).toEqual(readAt);

    // The retry mark is on the page, and the fetch log says why nothing was read.
    const marked = (await listLiveItems(db, 'refresh-unreadable-again')).find(
      (item) => item.id === a1.id,
    )!;
    expect(marked.extractedWith).toBe(`${extractionTag(1)}.retry`);
    expect(await fetchOf(third.runId, URLS.a1)).toMatchObject({
      llm: 'skipped: the page wasn’t read',
    });
  });

  it('reads a changed page next time if its extraction failed', async () => {
    const { world, a1 } = await setUp('refresh-changed-unread');
    // The LLM reads the weight off the page, so it says 360 g once the page does.
    const weights = fakeLlm((user) =>
      user.includes('Weight: 360 g')
        ? {
            specs: [
              { label: 'Impedance', value: '300 Ω' },
              { label: 'Weight', value: '360 g' },
            ],
          }
        : answerFor(user),
    );
    world.ports.llm = weights.llm;
    await refresh(world, 'refresh-changed-unread');

    // A1's weight changes, and the blob store is down when the extract step reads the new copy.
    // The fetch step has stored the new page's hash by then, so the run fails with A1 half done.
    world.web.routes.set(URLS.a1, {
      status: 200,
      body: A1().replace('Weight: 350 g', 'Weight: 360 g'),
    });
    const blobs = world.ports.blobs;
    world.ports.blobs = {
      ...blobs,
      async get() {
        throw new Error('the blob store is down');
      },
    };
    await expect(refresh(world, 'refresh-changed-unread')).rejects.toThrow(
      'the blob store is down',
    );
    world.ports.blobs = blobs;
    world.clock.advance(5 * 60_000);

    // The same bytes again. The page was never read, so it isn't current: it's read now, and
    // what it says comes from this fetch, rather than the old 350 g being re-seen as fresh.
    const third = await refresh(world, 'refresh-changed-unread');
    expect(third.summary).toMatchObject({
      fetches: { unchanged: 3 },
      statements: { added: 1, reseen: 18, withdrawn: 1 },
      llm: { ran: 1 },
      snapshot: { published: true, generation: 2, records: 3 },
    });
    expect(third.names).toContain(`extract:${a1.id}`);
    expect((await published(world, 'refresh-changed-unread'))!.byName.A1!.fields).toMatchObject({
      specs: [
        { label: 'Impedance', value: '300 Ω' },
        { label: 'Weight', value: '360 g' },
      ],
    });
    const weight = (
      await db
        .select()
        .from(statements)
        .where(
          and(
            eq(statements.itemId, a1.id),
            isNull(statements.withdrawnAt),
            eq(statements.property, 'specs'),
          ),
        )
    ).find((row) => (row.value as { label: string }).label === 'Weight')!;
    expect(weight.value).toEqual({ label: 'Weight', value: '360 g' });
    expect(weight.fetchId).toBe((await fetchOf(third.runId, URLS.a1)).id);
  });

  // The second run writes and resolves a thousand statements, so it gets more than the default 5 s.
  it('doesn’t read a page that says more than 1,000 things', { timeout: 20_000 }, async () => {
    const { world, a2 } = await setUp('refresh-too-much');
    /** Distinct part numbers, P1, P2, and so on, as a pack might read them off a page. */
    const partNumbers = (count: number) =>
      Array.from(
        { length: count },
        (_, index): Candidate => ({
          property: 'mpns',
          raw: `P${index + 1}`,
          method: 'jsonld',
          path: `jsonld[0].mpn[${index}]`,
          confidence: 0.9,
        }),
      );
    alterPack(world, (page, found) =>
      page.url === URLS.a2 ? [...found, ...partNumbers(1_001)] : found,
    );

    const first = await refresh(world, 'refresh-too-much');
    expect(first.summary.notes).toContain(
      `${URLS.a2}: the page says more than 1,000 things, so it wasn’t read`,
    );
    // A1's 7 statements and B1's 5 are written; A2 has none.
    expect(first.summary).toMatchObject({
      statements: { added: 12 },
      entities: { created: 2, unresolved: 1 },
    });
    expect(await db.select().from(statements).where(eq(statements.itemId, a2.id))).toEqual([]);

    // The limit is the number itself. A2 says 6 things of its own, so 994 part numbers make 1,000.
    alterPack(world, (page, found) =>
      page.url === URLS.a2 ? [...found, ...partNumbers(MAX_PAGE_STATEMENTS - 6)] : found,
    );
    const second = await refresh(world, 'refresh-too-much');
    expect(second.summary.notes).toEqual([]);
    // A2's 1,000 and the one spec the LLM read from it.
    expect(second.summary.statements.added).toBe(MAX_PAGE_STATEMENTS + 1);
    expect(await db.select().from(statements).where(eq(statements.itemId, a2.id))).toHaveLength(
      MAX_PAGE_STATEMENTS + 1,
    );
  });

  it('keeps a step’s notes short when a page has many bad values', async () => {
    const { world, a1 } = await setUp('refresh-many-bad-values');
    // Sixty numbers that look like GTINs and fail the check digit.
    const bad = Array.from({ length: 200 }, (_, index) => String(100_000_000_000 + index))
      .filter((digits) => normalizeGtin(digits) === null)
      .slice(0, 60);
    expect(bad).toHaveLength(60);
    alterPack(world, (page, found) =>
      page.url === URLS.a1
        ? [
            ...found,
            ...bad.map(
              (raw, index): Candidate => ({
                property: 'gtins',
                raw,
                method: 'jsonld',
                path: `jsonld[0].gtin[${index}]`,
                confidence: 0.9,
              }),
            ),
          ]
        : found,
    );

    // Workflows keep each step's result, and cap its size, so what the extract step returns is
    // what has to stay small.
    const first = await refresh(world, 'refresh-many-bad-values');
    const { notes } = first.results.get(`extract:${a1.id}`) as { notes: string[] };
    expect(notes).toHaveLength(MAX_NOTES + 1);
    expect(notes.at(-1)).toBe(`${URLS.a1}: 10 more values were rejected`);
    // The run's own notes were already held to MAX_NOTES.
    expect(first.summary.notes).toHaveLength(MAX_NOTES);
  });

  it('fetches a page by its normalized address', async () => {
    // Definitions keep each page as written, and only validate it.
    const written = 'https://MAKER-A.example/products/a1';
    const definition = testDefinition('refresh-normalized');
    definition.sources[0] = {
      ...(definition.sources[0] as PagesSource),
      pages: [written, URLS.a2],
    };
    await applyDefinition(db, definition);
    const world = makeWorld(db, standardRoutes());

    const first = await refresh(world, 'refresh-normalized');
    // The log keeps the page as listed, and the address that was asked for as an href.
    expect(await fetchOf(first.runId, written)).toMatchObject({
      outcome: 'changed',
      finalUrl: URLS.a1,
    });
    // So does the question the LLM is asked.
    expect(world.llm.calls).toContainEqual(expect.stringContaining(`Page address: ${URLS.a1}\n`));
  });

  it('stores notes whose text came from an error', async () => {
    const { world } = await setUp('refresh-stored-notes');
    const prefix = (url: string) => `${url}: the page couldn’t be read: `;
    // A2's message is long, with an emoji (two code units) astride the 500th: the cut halves it.
    const filler = 'x'.repeat(499 - prefix(URLS.a2).length);
    alterPack(world, (page, found) => {
      if (page.url === URLS.a1) throw new Error('bad \u0000 value \ud800');
      if (page.url === URLS.a2) {
        throw new Error(`${filler}${String.fromCodePoint(0x1f600)} and more`);
      }
      return found;
    });

    // Postgres refuses U+0000 and a lone surrogate in jsonb, and the run summary is written by
    // the last step, so a single such note would fail a run that had otherwise finished.
    const first = await refresh(world, 'refresh-stored-notes');
    const stored = (await getRun(db, first.runId))!;
    expect(stored.status).toBe('complete');
    const replacement = String.fromCodePoint(0xfffd);
    const expected = [
      // U+0000 is dropped, and the lone surrogate becomes U+FFFD.
      `${prefix(URLS.a1)}bad  value ${replacement}`,
      // Cut to 500 code units first, which leaves half of the emoji, and then made well formed.
      `${prefix(URLS.a2)}${filler}${replacement}`,
    ];
    expect(expected[1]).toHaveLength(500);
    expect(first.summary.notes).toEqual(expect.arrayContaining(expected));
    expect(stored.summary!.notes).toEqual(expect.arrayContaining(expected));
  });

  it('stores the error of a failed run, whatever it quotes', async () => {
    const { world } = await setUp('refresh-stored-error');
    const failure = new Error('bad \u0000 copy \ud800');
    world.ports.blobs = {
      ...world.ports.blobs,
      async get() {
        throw failure;
      },
    };
    const { step } = fakeStep(world.clock);
    const runId = runIdFor('refresh-stored-error', world.clock.now());

    // The run still fails with its own error, and the stored copy of it has been cleaned. Without
    // that, the failed run's own write is refused, and its error replaces the real one.
    await expect(
      runRefresh({ runId, datasetId: 'refresh-stored-error' }, step, world.ports),
    ).rejects.toBe(failure);
    expect(await getRun(db, runId)).toMatchObject({
      status: 'failed',
      error: `bad  copy ${String.fromCodePoint(0xfffd)}`,
    });
  });

  it('keeps what an error quotes out of step results and the fetch log', async () => {
    const { world, a1, a2 } = await setUp('refresh-quoted-errors');
    // Messages that quote a NUL, and run on past what a note may hold.
    const noisy = (who: string) => `${who} \u0000 ${'x'.repeat(600)}`;
    const cut = (text: string) => text.slice(0, 500);
    alterPack(world, (page, found) => {
      if (page.url === URLS.a1) throw new Error(noisy('pack'));
      return found;
    });
    world.ports.llm = {
      model: 'test-model',
      async structured() {
        throw new Error(noisy('llm'));
      },
    };

    const first = await refresh(world, 'refresh-quoted-errors');
    // Workflows keep what a step returns, so its notes are clean and short where they're made,
    // not only once they reach the run summary.
    const notesOf = (itemId: string) =>
      (first.results.get(`extract:${itemId}`) as { notes: string[] }).notes;
    expect(notesOf(a1.id)).toEqual([
      cut(`${URLS.a1}: the page couldn’t be read: pack  ${'x'.repeat(600)}`),
    ]);
    expect(notesOf(a2.id)).toEqual([
      cut(`${URLS.a2}: the LLM call failed: test/model: llm  ${'x'.repeat(193)}…`),
    ]);
    // The fetch log says what the LLM step did. A NUL in that text would have failed the insert
    // after the LLM had been paid for.
    expect((await fetchOf(first.runId, URLS.a2)).llm).toBe(
      cut(`failed: test/model: llm  ${'x'.repeat(193)}…`),
    );
  });

  it('reads only the pages that are due, taking turns between hosts', async () => {
    const { world, a1, a2, b1 } = await setUp('refresh-plan');
    const first = await refresh(world, 'refresh-plan', {});
    expect(first.names.filter((name) => name.startsWith('fetch:'))).toEqual([
      `fetch:${a1.id}:0`,
      `fetch:${b1.id}:0`,
      `fetch:${a2.id}:0`,
    ]);
    expect(first.summary).toMatchObject({ items: 3, due: 3, live: 3 });

    // Read five minutes ago, so nothing is due and nothing is fetched.
    const before = world.web.requests.length;
    const second = await refresh(world, 'refresh-plan', {});
    expect(second.names).toEqual([
      'load',
      'plan',
      'sources',
      'resolve',
      'snapshot',
      'captures',
      'finish',
    ]);
    expect(second.summary).toMatchObject({ items: 0, due: 0, live: 3 });
    expect(world.web.requests.length).toBe(before);

    // A week on, every page is due again.
    world.clock.advance(7 * DAY);
    expect((await refresh(world, 'refresh-plan', {})).summary).toMatchObject({ items: 3, due: 3 });
  });

  it('reads a page again when the extraction code that read it was the first version', async () => {
    const { world, a1 } = await setUp('refresh-older-code');
    await refresh(world, 'refresh-older-code', {});
    // Read five minutes ago, by this code: nothing is due.
    expect((await refresh(world, 'refresh-older-code', {})).summary).toMatchObject({
      items: 0,
      due: 0,
    });

    // Version 1 left product types on names ("LCD-5 Flagship Headphones"), and a definition that
    // hasn't changed doesn't change the tag, so a page it read stays as it was unless this says so.
    await db.update(items).set({ extractedWith: 'r1.v1' }).where(eq(items.id, a1.id));
    const next = await refresh(world, 'refresh-older-code', {});
    expect(next.summary).toMatchObject({ items: 1, due: 1 });
    expect((await db.select().from(items).where(eq(items.id, a1.id)))[0]!.extractedWith).toBe(
      extractionTag(1),
    );
  });

  it('reads at most the budget’s pages, and leaves the rest for the next run', async () => {
    const definition = testDefinition('refresh-budget');
    await applyDefinition(db, { ...definition, budget: { ...definition.budget, itemsPerRun: 2 } });
    const world = makeWorld(db, standardRoutes());
    const first = await refresh(world, 'refresh-budget', {});
    expect(first.summary).toMatchObject({ items: 2, due: 3, live: 3 });
    expect(first.summary.notes).toContain(
      '1 due page waits for the next run: the budget reads 2 pages a run',
    );
    expect((await refresh(world, 'refresh-budget', {})).summary).toMatchObject({
      items: 1,
      due: 1,
    });
  });

  it.each([
    [2, '1 live page wasn’t read: the budget reads 2 pages a run'],
    [1, '2 live pages weren’t read: the budget reads 1 page a run'],
  ])(
    'says, when every page counts as due, which live pages a budget of %i left unread',
    async (itemsPerRun, expected) => {
      const datasetId = `refresh-all-${itemsPerRun}`;
      const definition = testDefinition(datasetId);
      await applyDefinition(db, { ...definition, budget: { ...definition.budget, itemsPerRun } });
      const world = makeWorld(db, standardRoutes());
      // The pages this run reads aren't due again five minutes on, but --all makes them so.
      await refresh(world, datasetId, {});

      const all = await refresh(world, datasetId, { all: true });
      expect(all.summary).toMatchObject({ items: itemsPerRun, due: 3, live: 3 });
      expect(all.summary.notes).toContain(expected);
      // The next ordinary run reads only the pages whose freshness has run out, which may be none
      // of these, so they aren't said to wait for it.
      expect(all.summary.notes.join('\n')).not.toContain('next run');
    },
  );

  it('loads the planned pages in steps of 50, in the order they were planned', async () => {
    // Maker A has fifty-one pages and maker B one. Nothing answers, so each page is a 404 that
    // costs only its fetch.
    const definition = testDefinition('refresh-steps');
    definition.sources[0] = {
      ...(definition.sources[0] as PagesSource),
      pages: Array.from({ length: 51 }, (_, index) => `https://maker-a.example/products/p${index}`),
    };
    await applyDefinition(db, definition);
    const world = makeWorld(db, {});

    const first = await refresh(world, 'refresh-steps', {});
    const { ids } = first.results.get('plan') as { ids: string[] };
    expect(ids).toHaveLength(52);
    expect(first.names).toEqual([
      'load',
      'plan',
      'items:0',
      ...ids.slice(0, 50).map((id) => `fetch:${id}:0`),
      'items:50',
      ...ids.slice(50).map((id) => `fetch:${id}:0`),
      'sources',
      'resolve',
      'snapshot',
      'captures',
      'finish',
    ]);
    expect(first.summary).toMatchObject({ items: 52, due: 52, live: 52, fetches: { gone: 52 } });
  });

  it('doesn’t count a planned page that left the live pages before it was loaded', async () => {
    const { world, a1, a2, b1 } = await setUp('refresh-left');
    const { step, names } = fakeStep(world.clock);
    const leaving: StepRunner = {
      ...step,
      async do(name, fn) {
        const result = await step.do(name, fn);
        // A run that overlaps this one sees B1 answer 404 twice, after this run has planned it.
        if (name === 'plan') {
          await db.update(items).set({ status: 'gone' }).where(eq(items.id, b1.id));
        }
        return result;
      },
    };
    const runId = runIdFor('refresh-left', world.clock.now());
    const summary = await runRefresh({ runId, datasetId: 'refresh-left' }, leaving, world.ports);

    expect(names.filter((name) => name.startsWith('fetch:'))).toEqual([
      `fetch:${a1.id}:0`,
      `fetch:${a2.id}:0`,
    ]);
    // It was planned, so it was due, but it wasn't read.
    expect(summary).toMatchObject({ items: 2, due: 3, live: 3 });
  });

  it('pauses a source that keeps answering with challenges, and still reads the others', async () => {
    const base = testDefinition('refresh-pause');
    const pages = ['a1', 'a2', 'a3', 'a4', 'a5'].map(
      (name) => `https://maker-a.example/products/${name}`,
    );
    await applyDefinition(db, {
      ...base,
      sources: base.sources.map((source) =>
        source.id === 'maker-a' && source.kind === 'pages' ? { ...source, pages } : source,
      ),
    });
    const routes = standardRoutes();
    for (const url of pages) {
      routes[url] = { status: 403, headers: { 'cf-mitigated': 'challenge' } };
    }
    const world = makeWorld(db, routes);
    const run = await refresh(world, 'refresh-pause', {});
    // a1, b1, a2, a3 are asked for; after a3, three blocks in a row pause maker-a.
    expect(run.summary.fetches).toMatchObject({ blocked: 3, changed: 1 });
    expect(run.summary.paused).toEqual({ 'maker-a': 2 });
    // Four pages were read, and the two the pause left aren't counted as read.
    expect(run.summary.items).toBe(4);
    expect(run.summary.notes).toContain(
      'maker-a: paused after 3 pages in a row were blocked or strained; 2 pages wait for the next run',
    );
    const asked = world.web.requests.map((sent) => sent.url);
    expect(asked).not.toContain(pages[3]);
    expect(asked).not.toContain(pages[4]);
    // No page was refused: each was blocked once, and the next run asks again.
    const statuses = await db
      .select({ status: items.status })
      .from(items)
      .where(eq(items.datasetId, 'refresh-pause'));
    expect(new Set(statuses.map((row) => row.status))).toEqual(new Set(['live']));
  });

  it.each([
    [5, 'maker-a: paused after 3 pages in a row were blocked or strained; 2 pages weren’t read'],
    [4, 'maker-a: paused after 3 pages in a row were blocked or strained; 1 page wasn’t read'],
  ])(
    'says, when every page counts as due, that a paused source of %i pages left some unread, not waiting',
    async (count, expected) => {
      const datasetId = `refresh-pause-all-${count}`;
      const base = testDefinition(datasetId);
      const pages = ['a1', 'a2', 'a3', 'a4', 'a5']
        .slice(0, count)
        .map((name) => `https://maker-a.example/products/${name}`);
      await applyDefinition(db, {
        ...base,
        sources: base.sources.map((source) =>
          source.id === 'maker-a' && source.kind === 'pages' ? { ...source, pages } : source,
        ),
      });
      const routes = standardRoutes();
      for (const url of pages) {
        routes[url] = { status: 403, headers: { 'cf-mitigated': 'challenge' } };
      }
      const world = makeWorld(db, routes);
      // The next ordinary run reads only the pages whose freshness has run out, which may be none
      // of these, so under --all they aren't said to wait for it.
      const run = await refresh(world, datasetId, { all: true });
      expect(run.summary.paused).toEqual({ 'maker-a': count - 3 });
      expect(run.summary.notes).toContain(expected);
      expect(run.summary.notes.join('\n')).not.toContain('next run');
    },
  );

  it('doesn’t pause a source for pages its robots.txt turns away, which send no request', async () => {
    const base = testDefinition('refresh-pause-robots');
    const pages = ['a1', 'a2', 'a3', 'a4'].map(
      (name) => `https://maker-a.example/products/${name}`,
    );
    await applyDefinition(db, {
      ...base,
      sources: base.sources.map((source) =>
        source.id === 'maker-a' && source.kind === 'pages' ? { ...source, pages } : source,
      ),
    });
    const routes = standardRoutes();
    routes['https://maker-a.example/robots.txt'] = {
      status: 200,
      body: 'User-agent: *\nDisallow: /products/a1\nDisallow: /products/a2\nDisallow: /products/a3\n',
    };
    routes[pages[3]!] = { status: 200, body: A2() };
    const world = makeWorld(db, routes, { llm: false });

    // Three pages in a row come back blocked, but none of them was the host's answer: the gate
    // turned them away without asking. Pausing maker-a for that would leave its fourth page unread.
    const first = await refresh(world, 'refresh-pause-robots', {});
    expect(first.summary.fetches).toMatchObject({ blocked: 3, changed: 2 });
    expect(first.summary.paused).toEqual({});
    expect(first.summary.items).toBe(5);
    const asked = world.web.requests.map((sent) => sent.url);
    expect(asked).toContain(pages[3]);
    for (const name of ['a1', 'a2', 'a3']) {
      const url = `https://maker-a.example/products/${name}`;
      expect(asked).not.toContain(url);
      expect(await fetchOf(first.runId, url)).toMatchObject({
        policy: 'denied',
        outcome: 'blocked',
        policyReason: `robots.txt disallows /products/${name} for Spatula`,
      });
    }

    // Each page's own streak still counts, as in slice 0: turned away in three runs, it is refused.
    await refresh(world, 'refresh-pause-robots', {});
    const third = await refresh(world, 'refresh-pause-robots', {});
    expect(third.summary.paused).toEqual({});
    const statuses = await db
      .select({ locator: items.locator, status: items.status })
      .from(items)
      .where(eq(items.datasetId, 'refresh-pause-robots'));
    expect(Object.fromEntries(statuses.map((row) => [row.locator, row.status]))).toEqual({
      [pages[0]!]: 'refused',
      [pages[1]!]: 'refused',
      [pages[2]!]: 'refused',
      [pages[3]!]: 'live',
      [URLS.b1]: 'live',
    });
  });

  it('says a host answered only when a response came back from it, and was strained when none did', async () => {
    const base = testDefinition('refresh-answered');
    const pages = ['a1', 'a2', 'a3', 'a4', 'a5'].map(
      (name) => `https://maker-a.example/products/${name}`,
    );
    await applyDefinition(db, {
      ...base,
      sources: base.sources.map((source) =>
        source.id === 'maker-a' && source.kind === 'pages' ? { ...source, pages } : source,
      ),
    });
    const routes = standardRoutes();
    routes['https://maker-a.example/robots.txt'] = {
      status: 200,
      body: 'User-agent: *\nDisallow: /products/a2\n',
    };
    routes[pages[0]!] = { status: 403, headers: { 'cf-mitigated': 'challenge' } };
    routes[pages[3]!] = { status: 200, body: A2() };
    const world = makeWorld(db, routes, { llm: false });
    // The network drops a3's request, and a5's host asks for a wait every time it is asked.
    const web = world.ports.http;
    world.ports.http = {
      async get(url, headers, options) {
        if (url === pages[2]) return { ok: false, error: 'connection reset' };
        return web.get(url, headers, options);
      },
    };
    const gate = world.ports.gate;
    world.ports.gate = {
      ...gate,
      async reserve(url, request) {
        if (url !== pages[4]) return gate.reserve(url, request);
        return { kind: 'later', retryAfterMs: 1000, reason: 'busy' };
      },
    };
    const live = await listLiveItems(db, 'refresh-answered');
    const run = await refresh(world, 'refresh-answered', {});

    // What the attempt that finished returned: the ones before it were put off.
    const fetchedOf = (page: string) => {
      const id = live.find((item) => item.locator === page)!.id;
      for (let attempt = 0; attempt <= MAX_WAITS; attempt += 1) {
        const result = run.results.get(`fetch:${id}:${attempt}`) as
          | { kind: 'done'; fetched: object }
          | { kind: 'later' };
        if (result.kind === 'done') return result.fetched;
      }
      throw new Error(`${page} was put off every time`);
    };
    // A challenge and a page are the host's answers. A page robots.txt turns away, a request the
    // network dropped, and one given up after the host kept asking for a wait are not. Of those,
    // only the dropped request went out, so only it strained the host: the others sent nothing.
    // What each says of the site (ADR 0006): the challenge is a refusal and the page got through,
    // while the three that weren't the host's answers say nothing either way.
    expect(fetchedOf(pages[0]!)).toMatchObject({
      outcome: 'blocked',
      hostAnswered: true,
      strained: false,
      site: 'refused',
    });
    expect(fetchedOf(pages[1]!)).toMatchObject({
      outcome: 'blocked',
      hostAnswered: false,
      strained: false,
      site: null,
    });
    expect(fetchedOf(pages[2]!)).toMatchObject({
      outcome: 'failed',
      hostAnswered: false,
      strained: true,
      site: null,
    });
    expect(fetchedOf(pages[3]!)).toMatchObject({
      outcome: 'changed',
      hostAnswered: true,
      strained: false,
      site: 'through',
    });
    expect(fetchedOf(pages[4]!)).toMatchObject({
      outcome: 'failed',
      hostAnswered: false,
      strained: false,
      site: null,
    });
  });

  it('keeps what each page’s answer says of the site in its fetch step’s result', async () => {
    const datasetId = 'refresh-site-answers';
    // Read in this order (by address): through, through, refused, refused, neither.
    const names = ['p1-ok', 'p2-gone', 'p3-busy', 'p4-challenged', 'p5-down'];
    const pages = await makerAPages(datasetId, names);
    const routes = standardRoutes();
    routes[pages[0]!] = { status: 200, body: A1() };
    routes[pages[1]!] = { status: 404 };
    routes[pages[2]!] = { status: 429 };
    routes[pages[3]!] = { status: 403, headers: { 'cf-mitigated': 'challenge' } };
    routes[pages[4]!] = { status: 503 };
    const world = makeWorld(db, routes);
    const run = await refresh(world, datasetId);
    const live = await listLiveItems(db, datasetId);
    // A page that waited behind its host's break took more than one attempt: the last answered.
    const fetchedOf = (url: string) =>
      lastFetched(run, live.find((row) => row.locator === url)!.id);
    const siteOf = (url: string) => {
      const fetched = fetchedOf(url);
      return fetched === undefined ? 'not asked' : (fetched.site ?? null);
    };
    expect(pages.map(siteOf)).toEqual(['through', 'through', 'refused', 'refused', null]);
    // The last is a 503, which the host answered: it says nothing of the site, as a page given up
    // on would, but it is not one.
    expect(fetchedOf(pages[4]!)).toMatchObject({ outcome: 'failed', hostAnswered: true });
  });

  it('reads a page held back for a challenged robots.txt as refused', async () => {
    const routes = standardRoutes();
    routes['https://maker-b.example/robots.txt'] = {
      status: 403,
      headers: { 'cf-mitigated': 'challenge' },
    };
    const { world, b1 } = await setUp('refresh-robots-challenged', routes);
    const run = await refresh(world, 'refresh-robots-challenged');
    const result = run.results.get(`fetch:${b1.id}:0`) as {
      kind: 'done';
      fetched: { site?: string | null; hostAnswered: boolean };
    };
    expect(result.fetched).toMatchObject({ site: 'refused', hostAnswered: false });
  });

  it('reads every page of a host whose robots.txt answers 429 as refused, though none is asked for', async () => {
    const routes = standardRoutes();
    routes['https://maker-a.example/robots.txt'] = { status: 429 };
    const { world, a1, a2, b1 } = await setUp('refresh-robots-429', routes, { llm: false });
    const run = await refresh(world, 'refresh-robots-429');
    // The gate holds maker-a's pages back while its robots.txt can't be read, as it always has.
    const asked = world.web.requests.map((sent) => sent.url);
    expect(asked).not.toContain(URLS.a1);
    expect(asked).not.toContain(URLS.a2);
    for (const page of [a1, a2]) {
      expect(lastFetched(run, page.id)).toMatchObject({
        outcome: 'failed',
        hostAnswered: false,
        site: 'refused',
      });
    }
    // The other host's page is its own.
    expect(lastFetched(run, b1.id)).toMatchObject({ outcome: 'changed', site: 'through' });
  });

  it('reads a page that says nothing as refused when robots.txt answered 403, and one that got through as through', async () => {
    const pages = await makerAPages('refresh-robots-403', ['p1-busy', 'p2-ok']);
    const routes = standardRoutes();
    routes['https://maker-a.example/robots.txt'] = { status: 403 };
    routes[pages[0]!] = { status: 503 };
    routes[pages[1]!] = { status: 200, body: A1() };
    const world = makeWorld(db, routes, { llm: false });
    const run = await refresh(world, 'refresh-robots-403');
    const live = await listLiveItems(db, 'refresh-robots-403');
    const fetchedOf = (url: string) =>
      lastFetched(run, live.find((row) => row.locator === url)!.id);
    // A 403 for robots.txt means it holds no rules, so both pages are asked for. The 503 says
    // nothing of its own, so the refusal is what it comes to; the page that got through stays so.
    expect(world.web.requests.map((sent) => sent.url)).toEqual(expect.arrayContaining(pages));
    expect(fetchedOf(pages[0]!)).toMatchObject({
      outcome: 'failed',
      hostAnswered: true,
      site: 'refused',
    });
    expect(fetchedOf(pages[1]!)).toMatchObject({
      outcome: 'changed',
      hostAnswered: true,
      site: 'through',
    });
  });

  it('starts the count again at a page robots.txt turns away between challenges', async () => {
    const base = testDefinition('refresh-pause-reset');
    const pages = ['a1', 'a2', 'a3', 'a4', 'a5'].map(
      (name) => `https://maker-a.example/products/${name}`,
    );
    await applyDefinition(db, {
      ...base,
      sources: base.sources.map((source) =>
        source.id === 'maker-a' && source.kind === 'pages' ? { ...source, pages } : source,
      ),
    });
    const routes = standardRoutes();
    routes['https://maker-a.example/robots.txt'] = {
      status: 200,
      body: 'User-agent: *\nDisallow: /products/a3\n',
    };
    for (const url of [pages[0]!, pages[1]!, pages[3]!]) {
      routes[url] = { status: 403, headers: { 'cf-mitigated': 'challenge' } };
    }
    routes[pages[4]!] = { status: 200, body: A2() };
    const world = makeWorld(db, routes, { llm: false });

    // The host challenged a1, a2, and a4, with a page it was never asked about between them. Only
    // answered blocks count, and the page the gate turned away starts the count again.
    const run = await refresh(world, 'refresh-pause-reset', {});
    expect(run.summary.fetches).toMatchObject({ blocked: 4, changed: 2 });
    expect(run.summary.paused).toEqual({});
    expect(world.web.requests.map((sent) => sent.url)).toContain(pages[4]);
  });

  const nothing = new Uint8Array();
  it.each([
    [
      'answers 503',
      'refresh-strain-503',
      { ok: true, status: 503, headers: {}, body: nothing, truncated: false },
    ],
    [
      'answers 429',
      'refresh-strain-429',
      { ok: true, status: 429, headers: {}, body: nothing, truncated: false },
    ],
    ['never answers', 'refresh-strain-silent', { ok: false, error: 'the connection timed out' }],
  ] satisfies [string, string, HttpResult][])(
    'pauses a source whose host %s for every page, still reads the others, and leaves its pages due',
    // Two runs, each waiting out a host's breaks, so it gets more than the default 5 s.
    { timeout: 20_000 },
    async (_what, datasetId, reply) => {
      const pages = await makerAPages(datasetId, ['a1', 'a2', 'a3', 'a4', 'a5']);
      const routes = standardRoutes();
      for (const [index, url] of pages.entries()) {
        routes[url] = { status: 200, body: productPage({ name: `A${index + 1}` }) };
      }
      const world = makeWorld(db, routes, { llm: false });
      const { strain, asked } = straining(world, pages, reply);

      // a1, b1, a2, a3 are asked for. Each of maker-a's costs the run its host's break, so after
      // a3, three pages in a row that strained the host pause maker-a, and b1 is still read.
      const run = await refresh(world, datasetId, {});
      expect(run.summary.fetches).toMatchObject({ failed: 3, changed: 1, blocked: 0 });
      expect(run.summary.paused).toEqual({ 'maker-a': 2 });
      expect(run.summary.items).toBe(4);
      expect(run.summary.notes).toContain(
        'maker-a: paused after 3 pages in a row were blocked or strained; 2 pages wait for the next run',
      );
      expect(asked).toContain(URLS.b1);
      expect(asked).not.toContain(pages[3]);
      expect(asked).not.toContain(pages[4]);

      // The host recovers. The pages the pause left are still due, and so are the three that
      // failed, so the next ordinary run reads all five.
      strain.on = false;
      asked.length = 0;
      const next = await refresh(world, datasetId, {});
      expect(next.summary).toMatchObject({ items: 5, paused: {} });
      expect(asked).toEqual(expect.arrayContaining(pages));
    },
  );

  it('pauses a source after a block, a strain, and a block in a row: one count covers both', async () => {
    const pages = await makerAPages('refresh-strain-mixed', ['a1', 'a2', 'a3', 'a4', 'a5']);
    const routes = standardRoutes();
    routes[pages[0]!] = { status: 403, headers: { 'cf-mitigated': 'challenge' } };
    routes[pages[1]!] = { status: 503 };
    routes[pages[2]!] = { status: 403, headers: { 'cf-mitigated': 'challenge' } };
    routes[pages[3]!] = { status: 200, body: A2() };
    routes[pages[4]!] = { status: 200, body: A2() };
    const world = makeWorld(db, routes, { llm: false });

    const run = await refresh(world, 'refresh-strain-mixed', {});
    expect(run.summary.fetches).toMatchObject({ blocked: 2, failed: 1, changed: 1 });
    expect(run.summary.paused).toEqual({ 'maker-a': 2 });
    const asked = world.web.requests.map((sent) => sent.url);
    expect(asked).not.toContain(pages[3]);
    expect(asked).not.toContain(pages[4]);
  });

  it.each([
    [
      'a page robots.txt turns away, which sends no request',
      'refresh-strain-refused',
      (routes: Record<string, Reply>) => {
        routes['https://maker-a.example/robots.txt'] = {
          status: 200,
          body: 'User-agent: *\nDisallow: /products/a3\n',
        };
      },
    ],
    [
      'an answer that isn’t HTML',
      'refresh-strain-pdf',
      (routes: Record<string, Reply>, pages: string[]) => {
        routes[pages[2]!] = {
          status: 200,
          body: '%PDF-1.7',
          headers: { 'content-type': 'application/pdf' },
        };
      },
    ],
  ])(
    'starts the count again at %s',
    async (_what, datasetId, between: (routes: Record<string, Reply>, pages: string[]) => void) => {
      const pages = await makerAPages(datasetId, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
      const routes = standardRoutes();
      for (const url of pages) routes[url] = { status: 503 };
      between(routes, pages);
      const world = makeWorld(db, routes, { llm: false });

      // a1 and a2 strain the host and a3 doesn't, so the count starts again there: a4, a5, and a6
      // are the three in a row that pause maker-a, and only a7 is left.
      const run = await refresh(world, datasetId, {});
      expect(run.summary.paused).toEqual({ 'maker-a': 1 });
      const asked = world.web.requests.map((sent) => sent.url);
      expect(asked).toEqual(expect.arrayContaining([pages[3], pages[4], pages[5]]));
      expect(asked).not.toContain(pages[6]);
    },
  );

  it('stops asking the LLM once the run’s budget is spent, and reads those pages next run', async () => {
    const definition = testDefinition('refresh-llm-budget');
    await applyDefinition(db, {
      ...definition,
      budget: { ...definition.budget, llmUsdPerRun: 0.001 },
    });
    const world = makeWorld(db, standardRoutes());
    // A1 is read first, and its answer spends 1,050 tokens; B1 and A2 wait.
    const first = await refresh(world, 'refresh-llm-budget');
    expect(first.summary.llm).toMatchObject({ ran: 1, skipped: 2, inputTokens: 1000 });
    expect(first.summary.notes).toContain(
      '2 pages wait for the next run: this run’s LLM budget of $0.00 is spent',
    );
    expect(await fetchOf(first.runId, URLS.b1)).toMatchObject({
      llm: 'skipped: the run’s LLM budget is spent',
    });
    // The next run has a budget of its own: B1 is read from its stored copy, and A2 waits again.
    const second = await refresh(world, 'refresh-llm-budget');
    expect(second.summary.llm).toMatchObject({ ran: 1, reused: 0, skipped: 1 });
    expect(world.llm.calls).toHaveLength(2);
  });

  it('stops asking the LLM when the run’s budget is spent to the token', async () => {
    const definition = testDefinition('refresh-llm-budget-exact');
    await applyDefinition(db, {
      ...definition,
      budget: { ...definition.budget, llmUsdPerRun: 0.00105 },
    });
    const world = makeWorld(db, standardRoutes());
    // A1's answer spends 1,050 tokens, which is all of the budget.
    const first = await refresh(world, 'refresh-llm-budget-exact');
    expect(first.summary.llm).toMatchObject({ ran: 1, skipped: 2 });
    expect(world.llm.calls).toHaveLength(1);
  });

  it('asks the extraction step’s backup when its model fails, and counts both', async () => {
    const definition = testDefinition('refresh-llm-backup');
    await applyDefinition(db, {
      ...definition,
      models: { extract: { model: 'down/x', backup: 'up/y' } },
    });
    const world = makeWorld(db, standardRoutes());
    let downCalls = 0;
    const throwing: LlmPort = {
      model: 'down/x',
      async structured() {
        downCalls += 1;
        throw new LlmHttpError(400, '400 You have reached your specified API usage limits.');
      },
    };
    world.ports.modelPorts = (model) => ({
      llm: model === 'down/x' ? throwing : world.llm.llm,
      decider: world.decider.decider,
      taxonomyDecider: world.taxonomyDecider.decider,
    });

    const run = await refresh(world, 'refresh-llm-backup');
    // Every page was read by the backup.
    expect(run.summary.llm).toMatchObject({ ran: 3, failed: 0, inputTokens: 3000 });
    expect(world.llm.calls).toHaveLength(3);
    const file = (await published(world, 'refresh-llm-backup'))!;
    expect(file.byName.A1!.fields).toMatchObject({
      specs: [
        { label: 'Impedance', value: '300 Ω' },
        { label: 'Weight', value: '350 g' },
      ],
    });
    // The first page was sent to down/x; the usage limit marked its provider down, so the other two
    // went straight to the backup and sent nothing.
    expect(downCalls).toBe(1);
    expect(run.summary.spend?.extract?.['down/x']).toMatchObject({
      calls: 3,
      failed: 3,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(run.summary.spend?.extract?.['up/y']).toMatchObject({
      calls: 3,
      failed: 0,
      inputTokens: 3000,
      outputTokens: 150,
    });
    expect(run.summary.llm.down?.down?.reason).toBe('usage limit');
  });

  it('asks no page again after the extraction model changes', async () => {
    const definition = testDefinition('refresh-llm-switch');
    await applyDefinition(db, { ...definition, models: { extract: 'a/x' } });
    const world = makeWorld(db, standardRoutes());
    const asked: string[] = [];
    world.ports.modelPorts = (model) => {
      asked.push(model);
      return {
        llm: world.llm.llm,
        decider: world.decider.decider,
        taxonomyDecider: world.taxonomyDecider.decider,
      };
    };
    const first = await refresh(world, 'refresh-llm-switch');
    expect(first.summary.llm).toMatchObject({ ran: 3, reused: 0 });
    expect(new Set(asked)).toEqual(new Set(['a/x']));

    await applyDefinition(db, { ...definition, models: { extract: 'b/y' } });
    asked.length = 0;
    const second = await refresh(world, 'refresh-llm-switch');
    expect(second.summary.llm).toMatchObject({ ran: 0, reused: 3, inputTokens: 0 });
    expect(asked).toEqual([]);
    expect(world.llm.calls).toHaveLength(3);
  });

  it('takes a page asked before ADR 0010 as answered, and stores the new hash', async () => {
    const { world, a1 } = await setUp('refresh-llm-legacy');
    await refresh(world, 'refresh-llm-legacy');
    const stored = async () =>
      (await db.select().from(items).where(eq(items.id, a1.id)))[0]!.extractInputHash;

    // The text and fields A1 was asked with, rebuilt as the extraction builds them.
    const definition = testDefinition('refresh-llm-legacy');
    const row = (await db.select().from(items).where(eq(items.id, a1.id)))[0]!;
    const source = definition.sources.find((candidate) => candidate.id === row.sourceId)!;
    const recordType = definition.recordTypes[row.recordType]!;
    const body = world.web.routes.get(URLS.a1)!.body as string;
    const page = parsePage(body, URLS.a1);
    const extraction = extractFromPage({
      page,
      source,
      recordType,
      pack: recordType.pack === undefined ? null : (packs[recordType.pack] ?? null),
    });
    const asked = { text: page.text, fields: llmFields(recordType, extraction.missing) };
    const hash = await llmInputHash(asked);
    expect(await stored()).toBe(hash);

    await db
      .update(items)
      // Older code's tag, so the page is read again from its stored copy.
      .set({ extractInputHash: await legacyLlmInputHash(asked), extractedWith: 'r1.v1' })
      .where(eq(items.id, a1.id));
    const callsBefore = world.llm.calls.length;
    const next = await refresh(world, 'refresh-llm-legacy');
    expect(next.summary.llm).toMatchObject({ ran: 0, reused: 1, inputTokens: 0 });
    expect(world.llm.calls).toHaveLength(callsBefore);
    expect(await stored()).toBe(hash);
  });

  it('notes a named model the deployment can’t ask, and runs on with its backup', async () => {
    const definition = testDefinition('refresh-model-problem');
    await applyDefinition(db, {
      ...definition,
      models: { extract: { model: 'gone/x', backup: 'up/y' } },
    });
    const world = makeWorld(db, standardRoutes());
    world.ports.models = testModelSetup({
      problem: (model) => (model === 'gone/x' ? 'no key: set X' : null),
    });

    const run = await refresh(world, 'refresh-model-problem');
    expect(run.summary.notes).toContain(
      'models.extract.model: gone/x: no key: set X. Its calls count as failed until that’s fixed.',
    );
    // The jobs the definition leaves out use the default, which can be asked: nothing says it can't.
    expect(run.summary.notes.filter((text) => text.startsWith('LLM_MODEL'))).toEqual([]);
    // The run didn't stop: gone/x was never sent anything, and its backup read every page.
    expect(run.summary.llm).toMatchObject({ ran: 3, failed: 0 });
    expect(run.summary.spend?.extract?.['gone/x']).toMatchObject({ calls: 3, failed: 3 });
    expect((await getRun(db, run.runId))?.status).toBe('complete');
  });

  it('notes the default model when the deployment can’t ask it and a job falls back to it', async () => {
    const problem = (model: string) => (model === 'test/model' ? 'no key: set TEST_API_KEY' : null);
    const NOTE =
      'LLM_MODEL: test/model: no key: set TEST_API_KEY. Its calls count as failed until that’s fixed.';
    const { world } = await setUp('refresh-default-problem');
    world.ports.models = testModelSetup({ problem });
    const run = await refresh(world, 'refresh-default-problem');
    expect(run.summary.notes).toContain(NOTE);
    expect(run.summary.llm).toMatchObject({ ran: 0, failed: 3 });
    expect((await getRun(db, run.runId))?.status).toBe('complete');

    // A definition that names every job's models never falls back to the default.
    const definition = testDefinition('refresh-default-unused');
    await applyDefinition(db, {
      ...definition,
      models: { extract: 'up/y', classify: ['up/y'], match: ['up/y'], taxonomyReview: 'up/y' },
    });
    const named = makeWorld(db, standardRoutes());
    named.ports.models = testModelSetup({ problem });
    const unused = await refresh(named, 'refresh-default-unused');
    expect(unused.summary.notes).not.toContain(NOTE);
    expect(unused.summary.llm).toMatchObject({ ran: 3, failed: 0 });
  });
});

describe('classifyResponse', () => {
  const html = { 'content-type': 'text/html; charset=utf-8' };
  const answer = (status: number, headers: Record<string, string> = html, truncated = false) =>
    classifyResponse({ status, headers, truncated });

  it('reads what each answer means', () => {
    expect(answer(304)).toEqual({ kind: 'final', outcome: 'unchanged', error: null });
    expect(answer(403, { 'cf-mitigated': 'challenge' })).toEqual({
      kind: 'final',
      outcome: 'blocked',
      error: 'the site answered with a challenge',
    });
    for (const status of [401, 402, 403])
      expect(answer(status)).toMatchObject({ outcome: 'blocked' });
    expect(answer(429)).toEqual({ kind: 'final', outcome: 'failed', error: 'HTTP 429' });
    expect(answer(404)).toEqual({ kind: 'final', outcome: 'gone', error: 'HTTP 404' });
    expect(answer(410)).toMatchObject({ outcome: 'gone' });
    expect(answer(500)).toEqual({ kind: 'final', outcome: 'failed', error: 'HTTP 500' });
    expect(answer(204, {})).toEqual({
      kind: 'final',
      outcome: 'failed',
      error: 'not HTML (no content type)',
    });
    expect(answer(200, { 'content-type': 'application/pdf' })).toMatchObject({
      error: 'not HTML (application/pdf)',
    });
    expect(answer(200, html, true)).toEqual({
      kind: 'final',
      outcome: 'failed',
      error: 'larger than 5 MB',
    });
    expect(answer(200)).toEqual({ kind: 'page' });
    expect(answer(200, { 'content-type': 'application/xhtml+xml' })).toEqual({ kind: 'page' });
  });
});

describe('a request put off partway through its redirects', () => {
  const first = 'https://maker-a.example/products/a1';
  const moved = 'https://maker-a.example/products/moved';
  // What a page read before sends to ask whether it changed. Only the first address gets them.
  const validators = {
    'if-none-match': '"v1"',
    'if-modified-since': 'Mon, 05 Oct 2026 00:00:00 GMT',
  };
  const redirectTo = (location: string): HttpResult => ({
    ok: true,
    status: 301,
    headers: { location },
    body: new Uint8Array(),
    truncated: false,
  });
  const page: HttpResult = {
    ok: true,
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: new TextEncoder().encode('<html></html>'),
    truncated: false,
  };

  /**
   * Ports that answer from a script. The gate puts off the reservations numbered in `putOff`
   * (counted from 0 across every call) and lets the rest go at once; `routes` says what each
   * address answers; `sent` is each request that reached the web, with the headers it went with.
   */
  function scripted(routes: Record<string, HttpResult>, putOff: number[]) {
    const sent: { url: string; headers: Record<string, string> }[] = [];
    let reserved = 0;
    const ports = {
      gate: {
        async reserve(): Promise<GateDecision> {
          const number = reserved;
          reserved += 1;
          return putOff.includes(number)
            ? { kind: 'later', retryAfterMs: 20_000, reason: 'maker-a.example isn’t open yet' }
            : { kind: 'go', waitMs: 0, signals: {} };
        },
        async record() {},
      },
      http: {
        async get(url: string, headers: Record<string, string>): Promise<HttpResult> {
          sent.push({ url, headers });
          return routes[url] ?? { ok: false, error: `nothing is served at ${url}` };
        },
      },
      async wait() {},
    };
    return { ports, sent };
  }

  it('picks up at the hop it was put off at, which sends none of the first hop’s headers', async () => {
    const { ports, sent } = scripted({ [first]: redirectTo(moved), [moved]: page }, [1]);
    const options = { minIntervalMs: 20_000, giveUp: false, headers: validators };

    // The redirect is followed, and the reservation for where it leads is put off.
    const putOff = await requestThroughGate(ports, first, options);
    expect(putOff).toEqual({ kind: 'later', retryAfterMs: 20_000, resume: { url: moved, hop: 1 } });
    expect(sent).toEqual([{ url: first, headers: validators }]);

    // The next attempt asks for the redirect's target as hop 1, so the first address's validators
    // aren't sent to it, and the first address isn't asked again.
    if (putOff.kind !== 'later') throw new Error('expected the request to be put off');
    const answered = await requestThroughGate(ports, first, { ...options, resume: putOff.resume });
    expect(answered).toMatchObject({ kind: 'answered', url: moved, status: 200 });
    expect(sent).toEqual([
      { url: first, headers: validators },
      { url: moved, headers: {} },
    ]);
  });

  it('counts the redirects it had followed when it was put off against the limit', async () => {
    // Two addresses that send each other on, so the request never ends by itself. The reservation
    // for hop 2 is put off.
    const { ports, sent } = scripted(
      { [first]: redirectTo(moved), [moved]: redirectTo(first) },
      [2],
    );
    const options = { minIntervalMs: 20_000, giveUp: false, headers: {} };

    const putOff = await requestThroughGate(ports, first, options);
    expect(putOff).toEqual({ kind: 'later', retryAfterMs: 20_000, resume: { url: first, hop: 2 } });
    expect(sent.map((one) => one.url)).toEqual([first, moved]);

    // The attempt that resumes stops where one that was never put off would: after the first
    // address and MAX_REDIRECTS redirects, not MAX_REDIRECTS hops after it picked up.
    if (putOff.kind !== 'later') throw new Error('expected the request to be put off');
    const stopped = await requestThroughGate(ports, first, { ...options, resume: putOff.resume });
    expect(stopped).toMatchObject({
      kind: 'failed',
      error: `redirected more than ${MAX_REDIRECTS} times`,
    });
    expect(sent).toHaveLength(MAX_REDIRECTS + 1);
  });
});

describe('a request that learns the host refused robots.txt', () => {
  const address = 'https://maker-a.example/products/a1';
  const moved = 'https://maker-b.example/products/a1';
  const options = { minIntervalMs: 1000, giveUp: false, headers: {} };
  const go: GateDecision = { kind: 'go', waitMs: 0, signals: {} };
  const deny: GateDecision = {
    kind: 'deny',
    outcome: 'failed',
    reason: 'robots.txt is unreachable (HTTP 429)',
  };
  const refused = { robotsRefused: true } as const;
  const page: HttpResult = {
    ok: true,
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: new Uint8Array(),
    truncated: false,
  };
  const redirect: HttpResult = { ...page, status: 301, headers: { location: moved } };

  /** Ports whose gate gives these decisions in turn, and whose web answers with `reply`. */
  function ports(decisions: GateDecision[], reply: (url: string) => HttpResult) {
    const left = [...decisions];
    return {
      gate: {
        async reserve(): Promise<GateDecision> {
          return left.shift()!;
        },
        async record() {},
      },
      http: {
        async get(url: string): Promise<HttpResult> {
          return reply(url);
        },
      },
      async wait() {},
    };
  }

  it('says so on a page that came back, whatever the page said', async () => {
    const flagged = ports([{ ...go, ...refused }], () => page);
    expect(await requestThroughGate(flagged, address, options)).toMatchObject({
      kind: 'answered',
      robotsRefused: true,
    });
    const plain = ports([go], () => page);
    expect(await requestThroughGate(plain, address, options)).toMatchObject({
      kind: 'answered',
      robotsRefused: false,
    });
  });

  it('says so on a request the gate held back', async () => {
    const flagged = ports([{ ...deny, ...refused }], () => page);
    expect(await requestThroughGate(flagged, address, options)).toMatchObject({
      kind: 'denied',
      robotsRefused: true,
    });
    const plain = ports([deny], () => page);
    expect(await requestThroughGate(plain, address, options)).toMatchObject({
      kind: 'denied',
      robotsRefused: false,
    });
  });

  it('says so on a request that got no answer, and on one that stopped waiting', async () => {
    const dropped: HttpResult = { ok: false, error: 'connection reset' };
    const unanswered = ports([{ ...go, ...refused }], () => dropped);
    expect(await requestThroughGate(unanswered, address, options)).toMatchObject({
      kind: 'failed',
      noAnswer: true,
      robotsRefused: true,
    });
    const busy: GateDecision = { kind: 'later', retryAfterMs: 20_000, reason: 'busy' };
    const stopped = ports([{ ...busy, ...refused }], () => page);
    expect(await requestThroughGate(stopped, address, { ...options, giveUp: true })).toMatchObject({
      kind: 'failed',
      noAnswer: false,
      robotsRefused: true,
    });
    const idle = ports([busy], () => page);
    expect(await requestThroughGate(idle, address, { ...options, giveUp: true })).toMatchObject({
      kind: 'failed',
      noAnswer: false,
      robotsRefused: false,
    });
  });

  it('says what the decision for the hop it ended at said', async () => {
    const web = (url: string) => (url === address ? redirect : page);
    const refusedFirst = ports([{ ...go, ...refused }, go], web);
    expect(await requestThroughGate(refusedFirst, address, options)).toMatchObject({
      kind: 'answered',
      url: moved,
      robotsRefused: false,
    });
    const refusedLast = ports([go, { ...go, ...refused }], web);
    expect(await requestThroughGate(refusedLast, address, options)).toMatchObject({
      kind: 'answered',
      url: moved,
      robotsRefused: true,
    });
  });
});

describe('a fetch step that runs again', () => {
  it('logs the fetch once and moves the page’s streak once', async () => {
    const { world, a1 } = await setUp('replayed-fetch');
    const runId = runIdFor('replayed-fetch', world.clock.now());
    // Each fetch step runs twice, as Workflows runs a step again after a crash. The steps that
    // write statements run once, as they would after the crash.
    const ran = new Set<string>();
    const replaying: StepRunner = {
      async do(name, fn) {
        if (name.startsWith('fetch:') && !ran.has(name)) {
          ran.add(name);
          await fn();
        }
        return JSON.parse(JSON.stringify((await fn()) ?? null)) as never;
      },
      async sleep(_name, ms) {
        world.clock.advance(ms);
      },
    };
    await runRefresh({ runId, datasetId: 'replayed-fetch' }, replaying, world.ports);
    const logged = await db.select().from(fetches).where(eq(fetches.itemId, a1.id));
    expect(logged).toHaveLength(1);
    const [item] = await db
      .select({ streak: items.outcomeStreak })
      .from(items)
      .where(eq(items.id, a1.id));
    expect(item!.streak).toBe(1);
  });
});

describe('a run replayed from the steps it finished', () => {
  it('doesn’t fetch or pay for a finished page again, and counts every page once', async () => {
    const { world, a1, a2, b1 } = await setUp('refresh-replayed');
    // What the Workflow keeps of its finished steps, which the second run replays.
    const cache: StepCache = new Map();
    const params = {
      runId: runIdFor('refresh-replayed', world.clock.now()),
      datasetId: 'refresh-replayed',
    };

    // The first run stops in its first batch: B1's request fails once, after A1 was read.
    const web = world.ports.http;
    let failing = true;
    world.ports.http = {
      async get(url, headers) {
        if (failing && url === URLS.b1) {
          failing = false;
          throw new Error('the connection was reset');
        }
        return web.get(url, headers);
      },
    };
    const first = fakeStep(world.clock, cache);
    await expect(runRefresh(params, first.step, world.ports)).rejects.toThrow(
      'the connection was reset',
    );
    expect(first.names).toEqual([
      'load',
      'plan',
      'items:0',
      `fetch:${a1.id}:0`,
      `extract:${a1.id}`,
      `fetch:${b1.id}:0`,
      'fail',
    ]);
    const askedBefore = world.web.requests.length;

    // The same run again. A1's steps come from the cache; B1's fetch threw, so nothing of it did.
    const second = fakeStep(world.clock, cache);
    const summary = await runRefresh(params, second.step, world.ports);
    expect(second.replayed).toEqual([
      'load',
      'plan',
      'items:0',
      `fetch:${a1.id}:0`,
      `extract:${a1.id}`,
    ]);
    expect(second.names).toEqual([
      'load',
      'plan',
      'items:0',
      `fetch:${a1.id}:0`,
      `extract:${a1.id}`,
      `fetch:${b1.id}:0`,
      `extract:${b1.id}`,
      `fetch:${a2.id}:0`,
      `extract:${a2.id}`,
      'sources',
      'resolve',
      'snapshot',
      'captures',
      'finish',
    ]);
    expect(new Set(second.names).size).toBe(second.names.length);

    // Only the pages the first run didn't finish were asked for, and the LLM read each page once.
    expect(world.web.requests.slice(askedBefore).map((sent) => sent.url)).toEqual([
      URLS.b1,
      URLS.a2,
    ]);
    expect(world.llm.calls).toHaveLength(3);
    expect(await db.select().from(fetches).where(eq(fetches.runId, params.runId))).toHaveLength(3);

    // The plan is the first run's. A1 is no longer due, but it was when the run planned, and it
    // counts with the rest: the totals are those of a run that wasn't stopped.
    expect(summary).toMatchObject({
      items: 3,
      live: 3,
      due: 3,
      fetches: { changed: 3, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
      statements: { added: 19, reseen: 0, withdrawn: 0 },
      snapshot: { published: true, generation: 1, records: 3 },
    });
    expect(await getRun(db, params.runId)).toMatchObject({
      status: 'complete',
      summary,
      error: null,
    });
  });

  it('resumes a redirect at the hop that was put off, from the steps it finished', async () => {
    const base = testDefinition('refresh-slow-redirect-replayed');
    await applyDefinition(db, { ...base, policy: { ...base.policy, perHostIntervalMs: 20_000 } });
    const moved = 'https://maker-a.example/products/a1-new';
    const routes = standardRoutes();
    routes[URLS.a1] = { status: 301, headers: { location: '/products/a1-new' } };
    routes[moved] = { status: 200, body: A1() };
    const world = makeWorld(db, routes, { llm: false });
    const cache: StepCache = new Map();
    const params = {
      runId: runIdFor('refresh-slow-redirect-replayed', world.clock.now()),
      datasetId: 'refresh-slow-redirect-replayed',
    };

    // The first run stops when the connection to the page the redirect leads to is reset, after the
    // page that redirected has been asked for and its hop put off.
    const web = world.ports.http;
    let failing = true;
    world.ports.http = {
      async get(url, headers) {
        if (failing && url === moved) {
          failing = false;
          throw new Error('the connection was reset');
        }
        return web.get(url, headers);
      },
    };
    const first = fakeStep(world.clock, cache);
    await expect(runRefresh(params, first.step, world.ports)).rejects.toThrow(
      'the connection was reset',
    );
    expect(world.web.requests.filter((sent) => sent.url === URLS.a1)).toHaveLength(1);

    // The replay takes up the hop from the finished step's result. The page that redirected is not
    // asked for again, and the page is read.
    const second = fakeStep(world.clock, cache);
    const summary = await runRefresh(params, second.step, world.ports);
    expect(world.web.requests.filter((sent) => sent.url === URLS.a1)).toHaveLength(1);
    expect(world.web.requests.filter((sent) => sent.url === moved)).toHaveLength(1);
    expect(summary.fetches).toMatchObject({ changed: 3, failed: 0 });
  });

  it('carries on from a put-off step an earlier version kept, which names no hop to resume at', async () => {
    const { world, a1 } = await setUp('refresh-kept-by-earlier');
    // A run that was waiting for a1 when the Worker was deployed. Its step result has no hop in it.
    const cache: StepCache = new Map([
      [`fetch:${a1.id}:0`, JSON.stringify({ kind: 'later', retryAfterMs: 1000 })],
      [`wait:${a1.id}:0`, undefined],
    ]);
    const params = {
      runId: runIdFor('refresh-kept-by-earlier', world.clock.now()),
      datasetId: 'refresh-kept-by-earlier',
    };
    const { step, replayed } = fakeStep(world.clock, cache);
    const summary = await runRefresh(params, step, world.ports);

    // The page is asked for from its own address, and read.
    expect(replayed).toEqual([`fetch:${a1.id}:0`, `wait:${a1.id}:0`]);
    expect(world.web.requests.filter((sent) => sent.url === URLS.a1)).toHaveLength(1);
    expect(summary.fetches).toMatchObject({ changed: 3 });
  });

  it('finishes a run whose kept definition has no dollar budget, asking no model', async () => {
    const { world, a1 } = await setUp('refresh-kept-no-usd');
    const cache: StepCache = new Map();
    const params = {
      runId: runIdFor('refresh-kept-no-usd', world.clock.now()),
      datasetId: 'refresh-kept-no-usd',
    };
    // The first run stops at its first page, after the load step.
    const web = world.ports.http;
    let failing = true;
    world.ports.http = {
      async get(url, headers) {
        if (failing && url === URLS.a1) {
          failing = false;
          throw new Error('the connection was reset');
        }
        return web.get(url, headers);
      },
    };
    await expect(
      runRefresh(params, fakeStep(world.clock, cache).step, world.ports),
    ).rejects.toThrow('the connection was reset');
    // The Worker was deployed meanwhile: the load step's result is the earlier version's, whose
    // budget counted tokens (ADR 0010).
    const kept = JSON.parse(cache.get('load')!) as {
      definition: { budget: Record<string, unknown> };
    };
    delete kept.definition.budget.llmUsdPerRun;
    kept.definition.budget.llmTokensPerRun = 1_000_000;
    cache.set('load', JSON.stringify(kept));

    const summary = await runRefresh(params, fakeStep(world.clock, cache).step, world.ports);
    expect(world.llm.calls).toHaveLength(0);
    expect(summary.notes.join('\n')).toMatch(/pages? waits? for the next run: .*budget of \$0\.00/);
    expect(a1.id).toBeDefined();
  });

  it('pauses a source at the same page as a run that wasn’t stopped', async () => {
    const base = testDefinition('refresh-pause-replayed');
    const pages = ['a1', 'a2', 'a3', 'a4', 'a5'].map(
      (name) => `https://maker-a.example/products/${name}`,
    );
    await applyDefinition(db, {
      ...base,
      sources: base.sources.map((source) =>
        source.id === 'maker-a' && source.kind === 'pages' ? { ...source, pages } : source,
      ),
    });
    const routes = standardRoutes();
    for (const url of pages) {
      routes[url] = { status: 403, headers: { 'cf-mitigated': 'challenge' } };
    }
    const world = makeWorld(db, routes);
    const [a1] = await listLiveItems(db, 'refresh-pause-replayed');
    const cache: StepCache = new Map();
    const params = {
      runId: runIdFor('refresh-pause-replayed', world.clock.now()),
      datasetId: 'refresh-pause-replayed',
    };

    // The first run stops at a2's request, after a1 was blocked and b1 was read.
    const web = world.ports.http;
    let failing = true;
    world.ports.http = {
      async get(url, headers) {
        if (failing && url === pages[1]) {
          failing = false;
          throw new Error('the connection was reset');
        }
        return web.get(url, headers);
      },
    };
    const first = fakeStep(world.clock, cache);
    await expect(runRefresh(params, first.step, world.ports)).rejects.toThrow(
      'the connection was reset',
    );

    // The replay counts a1's block from its finished step, which is not run again, and so pauses
    // maker-a after a3 as a run that wasn't stopped does.
    const askedBefore = world.web.requests.length;
    const second = fakeStep(world.clock, cache);
    const summary = await runRefresh(params, second.step, world.ports);
    expect(second.replayed).toContain(`fetch:${a1!.id}:0`);
    const asked = world.web.requests.slice(askedBefore).map((sent) => sent.url);
    expect(asked).not.toContain(pages[0]);
    expect(asked).toEqual(expect.arrayContaining([pages[1], pages[2]]));
    expect(asked).not.toContain(pages[3]);
    expect(asked).not.toContain(pages[4]);
    expect(summary.fetches).toMatchObject({ blocked: 3, changed: 1 });
    expect(summary.paused).toEqual({ 'maker-a': 2 });
    expect(summary.items).toBe(4);
  });

  /**
   * A dataset whose maker-a answers 503 to all five of its pages, and a run of it that stops at
   * a2's request, after a1 strained its host and b1 was read. `cache` is what a replay reads.
   */
  async function strainedRunStoppedAtA2(datasetId: string) {
    const pages = await makerAPages(datasetId, ['a1', 'a2', 'a3', 'a4', 'a5']);
    const routes = standardRoutes();
    for (const url of pages) routes[url] = { status: 503 };
    const world = makeWorld(db, routes);
    const [a1] = await listLiveItems(db, datasetId);
    const cache: StepCache = new Map();
    const params = { runId: runIdFor(datasetId, world.clock.now()), datasetId };
    const web = world.ports.http;
    let failing = true;
    world.ports.http = {
      async get(url, headers) {
        if (failing && url === pages[1]) {
          failing = false;
          throw new Error('the connection was reset');
        }
        return web.get(url, headers);
      },
    };
    const first = fakeStep(world.clock, cache);
    await expect(runRefresh(params, first.step, world.ports)).rejects.toThrow(
      'the connection was reset',
    );
    return { world, pages, a1: a1!, cache, params };
  }

  it('pauses a straining source at the same page as a run that wasn’t stopped', async () => {
    const { world, pages, a1, cache, params } =
      await strainedRunStoppedAtA2('refresh-strain-replayed');

    // The replay counts a1's strain from its finished step, which is not run again, and so pauses
    // maker-a after a3 as a run that wasn't stopped does.
    const askedBefore = world.web.requests.length;
    const second = fakeStep(world.clock, cache);
    const summary = await runRefresh(params, second.step, world.ports);
    expect(second.replayed).toContain(`fetch:${a1.id}:0`);
    const asked = world.web.requests.slice(askedBefore).map((sent) => sent.url);
    expect(asked).not.toContain(pages[0]);
    expect(asked).toEqual(expect.arrayContaining([pages[1], pages[2]]));
    expect(asked).not.toContain(pages[3]);
    expect(asked).not.toContain(pages[4]);
    expect(summary.fetches).toMatchObject({ failed: 3, changed: 1 });
    expect(summary.paused).toEqual({ 'maker-a': 2 });
    expect(summary.items).toBe(4);
  });

  it('counts no strain for a page whose fetch step an earlier version kept', async () => {
    const { world, pages, a1, cache, params } =
      await strainedRunStoppedAtA2('refresh-strain-earlier');
    // The Worker was deployed while the run was stopped, and a1's step result is the earlier
    // version's, which said nothing of strain.
    const key = `fetch:${a1.id}:0`;
    const kept = JSON.parse(cache.get(key)!) as { fetched: Record<string, unknown> };
    delete kept.fetched.strained;
    cache.set(key, JSON.stringify(kept));

    // a1 doesn't count, so the count starts at a2, and a4 is the third page in a row.
    const askedBefore = world.web.requests.length;
    const summary = await runRefresh(params, fakeStep(world.clock, cache).step, world.ports);
    const asked = world.web.requests.slice(askedBefore).map((sent) => sent.url);
    expect(asked).toEqual(expect.arrayContaining([pages[1], pages[2], pages[3]]));
    expect(asked).not.toContain(pages[4]);
    expect(summary.paused).toEqual({ 'maker-a': 1 });
  });
});
