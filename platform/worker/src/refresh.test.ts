import {
  normalizeGtin,
  runIdFor,
  sha256Hex,
  snapshotSchema,
  type Candidate,
  type Page,
  type PagesSource,
} from '@spatula/core';
import { packs } from '@spatula/pack-products';
import {
  applyDefinition,
  fetches,
  getRun,
  items,
  latestSnapshot,
  listLiveItems,
  statements,
} from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import { fakeLlm, fakeStep, makeWorld, type World } from '../test/node/fakes';
import { A1, A2, answerFor, B1, standardRoutes, URLS } from '../test/pages';
import {
  classifyResponse,
  DatasetMissingError,
  extractionTag,
  MAX_NOTES,
  MAX_PAGE_STATEMENTS,
  runRefresh,
  type StepRunner,
} from './refresh';

const HOUR = 3_600_000;

/**
 * One run of the dataset, then five minutes, so the next run gets its own ID. Workflows keep each
 * step's result, so the run keeps them too, for tests that look at what a step returned.
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

/** The latest snapshot's row and file, checking the file against its recorded hash. */
async function published(world: World, datasetId: string) {
  const row = await latestSnapshot(db, datasetId);
  if (row === null) return null;
  const body = world.stored.get(row.key)!;
  expect(await sha256Hex(body)).toBe(row.sha256);
  const snapshot = snapshotSchema.parse(JSON.parse(new TextDecoder().decode(body)));
  const byName = Object.fromEntries(
    snapshot.records.map((record) => [String(record.fields.name), record]),
  );
  return { row, snapshot, byName };
}

const fetchOf = async (runId: string, url: string) =>
  (
    await db
      .select()
      .from(fetches)
      .where(and(eq(fetches.runId, runId), eq(fetches.url, url)))
  )[0]!;

const entityOf = async (itemId: string) =>
  (await db.select({ entityId: items.entityId }).from(items).where(eq(items.id, itemId)))[0]!
    .entityId;

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

describe('runRefresh', () => {
  it('collects, identifies, and publishes, then publishes nothing when nothing changed', async () => {
    const { world, a1, a2, b1 } = await setUp('refresh-basics');

    const first = await refresh(world, 'refresh-basics');
    expect(first.names).toEqual([
      'load',
      `fetch:${a1.id}:0`,
      `extract:${a1.id}`,
      `fetch:${a2.id}:0`,
      `extract:${a2.id}`,
      `fetch:${b1.id}:0`,
      `extract:${b1.id}`,
      'resolve',
      'snapshot',
      'finish',
    ]);
    expect(first.summary).toMatchObject({
      items: 3,
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
    // Review Focus 1: the UPC in A1's mpn is published as a GTIN, never as a part number.
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
    // Review Focus 4: A2's text was the same, so the LLM wasn't asked again.
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
    // Review Focus 3: robots.txt was asked for, and the page wasn't.
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
    // Review Focus 2: the name isn't taken from og:title; the record is left out and listed.
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
      cut(`${URLS.a2}: the LLM call failed: llm  ${'x'.repeat(600)}`),
    ]);
    // The fetch log says what the LLM step did. A NUL in that text would have failed the insert
    // after the LLM had been paid for.
    expect((await fetchOf(first.runId, URLS.a2)).llm).toBe(cut(`failed: llm  ${'x'.repeat(600)}`));
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
