import { exportTaxonomy } from '@spatula/core';
import { applyDefinition } from '@spatula/store';
import { testDefinition, testTaxonomyDefinition, testTaxonomySeed } from '@spatula/store/fixtures';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { withDatabase } from '../../src/database';
import { call, expectNoStore } from './api-support';

const ready = (datasetId: string) =>
  withDatabase(env, (db) => applyDefinition(db, testTaxonomyDefinition(datasetId)));

describe('POST /datasets/:id/taxonomy', () => {
  it('seeds version 1 once, and gives it back as is or in the seed file’s shape', async () => {
    await ready('taxonomy-seed');
    const seeded = await call('POST', '/datasets/taxonomy-seed/taxonomy', {
      body: testTaxonomySeed(),
    });
    expect(seeded.status).toBe(201);
    expectNoStore(seeded);
    expect(await seeded.json()).toEqual({ version: 1, shelves: 8, functions: 4, features: 2 });

    const again = await call('POST', '/datasets/taxonomy-seed/taxonomy', {
      body: testTaxonomySeed(),
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error:
        'taxonomy-seed has a taxonomy already (version 1). Change it through proposals and the console.',
    });

    const got = (await (await call('GET', '/datasets/taxonomy-seed/taxonomy')).json()) as {
      version: number;
      taxonomy: Parameters<typeof exportTaxonomy>[0];
    };
    expect(got.version).toBe(1);
    expect(got.taxonomy.shelves.map((shelf) => shelf.slug)).toEqual([
      'headphones',
      'over-ear',
      'on-ear',
      'dacs',
      'amplifiers',
      'headphone-amps',
      'preamps',
      'power-amps',
    ]);
    const exported = await (
      await call('GET', '/datasets/taxonomy-seed/taxonomy?format=export')
    ).json();
    expect(exported).toEqual({ version: 1, export: exportTaxonomy(got.taxonomy) });
  });

  it('refuses a seed that isn’t one, a scope the definition doesn’t state, and what isn’t there', async () => {
    await ready('taxonomy-refused');
    const bad = await call('POST', '/datasets/taxonomy-refused/taxonomy', {
      body: {
        ...testTaxonomySeed(),
        shelves: [{ slug: 'x', name: 'X', description: 'X', implies: ['nothing'] }],
      },
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      error: 'The taxonomy has problems.',
      issues: [
        'shelves.0.implies: There’s no function called nothing.',
        'features.0.shelves: There’s no shelf called headphones.',
        'features.1.shelves: There’s no shelf called amplifiers.',
      ],
    });
    const scope = await call('POST', '/datasets/taxonomy-refused/taxonomy', {
      body: { ...testTaxonomySeed(), scope: 'Everything audio.' },
    });
    expect(scope.status).toBe(409);
    expect(await scope.json()).toEqual({
      error: 'The seed’s scope differs from the definition’s. Make them the same, then seed.',
    });
    expect(
      (await call('POST', '/datasets/taxonomy-nowhere/taxonomy', { body: testTaxonomySeed() }))
        .status,
    ).toBe(404);
    expect(await (await call('GET', '/datasets/taxonomy-refused/taxonomy')).json()).toEqual({
      error: 'taxonomy-refused has no taxonomy yet.',
    });
    expect((await call('GET', '/datasets/taxonomy-refused/taxonomy?format=yaml')).status).toBe(400);
    expect((await call('POST', '/datasets/taxonomy-refused/taxonomy', { body: '{' })).status).toBe(
      400,
    );
    expect(
      (await call('GET', '/datasets/taxonomy-refused/taxonomy', { token: 'not-the-owner' })).status,
    ).toBe(401);
  });

  it('seeds a dataset whose definition states no scope with the seed’s own', async () => {
    await withDatabase(env, (db) => applyDefinition(db, testDefinition('taxonomy-unscoped')));
    const seeded = await call('POST', '/datasets/taxonomy-unscoped/taxonomy', {
      body: testTaxonomySeed(),
    });
    expect(seeded.status).toBe(201);
  });
});

/** Bindings whose Workflow binding only records the runs it's asked to create. */
function recordingRuns(): { bindings: Env; created: { params: unknown }[] } {
  const created: { params: unknown }[] = [];
  const bindings = {
    ...env,
    REFRESH: {
      create: async (options: { params: unknown }) => {
        created.push(options);
      },
    },
  } as unknown as Env;
  return { bindings, created };
}

describe('POST /datasets/:id/runs?backfill=1', () => {
  it('starts a run that only backfills, for a dataset with a taxonomy', async () => {
    const { bindings, created } = recordingRuns();
    // Each in its own dataset: a second run of one in the same five-minute slot is refused.
    for (const [dataset, query] of [
      ['backfill-on', '?backfill=1'],
      ['backfill-off', '?backfill=0'],
    ] as const) {
      await ready(dataset);
      expect(
        (await call('POST', `/datasets/${dataset}/taxonomy`, { body: testTaxonomySeed() })).status,
      ).toBe(201);
      expect((await call('POST', `/datasets/${dataset}/runs${query}`, { bindings })).status).toBe(
        202,
      );
    }
    expect(created.map(({ params }) => params)).toMatchObject([
      { datasetId: 'backfill-on', all: false, backfill: true },
      { datasetId: 'backfill-off', all: false, backfill: false },
    ]);
  });

  it('refuses a backfill with no taxonomy to backfill, a flag that isn’t 1 or 0, and one with all', async () => {
    const { bindings, created } = recordingRuns();
    await ready('backfill-unseeded');
    const unseeded = await call('POST', '/datasets/backfill-unseeded/runs?backfill=1', {
      bindings,
    });
    expect(unseeded.status).toBe(409);
    expectNoStore(unseeded);
    expect(await unseeded.json()).toEqual({
      error: 'backfill-unseeded has no taxonomy to backfill.',
    });
    // A decided enum isn't a taxonomy, whether or not one was seeded for it.
    await withDatabase(env, (db) => applyDefinition(db, testDefinition('backfill-enum')));
    expect(
      (await call('POST', '/datasets/backfill-enum/runs?backfill=1', { bindings })).status,
    ).toBe(409);
    expect(
      (await call('POST', '/datasets/backfill-enum/taxonomy', { body: testTaxonomySeed() })).status,
    ).toBe(201);
    const seededEnum = await call('POST', '/datasets/backfill-enum/runs?backfill=1', { bindings });
    expect(seededEnum.status).toBe(409);
    expect(await seededEnum.json()).toEqual({
      error: 'backfill-enum has no taxonomy to backfill.',
    });
    const flag = await call('POST', '/datasets/backfill-unseeded/runs?backfill=yes', { bindings });
    expect(flag.status).toBe(400);
    expect(await flag.json()).toEqual({ error: 'backfill is 1 or 0.' });
    const both = await call('POST', '/datasets/backfill-unseeded/runs?all=1&backfill=1', {
      bindings,
    });
    expect(both.status).toBe(400);
    expect(await both.json()).toEqual({
      error: 'A backfill run reads no page, so it can’t count every page as due.',
    });
    expect(created).toEqual([]);
  });
});
