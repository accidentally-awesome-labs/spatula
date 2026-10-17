import { runIdFor, type Definition, type RunSummary } from '@spatula/core';
import {
  applyDefinition,
  datasets,
  latestSnapshot,
  listOpenReviews,
  setItemStatus,
  snapshotById,
} from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import { fakeDecider, fakeStep } from '../test/node/fakes';
import { decidedDefinition, published, refresh, worldFor } from '../test/node/runs';
import { A1, productPage, standardRoutes, URLS } from '../test/pages';
import { heldKey, type Context } from './pipeline';
import { publish, publishHeldSnapshot, SnapshotFileMissingError } from './publish';
import { runRefresh } from './refresh';

/** The test dataset, under another approval preset and removal guard. */
const gated = (
  datasetId: string,
  approval: Definition['publication']['approval'],
  maxRemovals = { count: 25, share: 0.05 },
): Definition => ({
  ...testDefinition(datasetId),
  publication: { approval },
  gates: { maxRemovals },
});

/** The definition without maker-b, whose one record then leaves the snapshot. */
const withoutMakerB = (definition: Definition): Definition => ({
  ...definition,
  sources: definition.sources.filter((source) => source.id === 'maker-a'),
});

/** A1's page, renamed, so a run's records change. */
const renamedA1 = () => A1('two').replace('"name":"A1"', '"name":"A1 Mk II"');

/** The snapshot a run held for review, from its summary. */
const heldId = (summary: RunSummary) =>
  summary.snapshot.published ? '' : (summary.snapshot.held?.snapshotId ?? '');

/** What a dataset's open publication questions are about. */
const publicationQuestions = async (datasetId: string) =>
  (await listOpenReviews(db, datasetId)).filter((review) => review.kind === 'publication');

const HOUR = 3_600_000;
const NO_AI_INPUT = 'User-agent: *\nContent-Signal: ai-input=no\nAllow: /\n';

describe('publishing through the gates', { timeout: 20_000 }, () => {
  it('holds a balanced dataset’s first publication until the owner publishes it', async () => {
    const { world } = await worldFor(gated('publish-first', 'balanced'), standardRoutes());
    const first = await refresh(world, 'publish-first');
    expect(first.summary.snapshot).toMatchObject({
      published: false,
      reason: 'it’s held for review: it’s the dataset’s first publication',
      held: { records: 3, reasons: ['it’s the dataset’s first publication'] },
    });
    const snapshotId = heldId(first.summary);
    expect(await latestSnapshot(db, 'publish-first')).toBeNull();
    // Its records wait in the blob store, without a generation.
    const draft = world.stored.get(heldKey('publish-first', snapshotId))!;
    expect(JSON.parse(new TextDecoder().decode(draft))).toMatchObject({
      project: 'publish-first',
      snapshotId,
      records: [{}, {}, {}],
    });
    expect(await listOpenReviews(db, 'publish-first')).toMatchObject([
      {
        kind: 'publication',
        subject: snapshotId,
        question: { type: 'choice', options: ['publish', 'discard'] },
        context: { snapshotId, records: 3, added: 3, removed: 0, previousGeneration: null },
      },
    ]);

    // A run that finds nothing new keeps the held snapshot, and holds no other.
    const second = await refresh(world, 'publish-first');
    expect(second.summary.snapshot).toMatchObject({
      published: false,
      reason: 'the snapshot held for review is unchanged',
      held: { snapshotId },
    });

    expect(
      await publishHeldSnapshot(world.ports, { datasetId: 'publish-first', snapshotId }),
    ).toEqual({ kind: 'published', generation: 1 });
    const file = (await published(world, 'publish-first'))!;
    expect(file.row).toMatchObject({ id: snapshotId, generation: 1 });
    expect(file.snapshot).toMatchObject({ project: 'publish-first', snapshotId, generation: 1 });
    expect(await listOpenReviews(db, 'publish-first')).toEqual([]);

    // The definition hasn't changed since, so a run whose records changed publishes on its own.
    world.web.routes.set(URLS.a1, { status: 200, body: renamedA1() });
    const third = await refresh(world, 'publish-first');
    expect(third.summary.snapshot).toMatchObject({ published: true, generation: 2 });
  });

  it('holds the first publication after the definition changed, under balanced', async () => {
    const definition = gated('publish-revision', 'balanced');
    const { world } = await worldFor(definition, standardRoutes());
    const first = heldId((await refresh(world, 'publish-revision')).summary);
    await publishHeldSnapshot(world.ports, { datasetId: 'publish-revision', snapshotId: first });

    // The definition moves to revision 2, and a page's records change.
    await applyDefinition(db, { ...definition, freshness: { maxAgeDays: 6 } });
    world.web.routes.set(URLS.a1, { status: 200, body: renamedA1() });
    const second = await refresh(world, 'publish-revision');
    expect(second.summary.snapshot).toMatchObject({
      published: false,
      held: { reasons: ['the definition changed since the last publication (revision 1 to 2)'] },
    });
  });

  it('writes nothing for a held snapshot that is stale or another dataset’s', async () => {
    const { world } = await worldFor(gated('publish-theirs', 'balanced'), standardRoutes());
    const older = heldId((await refresh(world, 'publish-theirs')).summary);
    world.web.routes.set(URLS.a1, { status: 200, body: renamedA1() });
    const newer = heldId((await refresh(world, 'publish-theirs')).summary);
    const files = [...world.stored.keys()].sort();

    expect(
      await publishHeldSnapshot(world.ports, { datasetId: 'publish-theirs', snapshotId: older }),
    ).toEqual({ kind: 'stale', state: 'superseded' });
    expect(
      await publishHeldSnapshot(world.ports, { datasetId: 'publish-other', snapshotId: newer }),
    ).toEqual({ kind: 'stale', state: 'missing' });
    // Neither wrote a file, and the newer snapshot is still held.
    expect([...world.stored.keys()].sort()).toEqual(files);
    expect((await snapshotById(db, newer))?.state).toBe('held');
  });

  it('holds a new snapshot when the definition changed since the last one was held', async () => {
    const definition = gated('publish-reheld', 'balanced');
    const { world } = await worldFor(definition, standardRoutes());
    const first = heldId((await refresh(world, 'publish-reheld')).summary);

    // The records are the same, but the definition has moved on, so the snapshot held under
    // revision 1 isn't the one this run would hold.
    await applyDefinition(db, { ...definition, freshness: { maxAgeDays: 6 } });
    const next = heldId((await refresh(world, 'publish-reheld')).summary);
    expect(next).not.toBe(first);
    expect((await snapshotById(db, first))?.state).toBe('superseded');
    expect(await snapshotById(db, next)).toMatchObject({ state: 'held', revision: 2 });
  });

  it('holds a snapshot that drops too many records, and lets a newer one supersede it', async () => {
    const strict = gated('publish-removals', 'auto', { count: 0, share: 0 });
    const { world } = await worldFor(strict, standardRoutes());
    expect((await refresh(world, 'publish-removals')).summary.snapshot).toMatchObject({
      published: true,
      generation: 1,
    });

    // One removal is more than this guard allows.
    await applyDefinition(db, withoutMakerB(strict));
    const second = await refresh(world, 'publish-removals');
    expect(second.summary.snapshot).toMatchObject({
      published: false,
      held: {
        records: 2,
        reasons: [
          'it drops 1 of 3 published records, more than the guard allows (0 records or 0%)',
        ],
      },
    });
    const older = heldId(second.summary);

    // A newer run's snapshot supersedes it, and its question is dismissed.
    world.web.routes.set(URLS.a1, { status: 200, body: renamedA1() });
    const newer = heldId((await refresh(world, 'publish-removals')).summary);
    expect(newer).not.toBe(older);
    expect((await snapshotById(db, older))?.state).toBe('superseded');
    expect((await listOpenReviews(db, 'publish-removals')).map((review) => review.subject)).toEqual(
      [newer],
    );
    expect(
      await publishHeldSnapshot(world.ports, { datasetId: 'publish-removals', snapshotId: older }),
    ).toEqual({ kind: 'stale', state: 'superseded' });

    // Should another publication move the head while this one is written, this one takes the
    // generation after it, never one already taken.
    let raced = false;
    const racing = {
      ...world.ports,
      blobs: {
        ...world.ports.blobs,
        async put(key: string, body: Uint8Array | string, contentType: string) {
          await world.ports.blobs.put(key, body, contentType);
          if (raced) return;
          raced = true;
          await db
            .update(datasets)
            .set({ headGeneration: 2 })
            .where(eq(datasets.id, 'publish-removals'));
        },
      },
    };
    expect(
      await publishHeldSnapshot(racing, { datasetId: 'publish-removals', snapshotId: newer }),
    ).toEqual({ kind: 'published', generation: 3 });
  });

  it('supersedes a held snapshot when a newer run finds the published records again', async () => {
    const strict = gated('publish-back', 'auto', { count: 0, share: 0 });
    const { world } = await worldFor(strict, standardRoutes());
    await refresh(world, 'publish-back');
    await applyDefinition(db, withoutMakerB(strict));
    const held = heldId((await refresh(world, 'publish-back')).summary);
    expect(held).not.toBe('');

    // Maker-b comes back, and with it the records generation 1 published.
    await applyDefinition(db, strict);
    const back = await refresh(world, 'publish-back');
    expect(back.summary.snapshot).toMatchObject({
      published: false,
      reason: 'nothing changed since generation 1, so the snapshot held for review is superseded',
    });
    expect((await snapshotById(db, held))?.state).toBe('superseded');
    expect(await listOpenReviews(db, 'publish-back')).toEqual([]);
  });

  it('supersedes a held snapshot when a newer run finds no record complete', async () => {
    const { world, pages } = await worldFor(gated('publish-empty', 'balanced'), standardRoutes());
    const held = heldId((await refresh(world, 'publish-empty')).summary);
    expect(held).not.toBe('');

    // Every page leaves the dataset. Publishing the held snapshot now would bring back records no
    // run finds.
    for (const page of pages) await setItemStatus(db, page.id, 'excluded');
    const second = await refresh(world, 'publish-empty');
    expect(second.summary.snapshot).toMatchObject({
      published: false,
      reason: 'no record is complete, so the snapshot held for review is superseded',
    });
    expect((await snapshotById(db, held))?.state).toBe('superseded');
    expect(await listOpenReviews(db, 'publish-empty')).toEqual([]);

    // With nothing held, it says no more than it did.
    const third = await refresh(world, 'publish-empty');
    expect(third.summary.snapshot).toMatchObject({
      published: false,
      reason: 'no record is complete',
    });
  });

  it('keeps a held snapshot when the new records break the published format', async () => {
    const { world } = await worldFor(gated('publish-format', 'balanced'), standardRoutes());
    const held = heldId((await refresh(world, 'publish-format')).summary);
    world.web.routes.set(URLS.a1, { status: 200, body: renamedA1() });

    // Once the run reaches its snapshot, its clock reads a year that the format's ISO times can't
    // carry (+010000-…). That's a fault in the new run, not news about the data.
    const { step } = fakeStep(world.clock);
    const summary = await runRefresh(
      {
        runId: runIdFor('publish-format', world.clock.now()),
        datasetId: 'publish-format',
        all: true,
      },
      {
        ...step,
        async do(name, fn) {
          if (name === 'snapshot') world.clock.ms = Date.UTC(10_000, 0, 1);
          return step.do(name, fn);
        },
      },
      world.ports,
    );
    expect(summary.snapshot).toMatchObject({
      published: false,
      reason:
        'the snapshot breaks the published format at publishedAt: Invalid ISO datetime, so the snapshot held for review stays',
      held: { snapshotId: held },
    });
    expect((await snapshotById(db, held))?.state).toBe('held');
    expect((await publicationQuestions('publish-format')).map((review) => review.subject)).toEqual([
      held,
    ]);
  });

  it('keeps the published file whole when two answers publish one snapshot at once', async () => {
    const { world } = await worldFor(gated('publish-twice', 'balanced'), standardRoutes());
    const snapshotId = heldId((await refresh(world, 'publish-twice')).summary);
    // The second answer reads the snapshot as held, then the first publishes it before the second
    // writes its file. The second's file, a second later, mustn't replace the one the row names.
    let first = true;
    const second = {
      ...world.ports,
      now: () => new Date(world.ports.now().getTime() + 1000),
      blobs: {
        ...world.ports.blobs,
        async put(key: string, body: Uint8Array | string, contentType: string) {
          if (first) {
            first = false;
            expect(
              await publishHeldSnapshot(world.ports, { datasetId: 'publish-twice', snapshotId }),
            ).toEqual({ kind: 'published', generation: 1 });
          }
          await world.ports.blobs.put(key, body, contentType);
        },
      },
    };
    expect(await publishHeldSnapshot(second, { datasetId: 'publish-twice', snapshotId })).toEqual({
      kind: 'stale',
      state: 'published',
    });
    // published() checks the file the row names against the row's hash.
    expect((await published(world, 'publish-twice'))!.row).toMatchObject({
      id: snapshotId,
      generation: 1,
    });
  });

  it('keeps the published file whole when a run’s snapshot step runs twice at once', async () => {
    const definition = gated('publish-dupe', 'auto');
    const { world } = await worldFor(definition, standardRoutes());
    await refresh(world, 'publish-dupe');

    // A run that reads A1's new name but stops short of its snapshot, which two attempts at the
    // step then make by hand. Both make the run's one snapshot ID, and both want generation 2.
    world.web.routes.set(URLS.a1, { status: 200, body: renamedA1() });
    const runId = runIdFor('publish-dupe', world.clock.now());
    const { step } = fakeStep(world.clock);
    await runRefresh(
      { runId, datasetId: 'publish-dupe', all: true },
      {
        ...step,
        async do(name, fn) {
          if (name === 'snapshot')
            return { published: false, reason: 'stopped', excluded: [] } as never;
          return step.do(name, fn);
        },
      },
      world.ports,
    );
    const context: Context = {
      runId,
      datasetId: 'publish-dupe',
      revision: 1,
      definition,
      startedAt: world.clock.now(),
    };

    // The first attempt has made its file and waits to write it. The second, a second later, runs
    // through and publishes. The first's file, written after the second's row is committed,
    // mustn't replace the one that row names.
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = {
      ...world.ports,
      blobs: {
        ...world.ports.blobs,
        async put(key: string, body: Uint8Array | string, contentType: string) {
          reached();
          await gate;
          await world.ports.blobs.put(key, body, contentType);
        },
      },
    };
    const late = publish(context, slow);
    // Settled by the end, whatever the test finds, so the first attempt never fails unobserved.
    const lateEnded = late.then(
      () => undefined,
      () => undefined,
    );
    await arrived;
    const quick = await publish(context, {
      ...world.ports,
      now: () => new Date(world.ports.now().getTime() + 1000),
    });
    expect(quick).toMatchObject({ published: true, generation: 2 });
    release();
    await expect(late).rejects.toThrow('Generation 2 was published by another run');
    await lateEnded;
    // published() checks the file the row names against the row's hash.
    expect((await published(world, 'publish-dupe'))!.row).toMatchObject({ generation: 2 });
  });

  it('reports what a run made when its snapshot step runs again', async () => {
    const definition = gated('publish-replay', 'balanced');
    const { world } = await worldFor(definition, standardRoutes());
    const contextOf = (runId: string): Context => ({
      runId,
      datasetId: 'publish-replay',
      revision: 1,
      definition,
      startedAt: world.clock.now(),
    });
    const first = await refresh(world, 'publish-replay');
    expect(await publish(contextOf(first.runId), world.ports)).toEqual(first.summary.snapshot);

    // A newer run holds a snapshot of its own, which supersedes the first run's.
    world.web.routes.set(URLS.a1, { status: 200, body: renamedA1() });
    const second = await refresh(world, 'publish-replay');
    expect(await publish(contextOf(first.runId), world.ports)).toMatchObject({
      published: false,
      reason: 'its snapshot was superseded',
    });
    expect(await publish(contextOf(second.runId), world.ports)).toEqual(second.summary.snapshot);

    // Once the owner publishes the second run's, so does a replay of its step.
    const snapshotId = heldId(second.summary);
    await publishHeldSnapshot(world.ports, { datasetId: 'publish-replay', snapshotId });
    expect(await publish(contextOf(second.runId), world.ports)).toMatchObject({
      published: true,
      generation: 1,
      snapshotId,
      records: 3,
    });
  });

  it('publishes a held snapshot though the stored definition no longer passes the checks', async () => {
    const { world } = await worldFor(gated('publish-stale', 'balanced'), standardRoutes());
    const snapshotId = heldId((await refresh(world, 'publish-stale')).summary);
    // A later version's stricter checks would leave a stored definition like this one. It mustn't
    // keep the owner from publishing what is held.
    await db
      .update(datasets)
      .set({ definition: { ...testDefinition('publish-stale'), consumers: ['Not A Slug'] } })
      .where(eq(datasets.id, 'publish-stale'));
    expect(
      await publishHeldSnapshot(world.ports, { datasetId: 'publish-stale', snapshotId }),
    ).toEqual({ kind: 'published', generation: 1 });
  });
});

describe('what the owner is told about a hold', { timeout: 20_000 }, () => {
  it('says why records left, when a withdrawal makes the guard hold the snapshot', async () => {
    const strict = decidedDefinition('publish-withdrawn', {
      gates: { maxRemovals: { count: 0, share: 0 } },
    });
    const { world } = await worldFor(strict, standardRoutes(), { llm: false });
    expect((await refresh(world, 'publish-withdrawn')).summary.snapshot).toMatchObject({
      published: true,
      generation: 1,
      records: 3,
    });

    // Maker A stops allowing AI input, so the decider's answers for its two pages are taken back.
    // Their records lack a category, and the two pages wait for a person.
    world.clock.advance(25 * HOUR);
    world.web.routes.set('https://maker-a.example/robots.txt', { status: 200, body: NO_AI_INPUT });
    const second = await refresh(world, 'publish-withdrawn');
    expect(second.summary.snapshot).toMatchObject({
      published: false,
      held: {
        records: 1,
        reasons: [
          'it drops 2 of 3 published records, more than the guard allows (0 records or 0%)',
        ],
      },
    });
    const [question] = await publicationQuestions('publish-withdrawn');
    expect(question!.context).toMatchObject({
      records: 1,
      added: 0,
      removed: 2,
      previousGeneration: 1,
      incomplete: 2,
      openClassify: 2,
      openMatch: 0,
    });
  });

  it('counts the match questions that wait', async () => {
    const routes = standardRoutes();
    routes[URLS.a1] = {
      status: 200,
      body: productPage({ name: 'DT 770 PRO', gtin13: '4010118471063' }),
    };
    routes[URLS.a2] = {
      status: 200,
      body: productPage({ name: 'DT 770 PRO', gtin13: '4010118471070' }),
    };
    const { world } = await worldFor(gated('publish-asks', 'balanced'), routes);
    world.ports.decider = fakeDecider(() => ({ same: 0.5, variant: 0.45 })).decider;
    await refresh(world, 'publish-asks');
    const [question] = await publicationQuestions('publish-asks');
    expect(question!.context).toMatchObject({ incomplete: 0, openClassify: 0, openMatch: 1 });
  });
});

describe('a snapshot’s file that is gone', { timeout: 20_000 }, () => {
  it('fails the run that needs the last published one, with the snapshot named', async () => {
    const { world } = await worldFor(gated('publish-lost', 'auto'), standardRoutes());
    await refresh(world, 'publish-lost');
    const row = (await latestSnapshot(db, 'publish-lost'))!;
    world.stored.delete(row.key);

    // The next run's records changed, so the gates need the last snapshot's records to compare.
    world.web.routes.set(URLS.a1, { status: 200, body: renamedA1() });
    const failure: unknown = await refresh(world, 'publish-lost').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SnapshotFileMissingError);
    expect((failure as Error).message).toContain(row.id);
    expect((failure as Error).message).toContain(row.key);
  });

  it('refuses to publish a held snapshot whose records are gone', async () => {
    const { world } = await worldFor(gated('publish-draft', 'balanced'), standardRoutes());
    const snapshotId = heldId((await refresh(world, 'publish-draft')).summary);
    world.stored.delete(heldKey('publish-draft', snapshotId));
    await expect(
      publishHeldSnapshot(world.ports, { datasetId: 'publish-draft', snapshotId }),
    ).rejects.toBeInstanceOf(SnapshotFileMissingError);
    expect((await snapshotById(db, snapshotId))?.state).toBe('held');
  });
});
