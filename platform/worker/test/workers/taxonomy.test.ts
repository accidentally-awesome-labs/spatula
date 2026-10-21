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
