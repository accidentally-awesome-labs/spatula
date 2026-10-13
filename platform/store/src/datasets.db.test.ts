import { newId, parseDefinition, type Definition } from '@spatula/core';
import { eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import type { Executor } from './client';
import {
  applyDefinition,
  datasetExists,
  getDataset,
  listLiveItems,
  reviveItems,
  StaleDefinitionError,
} from './datasets';
import { findDecision, saveDecision, type NewDecision } from './decisions';
import { testDefinition } from './fixtures';
import { dueItems } from './listing';
import { finishRun, getRun, startRun } from './runs';
import { datasets, items, sources } from './schema';

const pagesOf = async (db: Executor) =>
  (await listLiveItems(db, 'test-products')).map((item) => item.locator);

/** The answer that made a page irrelevant: it is none of the dataset's categories. */
const noneOfThese = (datasetId: string, itemId: string): NewDecision => ({
  id: `dc_none_${itemId}`,
  datasetId,
  type: 'classify',
  subject: itemId,
  subjectKey: `classify:${itemId}`,
  state: {},
  stateHash: 'hash',
  question: { type: 'choice', prompt: 'Which?', options: ['Headphones', 'None of these'] },
  criteriaVersion: 1,
  adapter: 'llm:test-model',
  probabilities: { 'None of these': 0.95 },
  evidence: 'Ear pads.',
  thresholds: { accept: 0.9 },
  outcome: 'accepted',
  answer: 'None of these',
  inputTokens: 0,
  outputTokens: 0,
  decidedAt: new Date(),
});

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
        pages: { added: 3, removed: 0 },
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
      expect(summary.pages).toEqual({ added: 2, removed: 0 });
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
});

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
});
