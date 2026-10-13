import { PAGE_METHODS, type Method, type PagesSource, type StatementInput } from '@spatula/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { fetchOf, seedDataset, statementOf, T } from '../test/seed';
import type { Executor } from './client';
import { applyDefinition, listLiveItems, type ItemRef } from './datasets';
import { judge } from './decisions';
import { matchSides, resolveEntities, type MatchSides } from './entities';
import { setItemStatus } from './fetches';
import { testDefinition } from './fixtures';
import { items, type Judge } from './schema';
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

const resolve = (db: Executor, more: { maxQuestions?: number; deciderCanAnswer?: boolean } = {}) =>
  resolveEntities(db, { datasetId: 'test-products', definition: testDefinition(), ...more });

/** The test dataset with a third page for maker A, and maker A's three pages. */
async function makerAThree(db: Executor) {
  const full = testDefinition();
  const makerA = full.sources[0] as PagesSource;
  await applyDefinition(db, {
    ...full,
    sources: [
      { ...makerA, pages: [...makerA.pages, 'https://maker-a.example/products/a3'] },
      full.sources[1]!,
    ],
  });
  const [a1, a2, a3] = (await listLiveItems(db, 'test-products')).filter(
    (item) => item.sourceId === 'maker-a',
  );
  return [a1!, a2!, a3!] as const;
}

/** A verdict on a page, against an entity. */
const judged = (
  db: Executor,
  item: ItemRef,
  entityId: string,
  verdict: 'same' | 'not_same' | 'unsure',
  who: Judge = 'llm',
) =>
  judge(db, {
    datasetId: 'test-products',
    itemId: item.id,
    entityId,
    verdict,
    who,
    confidence: 1,
    decisionId: null,
    at: T(1),
  });

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
        waiting: 0,
        questions: [],
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
        waiting: 0,
        questions: [],
        notes: [
          `${a2!.locator} claims gtins:00036000291452, which belongs to ${e1}, while the page belongs to ${e2}`,
          expect.stringContaining('has nothing to identify it by yet'),
        ],
      });
      expect([await entityOf(db, a1!), await entityOf(db, a2!)]).toEqual([e1, e2]);
    }));

  it('asks before joining by name when the identifiers disagree, and follows the verdict', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
        runId,
      } = await seedDataset(db);
      await says(db, runId, a1!, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a2!, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));
      const first = await resolve(db);
      const e1 = await entityOf(db, a1!);
      expect(first).toMatchObject({ created: 1, linked: 0, waiting: 1 });
      expect(first.questions).toEqual([{ itemId: a2!.id, entityId: e1 }]);
      expect(await entityOf(db, a2!)).toBeNull();

      // A variant: the page starts its own entity, and the name it shares isn't a conflict.
      await judge(db, {
        datasetId: 'test-products',
        itemId: a2!.id,
        entityId: e1!,
        verdict: 'not_same',
        who: 'llm',
        confidence: 0.97,
        decisionId: null,
        at: T(1),
      });
      expect(await resolve(db)).toMatchObject({
        created: 1,
        conflicts: 0,
        waiting: 0,
        questions: [],
      });
      expect(await entityOf(db, a2!)).not.toBe(e1);
    }));

  it('asks about a similar name within the brand, and waits on an unsure verdict', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2, b1],
        runId,
      } = await seedDataset(db);
      const named = (brand: string, name: string) => [
        statementOf('brand', brand),
        statementOf('name', name, 'jsonld'),
      ];
      await says(db, runId, a1!, 0, named('Maker A', 'HD 660S'));
      await says(db, runId, a2!, 0, named('Maker A', 'HD 660S2'));
      await says(db, runId, b1!, 0, named('Maker B', 'HD 660S2'));
      const first = await resolve(db);
      const e1 = await entityOf(db, a1!);
      // B1 is another brand's, so it starts its own entity without a question.
      expect(first).toMatchObject({
        created: 2,
        waiting: 1,
        questions: [{ itemId: a2!.id, entityId: e1 }],
      });

      await judge(db, {
        datasetId: 'test-products',
        itemId: a2!.id,
        entityId: e1!,
        verdict: 'unsure',
        who: 'llm',
        confidence: 0.5,
        decisionId: null,
        at: T(1),
      });
      // Unsure waits for a person, and nothing is asked again.
      expect(await resolve(db)).toMatchObject({ created: 0, linked: 0, waiting: 1, questions: [] });
      expect(await entityOf(db, a2!)).toBeNull();
    }));

  it('joins the page to the entity when the verdict is that they are the same', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
        runId,
      } = await seedDataset(db);
      await says(db, runId, a1!, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a2!, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));
      await resolve(db);
      const e1 = await entityOf(db, a1!);
      await judge(db, {
        datasetId: 'test-products',
        itemId: a2!.id,
        entityId: e1!,
        verdict: 'same',
        who: 'person',
        confidence: 1,
        decisionId: null,
        at: T(1),
      });
      // The GTIN a2 brought is now the entity's, and it isn't a conflict: the page belongs to it.
      expect(await resolve(db)).toMatchObject({ created: 0, linked: 1, conflicts: 0, waiting: 0 });
      expect(await entityOf(db, a2!)).toBe(e1);
      expect(await resolve(db)).toMatchObject({ linked: 0, conflicts: 0, waiting: 0 });
    }));

  it('asks again about a pair nobody could be asked about, once a decider can be', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
        runId,
      } = await seedDataset(db);
      await says(db, runId, a1!, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a2!, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));
      await resolve(db);
      const e1 = (await entityOf(db, a1!))!;
      const unsure = (who: Judge) =>
        judge(db, {
          datasetId: 'test-products',
          itemId: a2!.id,
          entityId: e1,
          verdict: 'unsure',
          who,
          confidence: 0,
          decisionId: null,
          at: T(1),
        });
      const waits = { waiting: 1, questions: [] };

      // Escalated when no decider could be asked, the pair is unsure "by rule". It waits for a
      // person while none can be asked...
      await unsure('rule');
      expect(await resolve(db)).toMatchObject(waits);
      expect(await resolve(db, { deciderCanAnswer: false })).toMatchObject(waits);
      // ...and is asked again once one can.
      expect(await resolve(db, { deciderCanAnswer: true })).toMatchObject({
        waiting: 1,
        questions: [{ itemId: a2!.id, entityId: e1 }],
      });

      // A decider's own "unsure" and a person's are answers: they wait for a person, whoever could
      // be asked.
      await unsure('llm');
      expect(await resolve(db, { deciderCanAnswer: true })).toMatchObject(waits);
      await unsure('person');
      expect(await resolve(db, { deciderCanAnswer: true })).toMatchObject(waits);
    }));

  it('raises at most maxQuestions questions, and the pages it has no room for still wait', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      // A third page for maker A: two pages give GTINs that disagree with the first's.
      const [a1, a2, a3] = await makerAThree(db);
      await says(db, runId, a1, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a2, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));
      await says(db, runId, a3, 0, product('Maker A', 'DT 770 PRO', '04010118471087'));

      const capped = await resolve(db, { maxQuestions: 1 });
      const e1 = await entityOf(db, a1);
      expect(capped).toMatchObject({ created: 1, waiting: 2 });
      expect(capped.questions).toEqual([{ itemId: a2.id, entityId: e1 }]);
      // Without a cap, each page is asked about.
      expect((await resolve(db)).questions).toEqual([
        { itemId: a2.id, entityId: e1 },
        { itemId: a3.id, entityId: e1 },
      ]);
    }));

  it('raises the questions it asks for the first time before those it asks again', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, a2, a3] = await makerAThree(db);
      await says(db, runId, a1, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a2, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));
      await says(db, runId, a3, 0, product('Maker A', 'DT 770 PRO', '04010118471087'));
      await resolve(db);
      const e1 = (await entityOf(db, a1))!;

      // A2's pair was escalated when no decider could be asked. A3's was never asked at all.
      await judged(db, a2, e1, 'unsure', 'rule');
      const asked = { deciderCanAnswer: true };
      // With room for one question, the one nobody has asked yet takes it, though A2 comes first.
      expect((await resolve(db, { ...asked, maxQuestions: 1 })).questions).toEqual([
        { itemId: a3.id, entityId: e1 },
      ]);
      expect((await resolve(db, asked)).questions).toEqual([
        { itemId: a3.id, entityId: e1 },
        { itemId: a2.id, entityId: e1 },
      ]);
    }));
});

describe('resolveEntities where one name carries several versions', () => {
  /** A page that gives its name and nothing else. */
  const named = [statementOf('brand', 'Maker A'), statementOf('name', 'DT 770 PRO', 'jsonld')];

  it('holds a page with only a name while a page of that name waits to hear about its entity', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, a2, a3] = await makerAThree(db);
      await says(db, runId, a1, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a2, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));
      await says(db, runId, a3, 0, named);

      // A2 asks whether it is A1's product. A3 could be either version, and waits for the answer.
      const first = await resolve(db);
      const e1 = (await entityOf(db, a1))!;
      expect(first).toMatchObject({ created: 1, linked: 0, waiting: 2 });
      expect(first.questions).toEqual([{ itemId: a2.id, entityId: e1 }]);
      expect(await entityOf(db, a3)).toBeNull();

      // A variant: A2 has its own entity now, and A3 is asked about both.
      await judged(db, a2, e1, 'not_same');
      const second = await resolve(db);
      const e2 = (await entityOf(db, a2))!;
      expect(e2).not.toBe(e1);
      expect(second).toMatchObject({ created: 1, linked: 0, conflicts: 0, waiting: 1 });
      expect(second.questions).toEqual([
        { itemId: a3.id, entityId: e1 },
        { itemId: a3.id, entityId: e2 },
      ]);
      expect(await entityOf(db, a3)).toBeNull();
    }));

  it('holds it while a person has yet to answer, and joins it when the pages are one product', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, a2, a3] = await makerAThree(db);
      await says(db, runId, a1, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a2, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));
      await says(db, runId, a3, 0, named);
      await resolve(db);
      const e1 = (await entityOf(db, a1))!;

      await judged(db, a2, e1, 'unsure');
      expect(await resolve(db)).toMatchObject({ linked: 0, waiting: 2, questions: [] });
      expect(await entityOf(db, a3)).toBeNull();

      // They are one product, and so is the page that gave only a name.
      await judged(db, a2, e1, 'same', 'person');
      expect(await resolve(db)).toMatchObject({ linked: 2, waiting: 0, questions: [] });
      expect(await entityOf(db, a2)).toBe(e1);
      expect(await entityOf(db, a3)).toBe(e1);
    }));

  it('joins a page with only a name to the one entity that has it, as before', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, , a3] = await makerAThree(db);
      await says(db, runId, a1, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a3, 0, named);
      expect(await resolve(db)).toMatchObject({ created: 1, linked: 1, waiting: 0, questions: [] });
      expect(await entityOf(db, a3)).toBe(await entityOf(db, a1));
    }));
});

describe('resolveEntities where two entities are kept apart', () => {
  /** A1 and A2 are two versions of one model, A2 split off A1 by a "variant" answer. */
  async function split(db: Executor) {
    const { runId } = await seedDataset(db);
    const [a1, a2, a3] = await makerAThree(db);
    await says(db, runId, a1, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
    await says(db, runId, a2, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));
    await resolve(db);
    const e1 = (await entityOf(db, a1))!;
    await judged(db, a2, e1, 'not_same');
    expect(await resolve(db)).toMatchObject({ created: 1, conflicts: 0 });
    return { runId, a1, a2, a3, e1, e2: (await entityOf(db, a2))! };
  }

  /** What a run noted about claims in conflict. */
  const conflictNotes = (notes: string[]) => notes.filter((text) => text.includes(' claims '));

  it('reports no conflict over the name they share, whichever page joins the split-off one', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, a2, a3] = await makerAThree(db);
      await says(db, runId, a1, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a2, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));
      await says(db, runId, a3, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));
      await resolve(db);
      const e1 = (await entityOf(db, a1))!;
      await judged(db, a2, e1, 'not_same');

      // A2 starts the split-off entity, and A3, with no verdict of its own, joins it by their GTIN.
      const split = await resolve(db);
      const e2 = (await entityOf(db, a2))!;
      expect(split).toMatchObject({ created: 1, linked: 1, conflicts: 0 });
      expect(await entityOf(db, a3)).toBe(e2);
      expect(conflictNotes(split.notes)).toEqual([]);
      // And it stays quiet: the pair doesn't become a conflict on the next run.
      const next = await resolve(db);
      expect(next).toMatchObject({ created: 0, linked: 0, conflicts: 0 });
      expect(conflictNotes(next.notes)).toEqual([]);
      expect([await entityOf(db, a1), await entityOf(db, a2)]).toEqual([e1, e2]);
    }));

  it('keeps them apart from either side', () =>
    withRollback(async (db) => {
      const { runId, a1, a2 } = await split(db);
      // A2 names its product for another version, which its entity claims...
      await says(db, runId, a2, 5, product('Maker A', 'DT 770 PRO 250', '04010118471070'));
      expect(await resolve(db)).toMatchObject({ conflicts: 0 });
      // ...and A1 takes the name too. The entity that claimed it belongs to the other side.
      await says(db, runId, a1, 6, product('Maker A', 'DT 770 PRO 250', '04010118471063'));
      const named = await resolve(db);
      expect(named).toMatchObject({ conflicts: 0 });
      expect(conflictNotes(named.notes)).toEqual([]);
    }));

  it('reports a shared name when nobody judged the two not the same', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, a2, b1] = (await listLiveItems(db, 'test-products')).sort((a, b) =>
        a.locator.localeCompare(b.locator),
      );
      await says(db, runId, a1!, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, b1!, 0, product('Maker B', 'B1 Amp', '04006381333931'));
      await says(db, runId, a2!, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));
      await resolve(db);
      const e1 = (await entityOf(db, a1!))!;
      // A2 isn't sure of being A1's product, and nobody has said. It gives B1's GTIN too, which
      // joins it to B1's entity, and leaves the name it shares with A1 in conflict.
      await judged(db, a2!, e1, 'unsure');
      await says(db, runId, a2!, 5, [
        ...product('Maker A', 'DT 770 PRO', '04010118471070'),
        statementOf('gtins', '04006381333931', 'jsonld'),
      ]);
      const joined = await resolve(db);
      expect(joined).toMatchObject({ linked: 1, conflicts: 1 });
      expect(await entityOf(db, a2!)).toBe(await entityOf(db, b1!));
      expect(conflictNotes(joined.notes)).toEqual([
        expect.stringContaining('claims key0:makera|dt770pro'),
      ]);
    }));

  it('reports the GTIN of one that a page of the other gives, however far apart they are kept', () =>
    withRollback(async (db) => {
      const { runId, a2, e1, e2 } = await split(db);
      // A2, kept apart from A1's entity, now lists A1's GTIN too.
      await says(db, runId, a2, 5, [
        ...product('Maker A', 'DT 770 PRO', '04010118471070'),
        statementOf('gtins', '04010118471063', 'jsonld'),
      ]);
      const again = await resolve(db);
      // One conflict: the GTIN. The name the two share is still no conflict.
      expect(again).toMatchObject({ conflicts: 1, linked: 0, created: 0 });
      expect(conflictNotes(again.notes)).toEqual([
        `${a2.locator} claims gtins:04010118471063, which belongs to ${e1}, while the page belongs to ${e2}`,
      ]);
    }));
});

describe('matchSides', () => {
  const sidesFor = (
    db: Executor,
    itemId: string,
    entityId: string,
    definition = testDefinition(),
  ) => matchSides(db, { definition, itemId, entityId });

  it('gives the page’s values, and the entity’s merged from its live pages', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2, b1],
        runId,
      } = await seedDataset(db);
      // A1 and A2 share a GTIN, so they're one entity. B1 is the page that asks.
      await says(db, runId, a1!, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a2!, 0, [
        ...product('Maker A', 'DT 770 PRO (2024)', '04010118471063'),
        statementOf('mpns', 'DT-770-250', 'jsonld'),
      ]);
      await resolve(db);
      const e1 = (await entityOf(db, a1!))!;
      await says(db, runId, b1!, 0, product('Maker B', 'B1 Amp', '04006381333931'));

      expect(await sidesFor(db, b1!.id, e1)).toEqual({
        recordType: 'product',
        page: {
          url: b1!.locator,
          values: { brand: ['Maker B'], name: ['B1 Amp'], gtins: ['04006381333931'] },
        },
        // Its address is the first page's, by address, and its values are each page's, once.
        entity: {
          url: a1!.locator,
          values: {
            brand: ['Maker A'],
            name: ['DT 770 PRO', 'DT 770 PRO (2024)'],
            gtins: ['04010118471063'],
            mpns: ['DT-770-250'],
          },
        },
        entityItemIds: [a1!.id, a2!.id],
      });
    }));

  it('is null when the page isn’t live, the entity has no live page, or the record type is gone', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
        runId,
      } = await seedDataset(db);
      await says(db, runId, a1!, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a2!, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));
      await resolve(db);
      const e1 = (await entityOf(db, a1!))!;
      expect(await sidesFor(db, a2!.id, e1)).not.toBeNull();

      await setItemStatus(db, a2!.id, 'irrelevant');
      expect(await sidesFor(db, a2!.id, e1)).toBeNull();
      await setItemStatus(db, a2!.id, 'live');

      expect(await sidesFor(db, a2!.id, 'sp_00000000000000000000')).toBeNull();
      await setItemStatus(db, a1!.id, 'gone');
      expect(await sidesFor(db, a2!.id, e1)).toBeNull();
      await setItemStatus(db, a1!.id, 'live');

      expect(await sidesFor(db, a2!.id, e1, { ...testDefinition(), recordTypes: {} })).toBeNull();
    }));

  it('reads the same sides whatever order the statements were written in', async () => {
    const mpns = (prefix: string, count: number, method: Method = 'jsonld') =>
      Array.from({ length: count }, (_, index) =>
        statementOf('mpns', `${prefix}-${String(index).padStart(2, '0')}`, method),
      );
    const sides: MatchSides[] = [];
    for (const reverse of [false, true]) {
      await withRollback(async (db) => {
        const {
          items: [a1, a2, b1],
          runId,
        } = await seedDataset(db);
        const inOrder = <T>(list: T[]) => (reverse ? [...list].reverse() : list);
        // A1 and A2 are one entity, with 30 part numbers between them. B1 asks, with 25 of its own,
        // three of which a rule gave: survivorship puts those first, whatever their text.
        const written: [ItemRef, StatementInput[]][] = [
          [a1!, [...product('Maker A', 'DT 770 PRO', '04010118471063'), ...mpns('A1', 15)]],
          [a2!, [...product('Maker A', 'DT 770 PRO', '04010118471063'), ...mpns('A2', 15)]],
        ];
        for (const [item, said] of inOrder(written)) await says(db, runId, item, 0, inOrder(said));
        await resolve(db);
        const e1 = (await entityOf(db, a1!))!;
        const ruled = ['Z-1', 'Z-2', 'Z-3'].map((part) => statementOf('mpns', part, 'rule'));
        await says(db, runId, b1!, 0, inOrder([...mpns('M', 22), ...ruled]));
        const found = (await sidesFor(db, b1!.id, e1))!;
        // The items' IDs are new each time; their addresses aren't.
        const locators = new Map([a1!, a2!, b1!].map((item) => [item.id, item.locator]));
        sides.push({
          ...found,
          entityItemIds: found.entityItemIds.map((id) => locators.get(id) ?? id),
        });
      });
    }
    const [forward, backward] = sides;
    expect(backward).toEqual(forward);
    // The 20 kept are the best 20 by survivorship's order, not the first 20 written or the first
    // 20 by text: a rule's values first, then the others in order of their place and text.
    const numbered = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, '0')}`);
    expect(forward!.page.values.mpns).toEqual(['Z-1', 'Z-2', 'Z-3', ...numbered('M', 17)]);
    expect(forward!.entity.values.mpns).toEqual([...numbered('A1', 15), ...numbered('A2', 5)]);
    expect(forward!.entityItemIds).toEqual([
      'https://maker-a.example/products/a1',
      'https://maker-a.example/products/a2',
    ]);
  });
});
