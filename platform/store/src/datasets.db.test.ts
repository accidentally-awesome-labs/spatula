import { newId, parseDefinition, type Definition, type RunSummary } from '@spatula/core';
import { eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { noneOfThese } from '../test/seed';
import type { Executor } from './client';
import {
  applyDefinition,
  datasetExists,
  getDataset,
  listLiveItems,
  reviveItems,
  StaleDefinitionError,
} from './datasets';
import { findDecision, saveDecision } from './decisions';
import { testDefinition } from './fixtures';
import { dueItems } from './listing';
import { finishRun, getRun, RUN_STALE_MS, startRun, startRunAlone } from './runs';
import { datasets, items, runs, sources } from './schema';

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
      expect(await startRunAlone(db, { id, datasetId, at: new Date() })).toMatchObject({
        created: true,
        run: { id, datasetId, status: 'running', finishedAt: null },
      });
    }));

  it('turns a start away while another run of the dataset is going, names that run, and records nothing', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition());
      const at = new Date();
      await runningSince(db, 'test-products-202610100000', at, HOUR);
      const refused = await startRunAlone(db, {
        id: 'test-products-202610100500',
        datasetId,
        at,
      });
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
        await startRunAlone(db, { id: 'test-products-202610100500', datasetId, at }),
      ).toMatchObject({ running: { id: 'test-products-newer' } });
    }));

  it('finds the run that is already there when the ID is the same, as a second start in a slot does', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition());
      const at = new Date();
      const id = 'test-products-202610100000';
      await runningSince(db, id, at, 60_000);
      // The run in the way is this one itself, so the start is a repeat, not a refusal.
      expect(await startRunAlone(db, { id, datasetId, at })).toMatchObject({
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
        await startRunAlone(db, { id: 'test-products-202610100500', datasetId, at }),
      ).toMatchObject({ created: true, run: { id: 'test-products-202610100500' } });
    }),
  );

  it('takes a run still going after six hours as dead, and one still under six hours as going', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition());
      const at = new Date();
      const start = (id: string) => startRunAlone(db, { id, datasetId, at });
      // Six hours and a minute: dead.
      await runningSince(db, 'test-products-late', at, 6 * HOUR + 60_000);
      expect(await start('test-products-a')).toMatchObject({ created: true });
      await db.delete(runs).where(eq(runs.datasetId, datasetId));
      // Five hours and 59 minutes: still going.
      await runningSince(db, 'test-products-early', at, 6 * HOUR - 60_000);
      expect(await start('test-products-b')).toMatchObject({
        running: { id: 'test-products-early' },
      });
    }));

  it('draws the line at RUN_STALE_MS: a run that began exactly that long ago is dead', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition());
      const at = new Date();
      expect(RUN_STALE_MS).toBe(6 * HOUR);
      // "Less than six hours ago" is going, so one millisecond short of the line still blocks.
      await runningSince(db, 'test-products-edge', at, RUN_STALE_MS - 1);
      expect(await startRunAlone(db, { id: 'test-products-a', datasetId, at })).toMatchObject({
        running: { id: 'test-products-edge' },
      });
      await db
        .update(runs)
        .set({ startedAt: new Date(at.getTime() - RUN_STALE_MS) })
        .where(eq(runs.id, 'test-products-edge'));
      expect(await startRunAlone(db, { id: 'test-products-b', datasetId, at })).toMatchObject({
        created: true,
      });
    }));

  it('is not held up by another dataset’s run', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testDefinition());
      await applyDefinition(db, testDefinition('test-other'));
      const at = new Date();
      await runningSince(db, 'test-other-202610100000', at, HOUR, 'test-other');
      expect(
        await startRunAlone(db, { id: 'test-products-202610100500', datasetId, at }),
      ).toMatchObject({ created: true });
    }));
});
