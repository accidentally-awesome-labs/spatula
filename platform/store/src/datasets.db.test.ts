import { parseDefinition, type Definition } from '@spatula/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import type { Executor } from './client';
import { applyDefinition, getDataset, listLiveItems } from './datasets';
import { testDefinition } from './fixtures';
import { finishRun, getRun, startRun } from './runs';
import { datasets, sources } from './schema';

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
