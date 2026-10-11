import { PAGE_METHODS, type StatementInput } from '@spatula/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { fetchOf, seedDataset, statementOf, T } from '../test/seed';
import type { Executor } from './client';
import type { ItemRef } from './datasets';
import { resolveEntities } from './entities';
import { testDefinition } from './fixtures';
import { items } from './schema';
import { writeStatements } from './statements';

const CANONICAL_ID = /^sp_[0-9a-hjkmnp-tv-z]{20}$/u;

/** What a page says now, as a fresh extraction. */
async function says(
  db: Executor,
  runId: string,
  item: ItemRef,
  minute: number,
  said: StatementInput[],
) {
  const fetchId = await fetchOf(db, runId, item, T(minute));
  await writeStatements(db, {
    datasetId: 'test-products',
    itemId: item.id,
    fetchId,
    seenAt: T(minute),
    methods: PAGE_METHODS,
    statements: said,
  });
}

const product = (brand: string, name: string, gtin: string) => [
  statementOf('brand', brand),
  statementOf('name', name, 'jsonld'),
  statementOf('gtins', gtin, 'jsonld'),
];

const entityOf = async (db: Executor, item: ItemRef) =>
  (await db.select({ entityId: items.entityId }).from(items).where(eq(items.id, item.id)))[0]!
    .entityId;

const resolve = (db: Executor) =>
  resolveEntities(db, { datasetId: 'test-products', definition: testDefinition() });

describe('resolveEntities', () => {
  it('gives each new record a canonical ID once, and keeps it', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2, b1],
        runId,
      } = await seedDataset(db);
      await says(db, runId, a1!, 0, product('Maker A', 'A1', '00036000291452'));
      await says(db, runId, a2!, 0, product('Maker A', 'A2', '04006381333931'));
      await says(db, runId, b1!, 0, [statementOf('brand', 'Maker B')]);

      expect(await resolve(db)).toEqual({
        created: 2,
        linked: 0,
        conflicts: 0,
        unresolved: 1,
        notes: [`${b1!.locator} has nothing to identify it by yet, so it has no entity`],
      });
      const first = [await entityOf(db, a1!), await entityOf(db, a2!)];
      expect(first[0]).toMatch(CANONICAL_ID);
      expect(first[1]).toMatch(CANONICAL_ID);
      expect(first[0]).not.toBe(first[1]);

      expect(await resolve(db)).toMatchObject({
        created: 0,
        linked: 0,
        conflicts: 0,
        unresolved: 1,
      });
      expect([await entityOf(db, a1!), await entityOf(db, a2!)]).toEqual(first);
    }));

  it('joins a page to the entity its strongest claim points to', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
        runId,
      } = await seedDataset(db);
      await says(db, runId, a1!, 0, product('Maker A', 'A1', '00036000291452'));
      // Another page names the product differently, but its GTIN is the same.
      await says(db, runId, a2!, 0, product('Maker A', 'A1 (2024 edition)', '00036000291452'));
      expect(await resolve(db)).toMatchObject({ created: 1, linked: 1, conflicts: 0 });
      expect(await entityOf(db, a2!)).toBe(await entityOf(db, a1!));
    }));

  it('reports a claim that points elsewhere, and merges nothing', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
        runId,
      } = await seedDataset(db);
      await says(db, runId, a1!, 0, product('Maker A', 'A1', '00036000291452'));
      await says(db, runId, a2!, 0, product('Maker A', 'A2', '04006381333931'));
      await resolve(db);
      const [e1, e2] = [await entityOf(db, a1!), await entityOf(db, a2!)];

      // a2 now also lists a1's GTIN.
      await says(db, runId, a2!, 5, [
        ...product('Maker A', 'A2', '04006381333931'),
        statementOf('gtins', '00036000291452', 'jsonld'),
      ]);
      expect(await resolve(db)).toEqual({
        created: 0,
        linked: 0,
        conflicts: 1,
        unresolved: 1,
        notes: [
          `${a2!.locator} claims gtins:00036000291452, which belongs to ${e1}, while the page belongs to ${e2}`,
          expect.stringContaining('has nothing to identify it by yet'),
        ],
      });
      expect([await entityOf(db, a1!), await entityOf(db, a2!)]).toEqual([e1, e2]);
    }));
});
