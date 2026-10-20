import { gunzip, runIdFor, sha256Hex } from '@spatula/core';
import { captures, latestCapture, listOpenReviews, statements } from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import { fakeDecider, fakeStep, type StepCache } from '../test/node/fakes';
import { decidedDefinition, refresh, worldFor } from '../test/node/runs';
import { A1, standardRoutes, URLS } from '../test/pages';
import { rawPageKey, readCapture, readKey, readPageBody } from './captures';
import { pageKey } from './pipeline';
import { runRefresh } from './refresh';
import { answerReview } from './review';

/** A page's captures, oldest first. */
const capturesOf = (itemId: string) =>
  db
    .select()
    .from(captures)
    .where(eq(captures.itemId, itemId))
    .orderBy(asc(captures.fetchedAt), asc(captures.id));

/** The capture each of a page's current statements cites, by its method and value. */
async function citations(itemId: string): Promise<Record<string, string | null>> {
  const rows = await db
    .select({
      method: statements.method,
      valueKey: statements.valueKey,
      captureId: statements.captureId,
    })
    .from(statements)
    .where(and(eq(statements.itemId, itemId), isNull(statements.withdrawnAt)));
  return Object.fromEntries(rows.map((row) => [`${row.method} ${row.valueKey}`, row.captureId]));
}

// Each test runs the pipeline against a real database, several runs in most.
describe('the page archive', { timeout: 20_000 }, () => {
  it('keeps a changed page’s body gzipped under its hash, with how it was fetched', async () => {
    const {
      world,
      pages: [a1],
    } = await worldFor(testDefinition('archive-first'), standardRoutes());
    const { summary } = await refresh(world, 'archive-first');
    const body = new TextEncoder().encode(A1());
    const hash = await sha256Hex(body);
    const file = world.stored.get(pageKey(hash))!;
    expect(await gunzip(file)).toEqual(body);
    expect(world.stored.has(rawPageKey(hash))).toBe(false);
    const [capture] = await capturesOf(a1!.id);
    expect(capture).toMatchObject({
      datasetId: 'archive-first',
      sourceId: 'maker-a',
      url: URLS.a1,
      finalUrl: URLS.a1,
      httpStatus: 200,
      etag: '"a1-v1"',
      lastModified: null,
      contentHash: hash,
      bytes: body.byteLength,
      storedBytes: file.byteLength,
      signals: {},
      readKey: readKey('archive-first', capture!.id),
      reader: 1,
    });
    expect(capture!.id).toMatch(/^cp_/u);
    expect(summary.captures).toEqual({ stored: 3, pruned: 0 });
    // What Spatula read is kept with it, and reads back.
    expect(await readCapture(world.ports, capture!)).toMatchObject({
      url: URLS.a1,
      canonicalUrl: URLS.a1,
      title: 'A1 | Maker A',
      jsonLd: [expect.objectContaining({ name: 'A1' })],
      text: 'A1 Impedance: 300 Ω Weight: 350 g',
    });
  });

  it('stores nothing new when a page comes back the same, and a 304 adds nothing', async () => {
    const {
      world,
      pages: [a1],
    } = await worldFor(testDefinition('archive-same'), standardRoutes());
    await refresh(world, 'archive-same');
    const files = world.stored.size;
    expect((await refresh(world, 'archive-same')).summary.captures).toEqual({
      stored: 0,
      pruned: 0,
    });
    // A1's ETag goes with the request, and the site says nothing changed.
    world.web.routes.set(URLS.a1, { status: 304 });
    const unchanged = await refresh(world, 'archive-same');
    expect(unchanged.summary.fetches.unchanged).toBe(3);
    expect(unchanged.summary.captures).toEqual({ stored: 0, pruned: 0 });
    expect(await capturesOf(a1!.id)).toHaveLength(1);
    expect(world.stored.size).toBe(files);
  });

  it('gives a page stored before the archive its first capture, and its values their evidence', async () => {
    const {
      world,
      pages: [a1],
    } = await worldFor(testDefinition('archive-older'), standardRoutes());
    await refresh(world, 'archive-older');
    // A1 as the archive finds it: its page kept raw under its bare hash, and no capture of it.
    const hash = await sha256Hex(A1());
    const raw = await gunzip(world.stored.get(pageKey(hash))!);
    world.stored.delete(pageKey(hash));
    world.stored.set(rawPageKey(hash), raw);
    await db.delete(captures).where(eq(captures.itemId, a1!.id));
    expect(Object.values(await citations(a1!.id)).every((captureId) => captureId === null)).toBe(
      true,
    );
    expect(await readPageBody(world.ports.blobs, hash)).toEqual(raw);
    expect(await readPageBody(world.ports.blobs, '0'.repeat(64))).toBeNull();

    // It answers 304: its stored copy becomes its first capture, and its values cite it.
    world.web.routes.set(URLS.a1, { status: 304 });
    const { summary } = await refresh(world, 'archive-older');
    expect(summary.captures).toEqual({ stored: 1, pruned: 0 });
    const [first] = await capturesOf(a1!.id);
    expect(first).toMatchObject({
      contentHash: hash,
      httpStatus: 304,
      bytes: null,
      storedBytes: null,
      etag: '"a1-v1"',
      readKey: null,
    });
    const cited = Object.values(await citations(a1!.id));
    expect(cited.length).toBeGreaterThan(0);
    expect(new Set(cited)).toEqual(new Set([first!.id]));

    // Its read is made from the copy stored before the archive, and kept.
    expect(await readCapture(world.ports, first!)).toMatchObject({
      url: URLS.a1,
      title: 'A1 | Maker A',
    });
    expect((await latestCapture(db, a1!.id))!.readKey).toBe(readKey('archive-older', first!.id));
    expect(world.stored.has(readKey('archive-older', first!.id))).toBe(true);
  });

  it('cites a changed page’s new capture in its new values, and the first in the rest', async () => {
    const {
      world,
      pages: [a1],
    } = await worldFor(testDefinition('archive-cited'), standardRoutes());
    await refresh(world, 'archive-cited');
    world.web.routes.set(URLS.a1, {
      status: 200,
      body: A1('two').replace('"name":"A1"', '"name":"A1 Pro"'),
    });
    await refresh(world, 'archive-cited');
    const [first, second] = await capturesOf(a1!.id);
    // A capture records the validators its own response carried: the second's sent none.
    expect(first!.etag).toBe('"a1-v1"');
    expect(second!.etag).toBeNull();
    expect(second!.lastModified).toBeNull();
    const cited = await citations(a1!.id);
    expect(cited['jsonld A1 Pro']).toBe(second!.id);
    expect(cited['rule Maker A']).toBe(first!.id);
    expect(await readCapture(world.ports, second!)).toMatchObject({
      jsonLd: [expect.objectContaining({ name: 'A1 Pro' })],
    });
  });

  it('records a capture’s read key before its file, so a failed write leaves a read to remake', async () => {
    const {
      world,
      pages: [a1],
    } = await worldFor(testDefinition('archive-read-fails'), standardRoutes());
    const real = world.ports.blobs;
    // Every write under captures/ fails; the pages' bodies and the snapshot still go through.
    world.ports.blobs = {
      ...real,
      async put(key, body, contentType) {
        if (key.startsWith('captures/')) throw new Error('R2 refused the write');
        await real.put(key, body, contentType);
      },
    };
    const { summary } = await refresh(world, 'archive-read-fails');
    expect(summary.captures).toEqual({ stored: 3, pruned: 0 });
    const [capture] = await capturesOf(a1!.id);
    const key = readKey('archive-read-fails', capture!.id);
    expect(capture!.readKey).toBe(key);
    expect(world.stored.has(key)).toBe(false);

    // With the store back, the read is made again from the body, and kept under the same key.
    world.ports.blobs = real;
    expect(await readCapture(world.ports, capture!)).toMatchObject({ title: 'A1 | Maker A' });
    expect(world.stored.has(key)).toBe(true);
  });

  it('cites the capture in a decided category, and in a person’s answer', async () => {
    const sure = await worldFor(decidedDefinition('archive-decided'), standardRoutes());
    await refresh(sure.world, 'archive-decided');
    const decidedPage = sure.pages[0]!;
    const [decidedCapture] = await capturesOf(decidedPage.id);
    expect((await citations(decidedPage.id))['llm Headphones']).toBe(decidedCapture!.id);

    const unsure = await worldFor(decidedDefinition('archive-asked'), standardRoutes());
    unsure.world.ports.decider = fakeDecider(() => ({ Headphones: 0.6, 'DAC/Amp': 0.3 })).decider;
    await refresh(unsure.world, 'archive-asked');
    const asked = unsure.pages[0]!;
    const question = (await listOpenReviews(db, 'archive-asked')).find(
      (review) => review.subject === asked.id,
    )!;
    await answerReview(unsure.world.ports, {
      datasetId: 'archive-asked',
      reviewId: question.id,
      answer: 'Headphones',
    });
    const [capture] = await capturesOf(asked.id);
    expect((await citations(asked.id))['human Headphones']).toBe(capture!.id);
  });

  it('reads a fetch result without a capture, as an earlier version kept it, as none', async () => {
    const {
      world,
      pages: [a1],
    } = await worldFor(testDefinition('archive-replay'), standardRoutes());
    const runId = runIdFor('archive-replay', world.clock.now());
    const cache: StepCache = new Map();
    const first = fakeStep(world.clock, cache);
    await runRefresh({ runId, datasetId: 'archive-replay', all: true }, first.step, world.ports);
    // As an earlier version kept it: the fetch's result names no capture. Its extract step runs again.
    const fetchStep = `fetch:${a1!.id}:0`;
    const kept = JSON.parse(cache.get(fetchStep)!) as { fetched: Record<string, unknown> };
    delete kept.fetched.captureId;
    delete kept.fetched.captured;
    cache.set(fetchStep, JSON.stringify(kept));
    cache.delete(`extract:${a1!.id}`);
    await db.delete(statements).where(eq(statements.itemId, a1!.id));

    const again = fakeStep(world.clock, cache);
    await runRefresh({ runId, datasetId: 'archive-replay', all: true }, again.step, world.ports);
    expect(again.replayed).toContain(fetchStep);
    expect(again.replayed).not.toContain(`extract:${a1!.id}`);
    const cited = Object.values(await citations(a1!.id));
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.every((captureId) => captureId === null)).toBe(true);
  });
});
