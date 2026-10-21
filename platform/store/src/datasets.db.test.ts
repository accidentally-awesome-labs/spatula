import {
  newId,
  parseDefinition,
  sourceCovers,
  type Definition,
  type PagesSource,
  type RunSummary,
  type Source,
} from '@spatula/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { noneOfThese } from '../test/seed';
import type { Executor } from './client';
import {
  applyDefinition,
  datasetExists,
  getDataset,
  listDatasets,
  listItems,
  listLiveItems,
  reviveItems,
  StaleDefinitionError,
} from './datasets';
import { findDecision, saveDecision } from './decisions';
import {
  testDefinition,
  testSitemapDefinition,
  testTaxonomy,
  testTaxonomyDefinition,
} from './fixtures';
import { dueItems } from './listing';
import { finishRun, getRun, startRun, startRunAlone } from './runs';
import { datasets, entities, items, runs, sources } from './schema';
import { currentTaxonomy, seedTaxonomyVersion } from './taxonomy';

const pagesOf = async (db: Executor) =>
  (await listLiveItems(db, 'test-products')).map((item) => item.locator);

describe('applyDefinition', () => {
  it('previews a new dataset without writing it, then creates it', () =>
    withRollback(async (db) => {
      const preview = await applyDefinition(db, testDefinition(), { dryRun: true });
      expect(preview).toEqual({
        dataset: 'test-products',
        revision: 1,
        created: true,
        changed: true,
        sources: { added: ['maker-a', 'maker-b'], removed: [], changed: [] },
        pages: { added: 3, removed: 0, moved: 0 },
        moves: [],
        unmoved: { uncovered: 0, ambiguous: 0, taken: 0 },
      });
      expect(await getDataset(db, 'test-products')).toBeNull();

      expect(await applyDefinition(db, testDefinition())).toEqual(preview);
      expect(await getDataset(db, 'test-products')).toMatchObject({
        revision: 1,
        headGeneration: 0,
      });
      expect(await pagesOf(db)).toEqual([
        'https://maker-a.example/products/a1',
        'https://maker-a.example/products/a2',
        'https://maker-b.example/products/b1',
      ]);
    }));

  it('changes nothing when the definition is the same', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition());
      expect(await applyDefinition(db, testDefinition())).toMatchObject({
        revision: 1,
        created: false,
        changed: false,
      });
    }));

  it('excludes pages and sources that leave the definition, and brings them back', () =>
    withRollback(async (db) => {
      const full = testDefinition();
      await applyDefinition(db, full);
      const smaller = {
        ...full,
        sources: [{ ...full.sources[0]!, pages: ['https://maker-a.example/products/a1'] }],
      };
      expect(await applyDefinition(db, smaller)).toMatchObject({
        revision: 2,
        sources: { added: [], removed: ['maker-b'], changed: ['maker-a'] },
        pages: { added: 0, removed: 2 },
      });
      expect(await pagesOf(db)).toEqual(['https://maker-a.example/products/a1']);
      const [makerB] = await db
        .select({ removedAt: sources.removedAt })
        .from(sources)
        .where(eq(sources.id, 'maker-b'));
      expect(makerB?.removedAt).toBeInstanceOf(Date);

      expect(await applyDefinition(db, full)).toMatchObject({
        revision: 3,
        sources: { added: ['maker-b'], removed: [] },
        pages: { added: 2, removed: 0 },
      });
      expect(await pagesOf(db)).toHaveLength(3);
    }));

  it('leaves a sitemap source’s pages to discovery', () =>
    withRollback(async (tx) => {
      const base = testDefinition('sitemap-apply');
      const parsed = parseDefinition({
        ...base,
        sources: [
          base.sources[0],
          {
            id: 'maker-c',
            kind: 'sitemap',
            recordType: 'product',
            sitemaps: ['https://maker-c.example/sitemap.xml'],
            include: ['/products/*'],
            fixed: { brand: 'Maker C', category: 'Headphones' },
            evidence: base.sources[0]!.evidence,
          },
        ],
      });
      if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
      const summary = await applyDefinition(tx, parsed.definition);
      expect(summary.pages).toEqual({ added: 2, removed: 0, moved: 0 });
      expect(summary.sources.added).toEqual(['maker-a', 'maker-c']);
      const live = await listLiveItems(tx, 'sitemap-apply');
      expect(live.map((item) => item.sourceId)).toEqual(['maker-a', 'maker-a']);
    }));

  it('keeps a sitemap source’s discovered pages through every re-apply', () =>
    withRollback(async (tx) => {
      const base = testDefinition('sitemap-reapply');
      const sitemap = {
        id: 'maker-c',
        kind: 'sitemap',
        recordType: 'product',
        sitemaps: ['https://maker-c.example/sitemap.xml'],
        include: ['/products/*'],
        fixed: { brand: 'Maker C', category: 'Headphones' },
        evidence: base.sources[0]!.evidence,
      };
      const read = (source: Record<string, unknown>) => {
        const parsed = parseDefinition({ ...base, sources: [base.sources[0], source] });
        if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
        return parsed.definition;
      };
      const definition = read(sitemap);
      await applyDefinition(tx, definition);
      // What discovery leaves behind: pages the sitemap listed, which the definition never names.
      await tx.insert(items).values(
        ['c1', 'c2'].map((page) => ({
          id: newId('it'),
          datasetId: 'sitemap-reapply',
          sourceId: 'maker-c',
          recordType: 'product',
          locator: `https://maker-c.example/products/${page}`,
        })),
      );

      // Applying the same definition again reports them neither added nor removed.
      expect(await applyDefinition(tx, definition)).toMatchObject({
        changed: false,
        pages: { added: 0, removed: 0 },
      });
      // A changed definition writes to the database, and must not exclude them either.
      expect(await applyDefinition(tx, read({ ...sitemap, maxPages: 500 }))).toMatchObject({
        changed: true,
        sources: { changed: ['maker-c'] },
        pages: { added: 0, removed: 0 },
      });
      expect((await listLiveItems(tx, 'sitemap-reapply')).map((item) => item.locator)).toEqual([
        'https://maker-a.example/products/a1',
        'https://maker-a.example/products/a2',
        'https://maker-c.example/products/c1',
        'https://maker-c.example/products/c2',
      ]);
    }));

  it('gives a definition stored before slice 1 the new keys’ defaults', () =>
    withRollback(async (tx) => {
      const old: Record<string, unknown> = { ...testDefinition('stored-old') };
      for (const key of ['freshness', 'gates', 'publication', 'decisions', 'budget', 'consumers']) {
        delete old[key];
      }
      await tx.insert(datasets).values({
        id: 'stored-old',
        revision: 1,
        definition: old as unknown as Definition,
        definitionHash: 'old',
      });
      const dataset = await getDataset(tx, 'stored-old');
      expect(dataset?.definition.freshness).toEqual({ maxAgeDays: 7 });
      expect(dataset?.definition.consumers).toEqual([]);
    }));

  it('refuses a stored definition that no longer passes the checks', () =>
    withRollback(async (tx) => {
      // A later version's stricter checks would leave a row like this one.
      await tx.insert(datasets).values({
        id: 'stored-stale',
        revision: 1,
        definition: { ...testDefinition('stored-stale'), consumers: ['Not A Slug'] },
        definitionHash: 'stale',
      });
      const stale = () => getDataset(tx, 'stored-stale');
      await expect(stale()).rejects.toBeInstanceOf(StaleDefinitionError);
      await expect(stale()).rejects.toMatchObject({ name: 'StaleDefinitionError' });
      await expect(stale()).rejects.toThrow(/no longer passes the checks/u);
    }));

  it('knows a dataset by its row, however its stored definition now reads', () =>
    withRollback(async (tx) => {
      expect(await datasetExists(tx, 'exists-new')).toBe(false);
      await applyDefinition(tx, testDefinition('exists-new'));
      expect(await datasetExists(tx, 'exists-new')).toBe(true);
      // A definition that no longer passes the checks is still a dataset: its pages can be revived
      // before it is applied again.
      await tx.insert(datasets).values({
        id: 'exists-stale',
        revision: 1,
        definition: { ...testDefinition('exists-stale'), consumers: ['Not A Slug'] },
        definitionHash: 'stale',
      });
      expect(await datasetExists(tx, 'exists-stale')).toBe(true);
    }));

  it('revives only the dataset it is told', () =>
    withRollback(async (tx) => {
      // Two datasets list the same three pages, and every page of both is refused.
      await applyDefinition(tx, testDefinition('revive-one'));
      await applyDefinition(tx, testDefinition('revive-two'));
      const both = ['revive-one', 'revive-two'];
      await tx.update(items).set({ status: 'refused' }).where(inArray(items.datasetId, both));
      const statusesOf = async (datasetId: string) =>
        (
          await tx
            .select({ status: items.status })
            .from(items)
            .where(eq(items.datasetId, datasetId))
        )
          .map((row) => row.status)
          .sort();

      expect(await reviveItems(tx, { datasetId: 'revive-one', refused: true })).toBe(3);
      expect(await statusesOf('revive-one')).toEqual(['live', 'live', 'live']);
      expect(await statusesOf('revive-two')).toEqual(['refused', 'refused', 'refused']);

      // Naming the pages finds them in the one dataset only, though the other has them refused.
      const named = (await tx.select({ locator: items.locator }).from(items)).map(
        (row) => row.locator,
      );
      expect(await reviveItems(tx, { datasetId: 'revive-one', pages: named })).toBe(0);
      expect(await statusesOf('revive-two')).toEqual(['refused', 'refused', 'refused']);
      expect(await reviveItems(tx, { datasetId: 'revive-two', pages: named })).toBe(3);
    }));

  it('revives refused pages, and the pages named, with fresh streaks', () =>
    withRollback(async (tx) => {
      await applyDefinition(tx, testDefinition('revive'));
      const [a1, a2, b1] = await listLiveItems(tx, 'revive');
      await tx
        .update(items)
        .set({
          status: 'refused',
          lastOutcome: 'blocked',
          outcomeStreak: 3,
          lastFetchedAt: new Date(),
          extractedWith: 'r1.v1',
        })
        .where(eq(items.id, a1!.id));
      await tx
        .update(items)
        .set({
          status: 'gone',
          lastOutcome: 'gone',
          outcomeStreak: 2,
          lastFetchedAt: new Date(),
          extractedWith: 'r1.v1',
        })
        .where(eq(items.id, a2!.id));
      await tx.update(items).set({ status: 'excluded' }).where(eq(items.id, b1!.id));

      expect(await reviveItems(tx, { datasetId: 'revive', refused: true })).toBe(1);
      // A page that left the definition stays out: listing it again is what brings it back.
      expect(
        await reviveItems(tx, { datasetId: 'revive', pages: [a2!.locator, b1!.locator] }),
      ).toBe(1);
      const rows = await tx
        .select({ locator: items.locator, status: items.status, streak: items.outcomeStreak })
        .from(items)
        .where(eq(items.datasetId, 'revive'));
      expect(rows.map((row) => [row.status, row.streak]).sort()).toEqual([
        ['excluded', 0],
        ['live', 0],
        ['live', 0],
      ]);
      // Revived pages are read at the next run, whenever they were last read.
      const plan = await dueItems(tx, {
        datasetId: 'revive',
        now: new Date(),
        maxAgeDays: 7,
        current: 'r1.v1',
        limit: 10,
      });
      expect([...plan.ids].sort()).toEqual([a1!.id, a2!.id].sort());
    }));

  it('revives an irrelevant page so it is asked again', () =>
    withRollback(async (tx) => {
      await applyDefinition(tx, testDefinition('revive-irrelevant'));
      const [a1] = await listLiveItems(tx, 'revive-irrelevant');
      await tx
        .update(items)
        .set({ status: 'irrelevant', extractedWith: 'r1.v1' })
        .where(eq(items.id, a1!.id));
      await saveDecision(tx, noneOfThese('revive-irrelevant', a1!.id));
      expect(await reviveItems(tx, { datasetId: 'revive-irrelevant', pages: [a1!.locator] })).toBe(
        1,
      );
      expect(
        await findDecision(tx, {
          datasetId: 'revive-irrelevant',
          subjectKey: `classify:${a1!.id}`,
          stateHash: 'hash',
          criteriaVersion: 1,
        }),
      ).toBeNull();
      const [row] = await tx
        .select({ status: items.status, extractedWith: items.extractedWith })
        .from(items)
        .where(eq(items.id, a1!.id));
      expect(row).toEqual({ status: 'live', extractedWith: null });
    }));

  it('revives nothing when one of its writes fails', () =>
    withRollback(async (tx) => {
      await applyDefinition(tx, testDefinition('revive-atomic'));
      const [a1] = await listLiveItems(tx, 'revive-atomic');
      await tx
        .update(items)
        .set({ status: 'irrelevant', extractedWith: 'r1.v1' })
        .where(eq(items.id, a1!.id));
      const none = await saveDecision(tx, noneOfThese('revive-atomic', a1!.id));
      // The last of its writes fails, as if the database went away between them.
      await tx.execute(
        sql`create function refuse_clearing() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$`,
      );
      await tx.execute(
        sql`create trigger refuse_clearing before update of extracted_with on items for each row when (new.extracted_with is null) execute function refuse_clearing()`,
      );
      await expect(
        reviveItems(tx, { datasetId: 'revive-atomic', pages: [a1!.locator] }),
      ).rejects.toThrow();
      // The page is as it was: still irrelevant, still read, and its answer still current.
      const [row] = await tx
        .select({ status: items.status, extractedWith: items.extractedWith })
        .from(items)
        .where(eq(items.id, a1!.id));
      expect(row).toEqual({ status: 'irrelevant', extractedWith: 'r1.v1' });
      expect(
        await findDecision(tx, {
          datasetId: 'revive-atomic',
          subjectKey: none.subjectKey,
          stateHash: none.stateHash,
          criteriaVersion: none.criteriaVersion,
        }),
      ).toMatchObject({ id: none.id });
    }));

  it('retires the answer and the mark of the irrelevant pages it revives, and of no others', () =>
    withRollback(async (tx) => {
      await applyDefinition(tx, testDefinition('revive-mixed'));
      const [a1, a2] = await listLiveItems(tx, 'revive-mixed');
      await tx
        .update(items)
        .set({ status: 'irrelevant', extractedWith: 'r1.v1' })
        .where(eq(items.id, a1!.id));
      await tx
        .update(items)
        .set({ status: 'refused', extractedWith: 'r1.v1' })
        .where(eq(items.id, a2!.id));
      const irrelevant = noneOfThese('revive-mixed', a1!.id);
      const refused = {
        ...noneOfThese('revive-mixed', a2!.id),
        probabilities: { Headphones: 0.95 },
        answer: 'Headphones',
      };
      await saveDecision(tx, irrelevant);
      await saveDecision(tx, refused);
      const current = (decision: typeof irrelevant) =>
        findDecision(tx, {
          datasetId: 'revive-mixed',
          subjectKey: decision.subjectKey,
          stateHash: decision.stateHash,
          criteriaVersion: decision.criteriaVersion,
        });

      expect(
        await reviveItems(tx, { datasetId: 'revive-mixed', pages: [a1!.locator, a2!.locator] }),
      ).toBe(2);
      // Only the page that was irrelevant is asked again. The refused page was never answered "none
      // of these", so what it was read with and asked stands.
      expect(await current(irrelevant)).toBeNull();
      expect(await current(refused)).toMatchObject({ id: refused.id });
      const stateOf = async (id: string) =>
        (
          await tx
            .select({ status: items.status, extractedWith: items.extractedWith })
            .from(items)
            .where(eq(items.id, id))
        )[0];
      expect(await stateOf(a1!.id)).toEqual({ status: 'live', extractedWith: null });
      expect(await stateOf(a2!.id)).toEqual({ status: 'live', extractedWith: 'r1.v1' });
    }));

  it('lists every item, whatever its status, with the entity it joined', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('list-items'));
      // Another dataset's items, which the list leaves out.
      await applyDefinition(db, testDefinition('list-items-other'));
      const a1 = 'https://maker-a.example/products/a1';
      const a2 = 'https://maker-a.example/products/a2';
      const itemAt = (locator: string) =>
        and(eq(items.datasetId, 'list-items'), eq(items.locator, locator));
      await db.update(items).set({ status: 'gone' }).where(itemAt(a1));
      await db
        .insert(entities)
        .values({ id: 'sp_listed', datasetId: 'list-items', recordType: 'product' });
      await db.update(items).set({ entityId: 'sp_listed' }).where(itemAt(a2));
      expect(await listItems(db, 'list-items')).toEqual([
        { locator: a1, sourceId: 'maker-a', status: 'gone', entityId: null },
        { locator: a2, sourceId: 'maker-a', status: 'live', entityId: 'sp_listed' },
        {
          locator: 'https://maker-b.example/products/b1',
          sourceId: 'maker-b',
          status: 'live',
          entityId: null,
        },
      ]);
      expect(await listItems(db, 'nothing')).toEqual([]);
    }));
});

/** A sitemap source on maker-a's host, cut from the fixture's maker-c, keeping these paths. */
function sitemapOnMakerA(id: string, include: string[]): Source {
  const makerC = testSitemapDefinition().sources.find((source) => source.id === 'maker-c')!;
  if (makerC.kind !== 'sitemap') throw new Error('maker-c is a sitemap source');
  return {
    ...makerC,
    id,
    sitemaps: ['https://maker-a.example/sitemap.xml'],
    include,
    exclude: [],
    fixed: { brand: 'Maker A', category: 'Headphones' },
  };
}

/** The pages source of a fixture definition with this ID. */
function pagesSource(definition: Definition, id: string): PagesSource {
  const source = definition.sources.find((candidate) => candidate.id === id);
  if (source?.kind !== 'pages') throw new Error(`${id} is a pages source`);
  return source;
}

/** Each page's source and status, by address, then source. */
const placeOf = async (db: Executor, datasetId: string) =>
  db
    .select({
      id: items.id,
      sourceId: items.sourceId,
      locator: items.locator,
      status: items.status,
    })
    .from(items)
    .where(eq(items.datasetId, datasetId))
    .orderBy(items.locator, items.sourceId);

describe('applyDefinition, when a source is replaced', () => {
  it('moves the pages of a removed source to the source that covers them, with their history', () =>
    withRollback(async (db) => {
      const before = testDefinition('moves');
      await applyDefinition(db, before);
      const [a1] = await placeOf(db, 'moves');
      // A read's marks stay with the page when it moves. Its listing marks belonged to the old
      // source, so they reset, for the new source's first complete read to set again.
      await db
        .update(items)
        .set({
          contentHash: 'h-a1',
          lastOutcome: 'changed',
          lastFetchedAt: new Date(),
          listedAt: new Date('2026-10-01T00:00:00Z'),
          listedLastmod: '2026-09-30T00:00:00.000Z',
          missingStreak: 2,
        })
        .where(eq(items.id, a1!.id));
      const after: Definition = {
        ...before,
        sources: [
          before.sources.find((source) => source.id === 'maker-b')!,
          sitemapOnMakerA('maker-a-all', ['/products/*']),
        ],
      };

      const preview = await applyDefinition(db, after, { dryRun: true });
      expect(preview).toMatchObject({
        revision: 2,
        changed: true,
        sources: { added: ['maker-a-all'], removed: ['maker-a'], changed: [] },
        pages: { added: 0, removed: 0, moved: 2 },
        moves: [{ from: ['maker-a'], to: 'maker-a-all', pages: 2 }],
        unmoved: { uncovered: 0, ambiguous: 0, taken: 0 },
      });
      // A dry run moves nothing.
      expect((await placeOf(db, 'moves')).map((page) => page.sourceId)).toEqual([
        'maker-a',
        'maker-a',
        'maker-b',
      ]);

      expect(await applyDefinition(db, after)).toEqual(preview);
      const moved = await db.select().from(items).where(eq(items.id, a1!.id));
      expect(moved[0]).toMatchObject({
        sourceId: 'maker-a-all',
        status: 'live',
        contentHash: 'h-a1',
        lastOutcome: 'changed',
        listedAt: null,
        listedLastmod: null,
        missingStreak: 0,
      });
      expect((await placeOf(db, 'moves')).map((page) => [page.sourceId, page.status])).toEqual([
        ['maker-a-all', 'live'],
        ['maker-a-all', 'live'],
        ['maker-b', 'live'],
      ]);
    }));

  it('keeps the status of a page that isn’t live when it moves, and the answer behind it', () =>
    withRollback(async (db) => {
      const base = testDefinition('keeps-status');
      const makerA = pagesSource(base, 'maker-a');
      const before: Definition = {
        ...base,
        sources: [
          { ...makerA, pages: [...makerA.pages, 'https://maker-a.example/products/a3'] },
          pagesSource(base, 'maker-b'),
        ],
      };
      await applyDefinition(db, before);
      const [a1, a2, a3] = await placeOf(db, 'keeps-status');
      await db
        .update(items)
        .set({ status: 'gone', lastOutcome: 'gone', outcomeStreak: 2 })
        .where(eq(items.id, a1!.id));
      // The owner's "None of these": the page is irrelevant, and not read or asked about again.
      await db
        .update(items)
        .set({ status: 'irrelevant', extractedWith: 'r1.v1' })
        .where(eq(items.id, a2!.id));
      const none = await saveDecision(db, noneOfThese('keeps-status', a2!.id));
      await db
        .update(items)
        .set({ status: 'refused', lastOutcome: 'blocked', outcomeStreak: 3 })
        .where(eq(items.id, a3!.id));
      const after: Definition = {
        ...before,
        sources: [pagesSource(base, 'maker-b'), sitemapOnMakerA('maker-a-all', ['/products/*'])],
      };

      expect(await applyDefinition(db, after)).toMatchObject({
        pages: { moved: 3 },
        moves: [{ from: ['maker-a'], to: 'maker-a-all', pages: 3 }],
        unmoved: { uncovered: 0, ambiguous: 0, taken: 0 },
      });
      const rows = await db
        .select({
          sourceId: items.sourceId,
          status: items.status,
          lastOutcome: items.lastOutcome,
          outcomeStreak: items.outcomeStreak,
          extractedWith: items.extractedWith,
        })
        .from(items)
        .where(inArray(items.id, [a1!.id, a2!.id, a3!.id]))
        .orderBy(items.locator);
      expect(rows).toEqual([
        {
          sourceId: 'maker-a-all',
          status: 'gone',
          lastOutcome: 'gone',
          outcomeStreak: 2,
          extractedWith: null,
        },
        {
          sourceId: 'maker-a-all',
          status: 'irrelevant',
          lastOutcome: null,
          outcomeStreak: 0,
          extractedWith: 'r1.v1',
        },
        {
          sourceId: 'maker-a-all',
          status: 'refused',
          lastOutcome: 'blocked',
          outcomeStreak: 3,
          extractedWith: null,
        },
      ]);
      // The answer that made the page irrelevant stands.
      expect(
        await findDecision(db, {
          datasetId: 'keeps-status',
          subjectKey: none.subjectKey,
          stateHash: none.stateHash,
          criteriaVersion: none.criteriaVersion,
        }),
      ).toMatchObject({ id: none.id });
    }));

  it('leaves a page excluded when no source, or two sources, cover it, and counts why', () =>
    withRollback(async (db) => {
      const before = testDefinition('unmoved');
      await applyDefinition(db, before);
      const after: Definition = {
        ...before,
        // maker-a's a1 has one home, its a2 two, and maker-b's b1 none.
        sources: [
          sitemapOnMakerA('wide', ['/products/*']),
          sitemapOnMakerA('narrow', ['/products/a2']),
        ],
      };
      expect(await applyDefinition(db, after)).toMatchObject({
        sources: { removed: ['maker-a', 'maker-b'] },
        pages: { moved: 1, removed: 2 },
        moves: [{ from: ['maker-a'], to: 'wide', pages: 1 }],
        unmoved: { uncovered: 1, ambiguous: 1, taken: 0 },
      });
      expect(
        (await placeOf(db, 'unmoved')).map((page) => [page.locator, page.sourceId, page.status]),
      ).toEqual([
        ['https://maker-a.example/products/a1', 'wide', 'live'],
        ['https://maker-a.example/products/a2', 'maker-a', 'excluded'],
        ['https://maker-b.example/products/b1', 'maker-b', 'excluded'],
      ]);
    }));

  it('says nothing more of the pages it left excluded, when it is applied again', () =>
    withRollback(async (db) => {
      const before = testDefinition('left-excluded');
      await applyDefinition(db, before);
      const after: Definition = {
        ...before,
        // maker-a's a2 has two homes, and maker-b's b1 none.
        sources: [
          sitemapOnMakerA('wide', ['/products/*']),
          sitemapOnMakerA('narrow', ['/products/a2']),
        ],
      };
      await applyDefinition(db, after);

      // Both sources left are removed already, so their pages are no news: nothing moves, and none
      // is counted again.
      expect(await applyDefinition(db, after)).toEqual({
        dataset: 'left-excluded',
        revision: 2,
        created: false,
        changed: false,
        sources: { added: [], removed: [], changed: [] },
        pages: { added: 0, removed: 0, moved: 0 },
        moves: [],
        unmoved: { uncovered: 0, ambiguous: 0, taken: 0 },
      });
      expect(
        (await placeOf(db, 'left-excluded')).map((page) => [page.sourceId, page.status]),
      ).toEqual([
        ['wide', 'live'],
        ['maker-a', 'excluded'],
        ['maker-b', 'excluded'],
      ]);
    }));

  it('moves one page of two that claim the same address, and leaves the other excluded', () =>
    withRollback(async (db) => {
      const base = testDefinition('claims');
      const makerA = base.sources.find((source) => source.id === 'maker-a')!;
      // Two pages sources list a1; the unique index allows one page per source and address.
      const before: Definition = {
        ...base,
        sources: [...base.sources, { ...makerA, id: 'maker-a-copy' }],
      };
      await applyDefinition(db, before);
      const after: Definition = {
        ...base,
        sources: [
          base.sources.find((source) => source.id === 'maker-b')!,
          sitemapOnMakerA('maker-a-all', ['/products/*']),
        ],
      };
      expect(await applyDefinition(db, after)).toMatchObject({
        pages: { moved: 2, removed: 2 },
        moves: [{ from: ['maker-a'], to: 'maker-a-all', pages: 2 }],
        unmoved: { uncovered: 0, ambiguous: 0, taken: 2 },
      });
      const rows = await placeOf(db, 'claims');
      expect(rows.filter((row) => row.sourceId === 'maker-a-all')).toHaveLength(2);
      expect(
        rows.filter((row) => row.sourceId === 'maker-a-copy').map((row) => row.status),
      ).toEqual(['excluded', 'excluded']);
    }));

  it('takes back the excluded pages of a source removed before, without moving the revision', () =>
    withRollback(async (db) => {
      const base = testDefinition('take-back');
      const now: Definition = {
        ...base,
        sources: [
          base.sources.find((source) => source.id === 'maker-b')!,
          sitemapOnMakerA('maker-a-all', ['/products/*']),
        ],
      };
      await applyDefinition(db, now);
      // What an apply before ADR 0006 left: maker-a removed, and its pages excluded.
      await db.insert(sources).values({
        datasetId: 'take-back',
        id: 'maker-a',
        kind: 'pages',
        config: base.sources.find((source) => source.id === 'maker-a')!,
        removedAt: new Date(),
      });
      await db.insert(items).values(
        ['a1', 'a2'].map((name) => ({
          id: newId('it'),
          datasetId: 'take-back',
          sourceId: 'maker-a',
          recordType: 'product',
          locator: `https://maker-a.example/products/${name}`,
          status: 'excluded' as const,
        })),
      );

      expect(await applyDefinition(db, now)).toMatchObject({
        revision: 1,
        changed: false,
        pages: { added: 0, removed: 0, moved: 2 },
        moves: [{ from: ['maker-a'], to: 'maker-a-all', pages: 2 }],
        unmoved: { uncovered: 0, ambiguous: 0, taken: 0 },
      });
      expect((await placeOf(db, 'take-back')).map((page) => [page.sourceId, page.status])).toEqual([
        ['maker-a-all', 'live'],
        ['maker-a-all', 'live'],
        ['maker-b', 'live'],
      ]);
      // A second apply finds nothing more to move, and says nothing of it.
      expect(await applyDefinition(db, now)).toMatchObject({
        changed: false,
        pages: { moved: 0 },
        moves: [],
      });
    }));

  it('keeps a page a pages source lists as the moved one, not a new one', () =>
    withRollback(async (db) => {
      const before = testDefinition('into-pages');
      await applyDefinition(db, before);
      const [a1] = await placeOf(db, 'into-pages');
      const makerA = before.sources.find((source) => source.id === 'maker-a')!;
      const after: Definition = {
        ...before,
        sources: [
          before.sources.find((source) => source.id === 'maker-b')!,
          { ...makerA, id: 'maker-a-renamed' },
        ],
      };
      expect(await applyDefinition(db, after)).toMatchObject({
        pages: { added: 0, removed: 0, moved: 2 },
        moves: [{ from: ['maker-a'], to: 'maker-a-renamed', pages: 2 }],
      });
      const rows = await placeOf(db, 'into-pages');
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === a1!.id)).toMatchObject({
        sourceId: 'maker-a-renamed',
        status: 'live',
      });
      expect(sourceCovers(after.sources[1]!, a1!.locator)).toBe(true);
    }));

  it('leaves a page excluded when a pages source lists its address under another spelling', () =>
    withRollback(async (db) => {
      const base = testDefinition('spelled');
      const makerA = pagesSource(base, 'maker-a');
      const makerB = pagesSource(base, 'maker-b');
      const lower = 'https://maker-a.example/products/%c3%a9';
      const upper = 'https://maker-a.example/products/%C3%A9';
      await applyDefinition(db, { ...base, sources: [{ ...makerA, pages: [lower] }, makerB] });
      const after: Definition = {
        ...base,
        sources: [{ ...makerA, id: 'maker-a-renamed', pages: [upper] }, makerB],
      };

      // The store keys a page by its text. Moving this one would put a second row for the address
      // in the source, beside the one the same apply adds for what the source lists.
      expect(await applyDefinition(db, after)).toMatchObject({
        pages: { added: 1, removed: 1, moved: 0 },
        moves: [],
        unmoved: { uncovered: 0, ambiguous: 0, taken: 1 },
      });
      const rows = await placeOf(db, 'spelled');
      expect(
        rows
          .filter((row) => row.sourceId === 'maker-a-renamed')
          .map((row) => [row.locator, row.status]),
      ).toEqual([[upper, 'live']]);
      expect(
        rows.filter((row) => row.sourceId === 'maker-a').map((row) => [row.locator, row.status]),
      ).toEqual([[lower, 'excluded']]);
    }));

  it('doesn’t take an excluded page back into a pages source that lists it spelled another way', () =>
    withRollback(async (db) => {
      const base = testDefinition('spelled-back');
      const makerA = pagesSource(base, 'maker-a');
      const lower = 'https://maker-a.example/products/%c3%a9';
      const upper = 'https://maker-a.example/products/%C3%A9';
      const now: Definition = {
        ...base,
        sources: [
          { ...makerA, id: 'maker-a-renamed', pages: [upper] },
          pagesSource(base, 'maker-b'),
        ],
      };
      await applyDefinition(db, now);
      // What an apply before ADR 0006 left: maker-a removed, and its page excluded.
      await db.insert(sources).values({
        datasetId: 'spelled-back',
        id: 'maker-a',
        kind: 'pages',
        config: makerA,
        removedAt: new Date(),
      });
      await db.insert(items).values({
        id: newId('it'),
        datasetId: 'spelled-back',
        sourceId: 'maker-a',
        recordType: 'product',
        locator: lower,
        status: 'excluded',
      });

      expect(await applyDefinition(db, now)).toMatchObject({
        changed: false,
        pages: { added: 0, removed: 0, moved: 0 },
        moves: [],
        unmoved: { uncovered: 0, ambiguous: 0, taken: 0 },
      });
      // The address is one live page, under the spelling its source lists.
      const rows = await placeOf(db, 'spelled-back');
      expect(rows.filter((row) => row.sourceId === 'maker-a-renamed')).toHaveLength(1);
      expect(rows.filter((row) => row.status === 'live')).toHaveLength(2);
      expect(rows.filter((row) => row.sourceId === 'maker-a').map((row) => row.status)).toEqual([
        'excluded',
      ]);
    }));
});

/** What a run that did nothing reports. */
const SUMMARY: RunSummary = {
  items: 0,
  fetches: { changed: 0, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
  statements: { added: 0, reseen: 0, withdrawn: 0 },
  llm: { ran: 0, reused: 0, skipped: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
  entities: { created: 0, linked: 0, conflicts: 0, unresolved: 0 },
  snapshot: { published: false, reason: 'nothing changed', excluded: [] },
  notes: [],
};

describe('runs', () => {
  it('starts a run once per ID, and records how it finished', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition());
      const id = 'test-products-202610100000';
      const first = await startRun(db, { id, datasetId: 'test-products' });
      expect(first).toMatchObject({
        created: true,
        run: { id, status: 'running', finishedAt: null },
      });
      expect((await startRun(db, { id, datasetId: 'test-products' })).created).toBe(false);

      await finishRun(db, id, { status: 'failed', error: 'robots.txt is unreachable' });
      expect(await getRun(db, id)).toMatchObject({
        status: 'failed',
        error: 'robots.txt is unreachable',
      });
      expect(await getRun(db, 'no-such-run')).toBeNull();
    }));

  it('leaves a complete run complete, and lets a failed run complete', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition());
      const done = 'test-products-202610100000';
      const lost = 'test-products-202610100500';
      await startRun(db, { id: done, datasetId: 'test-products' });
      await startRun(db, { id: lost, datasetId: 'test-products' });

      // Complete, then failed: it stays complete, with its summary. A failure recorded late, such
      // as a start of the next run recording this one as lost, doesn't undo a completion.
      await finishRun(db, done, { status: 'complete', summary: SUMMARY });
      const complete = await getRun(db, done);
      expect(complete).toMatchObject({ status: 'complete', summary: SUMMARY, error: null });
      await finishRun(db, done, { status: 'failed', error: 'The Workflow was lost.' });
      expect(await getRun(db, done)).toEqual(complete);

      // Failed, then complete: it completes, with its summary and without the failure's error.
      // A Workflow replayed or restarted from its finished steps ends a run that had failed, and
      // the row says how the run ended last.
      await finishRun(db, lost, { status: 'failed', error: 'robots.txt is unreachable' });
      expect(await getRun(db, lost)).toMatchObject({
        status: 'failed',
        error: 'robots.txt is unreachable',
        summary: null,
      });
      await finishRun(db, lost, { status: 'complete', summary: SUMMARY });
      expect(await getRun(db, lost)).toMatchObject({
        status: 'complete',
        summary: SUMMARY,
        error: null,
        finishedAt: expect.any(String),
      });
    }));
});

describe('startRunAlone', () => {
  const datasetId = 'test-products';
  const HOUR = 60 * 60 * 1000;

  /**
   * A run that is going and began `ago` ms before `at`, started as the Workflow's own start does,
   * which doesn't ask whether another is going.
   */
  async function runningSince(
    db: Executor,
    id: string,
    at: Date,
    ago: number,
    dataset = datasetId,
  ) {
    await startRun(db, { id, datasetId: dataset });
    await db
      .update(runs)
      .set({ startedAt: new Date(at.getTime() - ago) })
      .where(eq(runs.id, id));
  }

  it('starts a run when none of the dataset’s is going', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition());
      const id = 'test-products-202610100000';
      expect(await startRunAlone(db, { id, datasetId })).toMatchObject({
        created: true,
        run: { id, datasetId, status: 'running', finishedAt: null },
      });
    }));

  it('turns a start away while another run of the dataset is going, names that run, and records nothing', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition());
      const at = new Date();
      await runningSince(db, 'test-products-202610100000', at, HOUR);
      const refused = await startRunAlone(db, { id: 'test-products-202610100500', datasetId });
      expect(refused).toEqual({
        running: {
          id: 'test-products-202610100000',
          datasetId,
          status: 'running',
          startedAt: new Date(at.getTime() - HOUR).toISOString(),
          finishedAt: null,
          summary: null,
          error: null,
        },
      });
      expect(await getRun(db, 'test-products-202610100500')).toBeNull();
    }));

  it('names the newest run that is going, when more than one is', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition());
      const at = new Date();
      // Runs can overlap in a database that held runs from before the rule. The older goes in
      // first, so a start that took the first it found would name it.
      await runningSince(db, 'test-products-older', at, 3 * HOUR);
      await runningSince(db, 'test-products-newer', at, HOUR);
      expect(
        await startRunAlone(db, { id: 'test-products-202610100500', datasetId }),
      ).toMatchObject({ running: { id: 'test-products-newer' } });
    }));

  it('finds the run that is already there when the ID is the same, as a second start in a slot does', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition());
      const at = new Date();
      const id = 'test-products-202610100000';
      await runningSince(db, id, at, 60_000);
      // The run in the way is this one itself, so the start is a repeat, not a refusal.
      expect(await startRunAlone(db, { id, datasetId })).toMatchObject({
        created: false,
        run: { id, status: 'running' },
      });
    }));

  it.each([
    ['complete', { status: 'complete', summary: SUMMARY }],
    ['failed', { status: 'failed', error: 'robots.txt is unreachable' }],
  ] as const)('starts a run once the one before it is %s', (_name, result) =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition());
      const at = new Date();
      await runningSince(db, 'test-products-202610100000', at, HOUR);
      await finishRun(db, 'test-products-202610100000', result);
      expect(
        await startRunAlone(db, { id: 'test-products-202610100500', datasetId }),
      ).toMatchObject({ created: true, run: { id: 'test-products-202610100500' } });
    }),
  );

  it('turns a start away while another run is running, however long ago it started', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition());
      const at = new Date();
      // Six hours and a minute, and a week. Whether such a run is still going is for its Workflow
      // to say, and the API asks it before it records the run failed (api.ts's viewRun).
      for (const [id, ago] of [
        ['test-products-late', 6 * HOUR + 60_000],
        ['test-products-week', 7 * 24 * HOUR],
      ] as const) {
        await db.delete(runs).where(eq(runs.datasetId, datasetId));
        await runningSince(db, id, at, ago);
        expect(
          await startRunAlone(db, { id: 'test-products-202610100500', datasetId }),
          id,
        ).toMatchObject({ running: { id } });
        expect(await getRun(db, 'test-products-202610100500'), id).toBeNull();
      }
    }));

  it('is not held up by another dataset’s run', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition());
      await applyDefinition(db, testDefinition('test-other'));
      const at = new Date();
      await runningSince(db, 'test-other-202610100000', at, HOUR, 'test-other');
      expect(
        await startRunAlone(db, { id: 'test-products-202610100500', datasetId }),
      ).toMatchObject({ created: true });
    }));
});

describe('a definition’s scope', () => {
  it('moves the taxonomy to a new version when it changes, and says so on a dry run', () =>
    withRollback(async (db) => {
      const definition = testTaxonomyDefinition('scoped');
      await applyDefinition(db, definition);
      await seedTaxonomyVersion(db, {
        datasetId: 'scoped',
        taxonomy: testTaxonomy(),
        actor: { role: 'owner', client: 'cli' },
        at: new Date(),
      });
      const scope =
        'Hi-fi made for audio: headphones, DACs, amplifiers, and speakers. Out of scope: cables.';
      const dry = await applyDefinition(db, { ...definition, scope }, { dryRun: true });
      expect(dry.taxonomyVersion).toBe(2);
      expect((await currentTaxonomy(db, 'scoped'))!.version).toBe(1);
      const applied = await applyDefinition(db, { ...definition, scope });
      expect(applied.taxonomyVersion).toBe(2);
      const now = (await currentTaxonomy(db, 'scoped'))!;
      expect(now).toMatchObject({ version: 2, actor: { role: 'owner', client: 'cli' } });
      expect(now.taxonomy.scope).toBe(scope);
      expect(now.changes).toEqual([
        expect.objectContaining({
          change: { kind: 'scope', scope },
          summary: 'Change the scope statement',
        }),
      ]);
      // The same definition again changes nothing.
      expect((await applyDefinition(db, { ...definition, scope })).taxonomyVersion).toBeUndefined();
    }));
});

describe('listDatasets', () => {
  it('lists every dataset by ID, with its revision and the generation at its head', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition('list-b'));
      await applyDefinition(db, testDefinition('list-a'));
      await applyDefinition(db, { ...testDefinition('list-a'), consumers: ['crowdio'] });
      const listed = (await listDatasets(db)).filter((dataset) => dataset.id.startsWith('list-'));
      expect(listed).toEqual([
        { id: 'list-a', revision: 2, headGeneration: 0 },
        { id: 'list-b', revision: 1, headGeneration: 0 },
      ]);
    }));
});
