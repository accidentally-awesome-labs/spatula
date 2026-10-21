import {
  parseDefinition,
  runIdFor,
  sha256Hex,
  snapshotSchema,
  type Definition,
} from '@spatula/core';
import {
  applyDefinition,
  fetches,
  items,
  latestSnapshot,
  listLiveItems,
  seedTaxonomyVersion,
} from '@spatula/store';
import { testDefinition, testTaxonomy } from '@spatula/store/fixtures';
import { and, eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { runRefresh, type StepRunner } from '../../src/refresh';
import { standardRoutes, type Reply } from '../pages';
import { db } from './db';
import { fakeStep, makeWorld, type World } from './fakes';

/*
 * What the pipeline's tests share: one run of a dataset, the file it published, the fetch and the
 * entity a page came to, and a world made for a definition.
 */

/**
 * One run of the dataset, then five minutes, so the next run gets its own ID. Workflows keep each
 * step's result, so the run keeps them too, for tests that look at what a step returned. A run
 * counts every page as due unless it's told otherwise, so tests that run again five minutes later
 * still see every page read. A backfill run (`backfill`) only decides again what a taxonomy change
 * touched (ADR 0008).
 */
export async function refresh(
  world: World,
  datasetId: string,
  options: { all?: boolean; backfill?: boolean } = { all: true },
) {
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
  const summary = await runRefresh(
    { runId, datasetId, all: options.all, backfill: options.backfill },
    recording,
    world.ports,
  );
  world.clock.advance(5 * 60_000);
  return { summary, names, runId, results };
}

/** The latest snapshot's row and file, checking the file against its recorded hash. */
export async function published(world: World, datasetId: string) {
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

export const fetchOf = async (runId: string, url: string) =>
  (
    await db
      .select()
      .from(fetches)
      .where(and(eq(fetches.runId, runId), eq(fetches.url, url)))
  )[0]!;

export const entityOf = async (itemId: string) =>
  (await db.select({ entityId: items.entityId }).from(items).where(eq(items.id, itemId)))[0]!
    .entityId;

/** Applies a definition, and makes a world whose pages answer as `routes` say. */
export async function worldFor(
  definition: Definition,
  routes: Record<string, Reply>,
  options: { llm?: boolean; decider?: boolean; taxonomyDecider?: boolean } = {},
) {
  await applyDefinition(db, definition);
  const world = makeWorld(db, routes, options);
  return { world, pages: await listLiveItems(db, definition.dataset) };
}

/**
 * The test dataset, with its category left to the cascade where the source doesn't fix it: on
 * maker-a's pages. Maker-b still fixes B1's.
 */
export function decidedDefinition(
  datasetId: string,
  changes: Record<string, unknown> = {},
): Definition {
  const base = testDefinition(datasetId);
  const product = base.recordTypes.product!;
  const parsed = parseDefinition({
    ...base,
    recordTypes: {
      product: {
        ...product,
        fields: { ...product.fields, category: { ...product.fields.category!, decide: true } },
      },
    },
    sources: base.sources.map((source) =>
      source.id === 'maker-a' ? { ...source, fixed: { brand: 'Maker A' } } : source,
    ),
    ...changes,
  });
  if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
  return parsed.definition;
}

/**
 * Applies a definition whose record type has a taxonomy, seeds the test taxonomy as its version 1,
 * and makes a world whose pages answer as `routes` say.
 */
export async function taxonomyWorld(
  definition: Definition,
  routes: Record<string, Reply> = standardRoutes(),
  options: { llm?: boolean; decider?: boolean; taxonomyDecider?: boolean } = {},
) {
  const made = await worldFor(definition, routes, options);
  await seedTaxonomyVersion(db, {
    datasetId: definition.dataset,
    taxonomy: testTaxonomy(),
    actor: { role: 'owner', client: 'cli' },
    at: made.world.clock.now(),
  });
  return made;
}
