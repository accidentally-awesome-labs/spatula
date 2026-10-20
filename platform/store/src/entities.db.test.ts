import { PAGE_METHODS, type Method, type PagesSource, type StatementInput } from '@spatula/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { fetchOf, seedDataset, statementOf, T } from '../test/seed';
import type { Executor } from './client';
import { applyDefinition, listLiveItems, type ItemRef } from './datasets';
import { judge } from './decisions';
import { entityMembers, matchSides, resolveEntities, type MatchSides } from './entities';
import { recordFetch, setItemStatus } from './fetches';
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

/** The test dataset with a third and a fourth page for maker A, and maker A's four pages. */
async function makerAFour(db: Executor) {
  const full = testDefinition();
  const makerA = full.sources[0] as PagesSource;
  await applyDefinition(db, {
    ...full,
    sources: [
      {
        ...makerA,
        pages: [
          ...makerA.pages,
          'https://maker-a.example/products/a3',
          'https://maker-a.example/products/a4',
        ],
      },
      full.sources[1]!,
    ],
  });
  const [a1, a2, a3, a4] = (await listLiveItems(db, 'test-products')).filter(
    (item) => item.sourceId === 'maker-a',
  );
  return [a1!, a2!, a3!, a4!] as const;
}

/** A verdict on a page, against an entity. */
const judged = (
  db: Executor,
  item: ItemRef,
  entityId: string,
  verdict: 'same' | 'edition' | 'not_same' | 'unsure',
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
        lineups: {},
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
        lineups: {},
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

describe('resolveEntities where a page gives only a name', () => {
  /** A page that gives its name and nothing else. */
  const named = [statementOf('brand', 'Maker A'), statementOf('name', 'DT 770 PRO', 'jsonld')];

  for (const order of ['before', 'after'] as const) {
    it(`holds it, whichever its address sorts ${order} the pages whose identifiers disagree, until they settle`, () =>
      withRollback(async (db) => {
        const { runId } = await seedDataset(db);
        const pages = await makerAThree(db);
        const [p, v80, v250] = order === 'before' ? pages : [pages[2], pages[0], pages[1]];
        await says(db, runId, p, 0, named);
        await says(db, runId, v80, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
        await says(db, runId, v250, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));

        // The 250 asks about the 80's entity. A name alone doesn't say which of them the page
        // is, so it neither joins that entity nor starts one.
        const first = await resolve(db);
        const e1 = (await entityOf(db, v80))!;
        expect(first).toMatchObject({ created: 1, linked: 0, waiting: 2 });
        expect(first.questions).toEqual([{ itemId: v250.id, entityId: e1 }]);
        expect(await entityOf(db, p)).toBeNull();
        expect(first.notes).toContain(
          '1 page that gives only the name "Maker A DT 770 PRO" waits until it’s settled which entities carry the name',
        );

        // A variant. The page waits this pass too: the 250 was still sorting itself out when the
        // pass began, and no question is raised for the page meanwhile.
        await judged(db, v250, e1, 'not_same');
        const second = await resolve(db);
        const e2 = (await entityOf(db, v250))!;
        expect(e2).not.toBe(e1);
        expect(second).toMatchObject({ created: 1, linked: 0, conflicts: 0, waiting: 1 });
        expect(second.questions).toEqual([]);
        expect(await entityOf(db, p)).toBeNull();

        // Each version has its entity now, and the page is asked about both.
        const third = await resolve(db);
        expect(third).toMatchObject({ created: 0, linked: 0, waiting: 1 });
        expect(third.questions).toEqual([
          { itemId: p.id, entityId: e1 },
          { itemId: p.id, entityId: e2 },
        ]);
        expect(await entityOf(db, p)).toBeNull();
        // Nothing is contested now, so there is no note.
        expect(third.notes.filter((text) => text.includes(' only the name '))).toEqual([]);
      }));
  }

  it('says how many pages wait on a contested name, in one note for the name', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, a2, p1, p2] = await makerAFour(db);
      await says(db, runId, a1, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a2, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));
      await says(db, runId, p1, 0, named);
      await says(db, runId, p2, 0, named);
      const { notes } = await resolve(db);
      expect(notes.filter((text) => text.includes(' only the name '))).toEqual([
        '2 pages that give only the name "Maker A DT 770 PRO" wait until it’s settled which entities carry the name',
      ]);
    }));

  it('cuts a long name in its note, so that the count stays in it', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, a2, p] = await makerAThree(db);
      const long = `Studio ${'x'.repeat(300)}`;
      await says(db, runId, a1, 0, product('Maker A', long, '04010118471063'));
      await says(db, runId, a2, 0, product('Maker A', long, '04010118471070'));
      await says(db, runId, p, 0, [
        statementOf('brand', 'Maker A'),
        statementOf('name', long, 'jsonld'),
      ]);
      const { notes } = await resolve(db);
      const [note, ...more] = notes.filter((text) => text.includes(' only the name '));
      expect(more).toEqual([]);
      expect(note).toMatch(
        /^1 page that gives only the name "Maker A Studio x+…" waits until it’s settled/u,
      );
      expect(note!.length).toBeLessThan(200);
    }));

  it('holds it while a person has yet to say whether another page of that name is its entity’s', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, p, a3] = await makerAThree(db);
      await says(db, runId, a1, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await resolve(db);
      const e1 = (await entityOf(db, a1))!;

      // From an earlier run: the page A3 waits for a person to say whether it is A1's product.
      // It gives only a name, as the page does that sorts before it, so no identifiers disagree.
      await says(db, runId, p, 5, named);
      await says(db, runId, a3, 5, named);
      await judged(db, a3, e1, 'unsure');
      const held = await resolve(db);
      expect(held).toMatchObject({ created: 0, linked: 0, waiting: 2, questions: [] });
      expect(await entityOf(db, p)).toBeNull();
      // No page gives an identifier under the name, and the note doesn't say one does.
      expect(held.notes.filter((text) => text.includes(' only the name '))).toEqual([
        '1 page that gives only the name "Maker A DT 770 PRO" waits until it’s settled which entities carry the name',
      ]);
      expect(await resolve(db)).toMatchObject({ linked: 0, waiting: 2 });

      // The person says they are the same, and the name is no longer contested.
      await judged(db, a3, e1, 'same', 'person');
      expect(await resolve(db)).toMatchObject({ linked: 2, waiting: 0, questions: [] });
      expect(await entityOf(db, p)).toBe(e1);
      expect(await entityOf(db, a3)).toBe(e1);
    }));

  it('counts a verdict only while it still stands, once a decider can be asked', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, p, a3] = await makerAThree(db);
      await says(db, runId, a1, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await resolve(db);
      const e1 = (await entityOf(db, a1))!;
      await says(db, runId, p, 5, named);
      await says(db, runId, a3, 5, named);

      // Unsure "by rule": nobody was asked, so it waits for a person while nobody can be...
      await judged(db, a3, e1, 'unsure', 'rule');
      expect(await resolve(db)).toMatchObject({ linked: 0, waiting: 2 });
      expect(await entityOf(db, p)).toBeNull();
      // ...and is no answer once a decider can be, so it contests nothing.
      expect(await resolve(db, { deciderCanAnswer: true })).toMatchObject({
        linked: 2,
        waiting: 0,
      });
      expect(await entityOf(db, p)).toBe(e1);
    }));

  for (const order of ['before', 'after'] as const) {
    it(`joins the name to one entity where the pages that give identifiers agree, sorting ${order} them`, () =>
      withRollback(async (db) => {
        const { runId } = await seedDataset(db);
        const pages = await makerAThree(db);
        const [p, g1, g2] = order === 'before' ? pages : [pages[2], pages[0], pages[1]];
        await says(db, runId, p, 0, named);
        await says(db, runId, g1, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
        await says(db, runId, g2, 0, product('Maker A', 'DT 770 PRO (2024)', '04010118471063'));
        expect(await resolve(db)).toMatchObject({
          created: 1,
          linked: 2,
          waiting: 0,
          questions: [],
        });
        const entity = await entityOf(db, g1);
        expect([await entityOf(db, p), await entityOf(db, g2)]).toEqual([entity, entity]);
      }));
  }

  it('joins it to the entity once the pages that give identifiers are one entity', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, a2, p] = await makerAThree(db);
      await says(db, runId, a1, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a2, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));
      await says(db, runId, p, 0, named);
      await resolve(db);
      const e1 = (await entityOf(db, a1))!;
      expect(await entityOf(db, p)).toBeNull();

      // They are one product. The page waits through the pass that joins them, which began with
      // their identifiers in dispute, and joins in the next.
      await judged(db, a2, e1, 'same', 'person');
      expect(await resolve(db)).toMatchObject({ linked: 1, waiting: 1, questions: [] });
      expect(await entityOf(db, a2)).toBe(e1);
      expect(await entityOf(db, p)).toBeNull();
      expect(await resolve(db)).toMatchObject({ linked: 1, waiting: 0, questions: [] });
      expect(await entityOf(db, p)).toBe(e1);
    }));

  it('joins or starts an entity for a page of another name, whatever is contested', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, a2, other] = await makerAThree(db);
      await says(db, runId, a1, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a2, 0, product('Maker A', 'DT 770 PRO', '04010118471070'));
      await says(db, runId, other, 0, [
        statementOf('brand', 'Maker A'),
        statementOf('name', 'Amiron Home', 'jsonld'),
      ]);
      // The 770's identifiers disagree, and the page that names a different product starts its own.
      expect(await resolve(db)).toMatchObject({ created: 2, linked: 0, waiting: 1 });
      expect(await entityOf(db, other)).not.toBeNull();
    }));

  it('joins it to the one entity that has the name, as before', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, , a3] = await makerAThree(db);
      await says(db, runId, a1, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a3, 0, named);
      expect(await resolve(db)).toMatchObject({ created: 1, linked: 1, waiting: 0, questions: [] });
      expect(await entityOf(db, a3)).toBe(await entityOf(db, a1));
    }));
});

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

describe('resolveEntities where a page that gives an identifier joins an entity that carries a name', () => {
  const nameOnly = [statementOf('brand', 'Maker A'), statementOf('name', 'DT 770 PRO', 'jsonld')];
  const named = (name: string, ...more: StatementInput[]) => [
    statementOf('brand', 'Maker A'),
    statementOf('name', name, 'jsonld'),
    ...more,
  ];
  const cases = [
    {
      identifier: 'a GTIN',
      // The entity that owns the name gives no identifiers. Another, which has another name,
      // owns the GTIN.
      owner: nameOnly,
      other: named('DT 770 Studio', statementOf('gtins', '04010118471070', 'jsonld')),
      shared: statementOf('gtins', '04010118471070', 'jsonld'),
    },
    {
      identifier: 'a part number',
      owner: product('Maker A', 'DT 770 PRO', '04010118471063'),
      other: named('DT 770 PRO 250 Ohm', statementOf('mpns', 'DT770-250', 'jsonld')),
      shared: statementOf('mpns', 'DT770-250', 'jsonld'),
    },
  ];

  for (const { identifier, owner, other, shared } of cases) {
    for (const order of ['first', 'last'] as const) {
      it(`asks about both entities, not only the one that owns the name, where the page that gives only the name sorts ${order} and the other gives ${identifier}`, () =>
        withRollback(async (db) => {
          const { runId } = await seedDataset(db);
          const [a1, a2, a3, a4] = await makerAFour(db);
          await says(db, runId, a1, 0, owner);
          await says(db, runId, a2, 0, other);
          expect(await resolve(db)).toMatchObject({ created: 2 });
          const [e1, eY] = [(await entityOf(db, a1))!, (await entityOf(db, a2))!];

          // The page that gives the identifier joins the entity that owns it, which then carries
          // the name too. The page that gives only the name can't be told apart from either.
          const [page, joining] = order === 'first' ? [a3, a4] : [a4, a3];
          await says(db, runId, page, 5, nameOnly);
          await says(db, runId, joining, 5, named('DT 770 PRO', shared));
          const second = await resolve(db);
          expect(await entityOf(db, joining)).toBe(eY);
          expect(await entityOf(db, page)).toBeNull();
          expect(second).toMatchObject({ linked: 1, created: 0, waiting: 1 });
          expect(second.questions).toEqual([
            { itemId: page.id, entityId: e1 },
            { itemId: page.id, entityId: eY },
          ]);
        }));
    }
  }
});

/** Every order of a list. */
const orders = <T>(list: readonly T[]): T[][] =>
  list.length < 2
    ? [[...list]]
    : list.flatMap((item, at) =>
        orders([...list.slice(0, at), ...list.slice(at + 1)]).map((rest) => [item, ...rest]),
      );

describe('resolveEntities where a verdict places a page that gives only a name', () => {
  const nameOnly = [statementOf('brand', 'Maker A'), statementOf('name', 'DT 770 PRO', 'jsonld')];
  const roles = ['same', 'apart', 'new'] as const;

  // A decider says the "same" page is the entity's and a person says the "apart" page isn't, so in
  // the pass that reads the answers the first joins the entity and the second starts one, and both
  // then carry the name. The new page has no verdict. Whichever of the three sorts first, it has to
  // see where the others land: it is asked about both entities, and joins neither.
  for (const order of orders(roles)) {
    it(`asks a page with no verdict about both entities, with the pages sorting ${order.join(', ')}`, () =>
      withRollback(async (db) => {
        const { runId } = await seedDataset(db);
        const [owner, ...sorted] = await makerAFour(db);
        const at = Object.fromEntries(order.map((role, index) => [role, sorted[index]!])) as Record<
          (typeof roles)[number],
          ItemRef
        >;
        await says(db, runId, owner!, 0, product('Maker A', 'DT 770 PRO X', '04010118471087'));
        await says(db, runId, at.same, 0, nameOnly);
        await says(db, runId, at.apart, 0, nameOnly);
        const first = await resolve(db);
        expect(first).toMatchObject({ created: 1, linked: 0, waiting: 2 });
        const e1 = (await entityOf(db, owner!))!;
        expect(first.questions).toHaveLength(2);

        await judged(db, at.same, e1, 'same');
        await judged(db, at.apart, e1, 'not_same', 'person');
        await says(db, runId, at.new, 5, nameOnly);
        const second = await resolve(db);
        expect(await entityOf(db, at.same)).toBe(e1);
        const started = await entityOf(db, at.apart);
        expect(started).not.toBeNull();
        expect(started).not.toBe(e1);
        expect(await entityOf(db, at.new)).toBeNull();
        expect(second).toMatchObject({ linked: 1, created: 1, conflicts: 0, waiting: 1 });
        expect(second.questions.map((question) => question.itemId)).toEqual([at.new.id, at.new.id]);
        expect(second.questions.map((question) => question.entityId).sort()).toEqual(
          [e1, started!].sort(),
        );
      }));
  }

  // Three pages of that name are asked about the entity. A decider says the "same" page is the
  // entity's, a person says the "apart" page isn't, and a decider is unsure about the third. Only
  // the first two place a page: "unsure" places nothing, so the third has to see where they land.
  // Whichever of the three sorts first, it waits for the answer to its question.
  const unsureRoles = ['same', 'apart', 'unsure'] as const;
  for (const order of orders(unsureRoles)) {
    it(`holds back a page that is only unsure, with the pages sorting ${order.join(', ')}`, () =>
      withRollback(async (db) => {
        const { runId } = await seedDataset(db);
        const [owner, ...sorted] = await makerAFour(db);
        const at = Object.fromEntries(order.map((role, index) => [role, sorted[index]!])) as Record<
          (typeof unsureRoles)[number],
          ItemRef
        >;
        await says(db, runId, owner!, 0, product('Maker A', 'DT 770 PRO X', '04010118471087'));
        for (const page of sorted) await says(db, runId, page, 0, nameOnly);
        const first = await resolve(db);
        expect(first).toMatchObject({ created: 1, linked: 0, waiting: 3 });
        const e1 = (await entityOf(db, owner!))!;
        expect(first.questions).toHaveLength(3);

        await judged(db, at.same, e1, 'same');
        await judged(db, at.apart, e1, 'not_same', 'person');
        await judged(db, at.unsure, e1, 'unsure');
        const second = await resolve(db);
        expect(await entityOf(db, at.same)).toBe(e1);
        const started = await entityOf(db, at.apart);
        expect(started).not.toBeNull();
        expect(started).not.toBe(e1);
        expect(await entityOf(db, at.unsure)).toBeNull();
        expect(second).toMatchObject({
          linked: 1,
          created: 1,
          conflicts: 0,
          waiting: 1,
          questions: [],
        });
      }));
  }

  it('keeps a page that a verdict places ahead, though unsure about another entity too', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [owner, fresh, mixed, same] = await makerAFour(db);
      const [aside] = (await listLiveItems(db, 'test-products')).filter(
        (item) => item.sourceId === 'maker-b',
      );
      await says(db, runId, owner!, 0, product('Maker A', 'DT 770 PRO X', '04010118471087'));
      await says(db, runId, aside!, 0, product('Maker A', 'Quartz', '04010118471070'));
      for (const page of [fresh!, mixed!, same!]) await says(db, runId, page, 0, nameOnly);
      expect(await resolve(db)).toMatchObject({ created: 2, waiting: 3 });
      const [e1, e2] = [(await entityOf(db, owner!))!, (await entityOf(db, aside!))!];

      // The mixed page has a question open about the other entity, which has nothing to do with
      // its name, so that question holds nothing back. A person says it isn't the first entity's.
      await judged(db, mixed!, e1, 'not_same', 'person');
      await judged(db, mixed!, e2, 'unsure');
      await judged(db, same!, e1, 'same');
      const second = await resolve(db);
      expect(await entityOf(db, same!)).toBe(e1);
      const started = await entityOf(db, mixed!);
      expect(started).not.toBeNull();
      expect([e1, e2]).not.toContain(started);
      expect(await entityOf(db, fresh!)).toBeNull();
      expect(second).toMatchObject({ linked: 1, created: 1, conflicts: 0, waiting: 1 });
      expect(second.questions.map((question) => question.itemId)).toEqual([fresh!.id, fresh!.id]);
      expect(second.questions.map((question) => question.entityId).sort()).toEqual(
        [e1, started!].sort(),
      );
    }));

  it('plans a page that gives an identifier ahead of one with a verdict, which then sees where it lands', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [owner, other, page, joining] = await makerAFour(db);
      await says(db, runId, owner!, 0, product('Maker A', 'DT 770 PRO X', '04010118471087'));
      await says(db, runId, other!, 0, product('Maker A', 'DT 770 Studio', '04010118471070'));
      await says(db, runId, page!, 0, nameOnly);
      const first = await resolve(db);
      expect(first).toMatchObject({ created: 2, waiting: 1 });
      const [e1, eY] = [(await entityOf(db, owner!))!, (await entityOf(db, other!))!];
      expect(first.questions).toEqual([{ itemId: page!.id, entityId: e1 }]);

      // A person says the page isn't the "X". Then a page that sorts after it gives the GTIN of the
      // other entity and the same name, and joins that entity, which carries the name from then on.
      await judged(db, page!, e1, 'not_same', 'person');
      await says(db, runId, joining!, 5, product('Maker A', 'DT 770 PRO', '04010118471070'));
      const second = await resolve(db);
      expect(await entityOf(db, joining!)).toBe(eY);
      expect(await entityOf(db, page!)).toBe(eY);
      expect(second).toMatchObject({ linked: 2, created: 0, conflicts: 0, waiting: 0 });
    }));
});

describe('resolveEntities where verdicts say a page is the same as several entities', () => {
  const nameOnly = [statementOf('brand', 'Maker A'), statementOf('name', 'DT 770 PRO', 'jsonld')];

  /** The versions split, a page that gives only the name, and the two entities by their IDs. */
  async function pageAndVersions(db: Executor) {
    const { runId, a3: page, e1, e2 } = await split(db);
    await says(db, runId, page, 5, nameOnly);
    const [low, high] = [e1, e2].sort();
    return { page, low: low!, high: high! };
  }

  it('joins neither where decider verdicts say it is both, and says so', () =>
    withRollback(async (db) => {
      const { page, low, high } = await pageAndVersions(db);
      await judged(db, page, low, 'same');
      await judged(db, page, high, 'same');
      const result = await resolve(db);
      expect(result).toMatchObject({ linked: 0, waiting: 1, questions: [] });
      expect(await entityOf(db, page)).toBeNull();
      expect(result.notes).toContain(
        `${page.locator} is judged the same as ${low} and ${high}, so it joins neither`,
      );
      // Nothing in the note promises that a person will settle it, and nothing is asked.
      expect(await resolve(db)).toMatchObject({ linked: 0, waiting: 1, questions: [] });
    }));

  it('joins none of three that decider verdicts say it is, and says so', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, a2, a3, page] = await makerAFour(db);
      // Three entities whose names are nothing alike, so that nothing is asked about them.
      await says(db, runId, a1, 0, product('Maker A', 'Aurora', '04010118471063'));
      await says(db, runId, a2, 0, product('Maker A', 'Zephyr', '04010118471070'));
      await says(db, runId, a3, 0, product('Maker A', 'Quartz', '04010118471087'));
      expect(await resolve(db)).toMatchObject({ created: 3, questions: [] });
      const entities = [
        (await entityOf(db, a1))!,
        (await entityOf(db, a2))!,
        (await entityOf(db, a3))!,
      ].sort();
      await says(db, runId, page, 5, nameOnly);
      for (const entityId of entities) await judged(db, page, entityId, 'same');
      const result = await resolve(db);
      expect(result).toMatchObject({ linked: 0, waiting: 1, questions: [] });
      expect(await entityOf(db, page)).toBeNull();
      const [first, second, third] = entities;
      expect(result.notes).toContain(
        `${page.locator} is judged the same as ${first}, ${second} and ${third}, so it joins none of them`,
      );
    }));

  it('joins the one entity a person said it is, though a decider said it is the other too', () =>
    withRollback(async (db) => {
      const { page, low, high } = await pageAndVersions(db);
      await judged(db, page, low, 'same');
      await judged(db, page, high, 'same', 'person');
      expect(await resolve(db)).toMatchObject({ linked: 1, waiting: 0 });
      expect(await entityOf(db, page)).toBe(high);
    }));

  it('joins neither where a person said it is both, since neither is the person’s choice', () =>
    withRollback(async (db) => {
      const { page, low, high } = await pageAndVersions(db);
      await judged(db, page, low, 'same', 'person');
      await judged(db, page, high, 'same', 'person');
      const result = await resolve(db);
      expect(result).toMatchObject({ linked: 0, waiting: 1 });
      expect(await entityOf(db, page)).toBeNull();
      expect(result.notes).toContain(
        `${page.locator} is judged the same as ${low} and ${high}, so it joins neither`,
      );
    }));

  it('waits for the question about one entity, though a decider said it is the other', () =>
    withRollback(async (db) => {
      const { page, low, high } = await pageAndVersions(db);
      await judged(db, page, low, 'same');
      await judged(db, page, high, 'unsure');
      expect(await resolve(db)).toMatchObject({ linked: 0, waiting: 1, questions: [] });
      expect(await entityOf(db, page)).toBeNull();
      // The person says it isn't, and the page joins the other. Or the person says it is, and it
      // joins that.
      await judged(db, page, high, 'not_same', 'person');
      expect(await resolve(db)).toMatchObject({ linked: 1, waiting: 0 });
      expect(await entityOf(db, page)).toBe(low);
    }));

  it('joins the entity a person said it is, though a question about the other waits', () =>
    withRollback(async (db) => {
      const { page, low, high } = await pageAndVersions(db);
      await judged(db, page, high, 'same', 'person');
      await judged(db, page, low, 'unsure');
      expect(await resolve(db)).toMatchObject({ linked: 1, waiting: 0 });
      expect(await entityOf(db, page)).toBe(high);
    }));
});

describe('resolveEntities where two entities are kept apart', () => {
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

  it('gives the page’s values, and the entity’s merged from its base page and the pages written as it', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2, b1],
        runId,
      } = await seedDataset(db);
      // A1 and A2 share a GTIN, so they're one entity, and A2 writes A1's name another way, so it
      // counts with the base page. B1 is the page that asks.
      await says(db, runId, a1!, 0, product('Maker A', 'DT 770 PRO', '04010118471063'));
      await says(db, runId, a2!, 0, [
        ...product('Maker A', 'DT-770 PRO', '04010118471063'),
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
            name: ['DT 770 PRO', 'DT-770 PRO'],
            gtins: ['04010118471063'],
            mpns: ['DT-770-250'],
          },
        },
        // A name written as the record's is no edition.
        editions: [],
        // Every live page's name, by the page's address, for the model-number rule.
        entityNames: ['DT 770 PRO', 'DT-770 PRO'],
        entityItemIds: [a1!.id, a2!.id],
      });
    }));

  it('gives the record’s editions by name, and its values and address from its base page', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, a2, a3] = await makerAThree(db);
      await says(db, runId, a1, 0, product('Maker A', 'DJ 300 PRO X', '04010118471063'));
      await says(db, runId, a2, 0, product('Maker A', 'DJ 300 PRO X Club', '04010118471070'));
      await resolve(db);
      const e1 = (await entityOf(db, a1))!;
      await judged(db, a2, e1, 'edition', 'person');
      await resolve(db);
      expect(await entityOf(db, a2)).toBe(e1);
      await says(db, runId, a3, 0, product('Maker A', 'DJ 300 PRO X Silver', '04010118471087'));
      expect(await sidesFor(db, a3.id, e1)).toMatchObject({
        entity: {
          url: a1.locator,
          values: { brand: ['Maker A'], name: ['DJ 300 PRO X'], gtins: ['04010118471063'] },
        },
        editions: ['DJ 300 PRO X Club'],
        // The edition page's name is among the record's names, though not among its values.
        entityNames: ['DJ 300 PRO X', 'DJ 300 PRO X Club'],
        entityItemIds: [a1.id, a2.id],
      });
    }));

  it('gives the record by its base page, though its edition started it and the base joined as an edition', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, a2, a3] = await makerAThree(db);
      // The Club's page starts the record, and the base page joins it as an edition.
      await says(db, runId, a1, 0, product('Maker A', 'DJ 300 PRO X Club', '04010118471063'));
      await says(db, runId, a2, 0, product('Maker A', 'DJ 300 PRO X', '04010118471070'));
      await resolve(db);
      const e1 = (await entityOf(db, a1))!;
      await judged(db, a2, e1, 'edition', 'person');
      await resolve(db);
      expect(await entityOf(db, a2)).toBe(e1);
      await says(db, runId, a3, 0, product('Maker A', 'DJ 300 PRO X Silver', '04010118471087'));
      expect(await sidesFor(db, a3.id, e1)).toMatchObject({
        entity: {
          url: a2.locator,
          values: { brand: ['Maker A'], name: ['DJ 300 PRO X'], gtins: ['04010118471070'] },
        },
        editions: ['DJ 300 PRO X Club'],
        entityNames: ['DJ 300 PRO X Club', 'DJ 300 PRO X'],
        entityItemIds: [a1.id, a2.id],
      });
    }));

  it('names at most ten of the record’s editions, the first by name, and every name for the rule', () =>
    withRollback(async (db) => {
      const {
        items: [, , b1],
        runId,
      } = await seedDataset(db);
      // A1 and eleven more pages of maker A, each an edition by name, all with one GTIN.
      const full = testDefinition();
      const makerA = full.sources[0] as PagesSource;
      const extra = Array.from(
        { length: 10 },
        (_, index) => `https://maker-a.example/products/a${index + 3}`,
      );
      await applyDefinition(db, {
        ...full,
        sources: [{ ...makerA, pages: [...makerA.pages, ...extra] }, full.sources[1]!],
      });
      const pages = (await listLiveItems(db, 'test-products')).filter(
        (item) => item.sourceId === 'maker-a',
      );
      expect(pages).toHaveLength(12);
      const editionNames = Array.from(
        { length: 11 },
        (_, index) => `DJ 300 PRO X Edition ${String(index + 1).padStart(2, '0')}`,
      );
      const names = ['DJ 300 PRO X', ...editionNames];
      for (const [index, page] of pages.entries()) {
        await says(db, runId, page, 0, product('Maker A', names[index]!, '04010118471063'));
      }
      await resolve(db);
      const e1 = (await entityOf(db, pages[0]!))!;
      await says(db, runId, b1!, 0, product('Maker B', 'B1 Amp', '04006381333931'));
      const sides = (await sidesFor(db, b1!.id, e1))!;
      expect(sides.entity.values.name).toEqual(['DJ 300 PRO X']);
      expect(sides.editions).toEqual(editionNames.slice(0, 10));
      expect([...sides.entityNames].sort()).toEqual([...names].sort());
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

describe('resolveEntities where a page is an edition', () => {
  it('joins the page to the entity it is an edition of, as a “same” verdict does', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
        runId,
      } = await seedDataset(db);
      await says(db, runId, a1!, 0, product('Maker A', 'DJ 300 PRO X', '04010118471063'));
      await says(db, runId, a2!, 0, product('Maker A', 'DJ 300 PRO X Club', '04010118471070'));
      const first = await resolve(db);
      const e1 = (await entityOf(db, a1!))!;
      expect(first.questions).toEqual([{ itemId: a2!.id, entityId: e1 }]);
      // Maker A has no other record, so the question has no lineup.
      expect(first.lineups).toEqual({});
      await judged(db, a2!, e1, 'edition');
      expect(await resolve(db)).toMatchObject({ created: 0, linked: 1, conflicts: 0, waiting: 0 });
      expect(await entityOf(db, a2!)).toBe(e1);
    }));
});

describe('resolveEntities’ lineups', () => {
  /** A page that gives only its name. */
  const named = (name: string) => [
    statementOf('brand', 'Maker A'),
    statementOf('name', name, 'jsonld'),
  ];

  it('hands each question the other records of the page’s brand, marking those a person kept apart', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      const [a1, a2, a3] = await makerAThree(db);
      // A1 gives a GTIN, so it is placed first. A2 starts a record of its own, and A3 is asked about
      // A2's.
      await says(db, runId, a1, 0, product('Maker A', 'HD 600', '04010118471087'));
      await says(db, runId, a2, 0, named('HD 660S'));
      await says(db, runId, a3, 0, named('HD 660SE'));
      const first = await resolve(db);
      const e660 = (await entityOf(db, a2))!;
      expect(first.questions).toEqual([{ itemId: a3.id, entityId: e660 }]);
      expect(first.lineups).toEqual({
        [`${a3.id}|${e660}`]: [{ name: 'HD 600', keptApart: false }],
      });

      // A person says the 600's page isn't the 660S's record, which keeps the two apart.
      await judged(db, a1, e660, 'not_same', 'person');
      expect((await resolve(db)).lineups).toEqual({
        [`${a3.id}|${e660}`]: [{ name: 'HD 600', keptApart: true }],
      });
    }));

  describe('where a site refuses AI input', () => {
    /** A newer fetch of the page, which saw its site say these things about AI. */
    const siteSays = (
      db: Executor,
      runId: string,
      item: ItemRef,
      minute: number,
      signals: Record<string, string>,
    ) =>
      recordFetch(db, {
        id: `fe_signals_${item.id}_${minute}`,
        runId,
        itemId: item.id,
        url: item.locator,
        finalUrl: item.locator,
        policy: 'allowed',
        policyReason: null,
        method: 'http',
        outcome: 'unchanged',
        httpStatus: 200,
        bytes: 100,
        signals,
        startedAt: T(minute),
        durationMs: 10,
        error: null,
      });

    it('leaves out a record whose page’s site refuses it, joined before or during the pass', () =>
      withRollback(async (db) => {
        const { runId } = await seedDataset(db);
        const [a1, a2, a3, a4] = await makerAFour(db);
        // A1 and A4 give the same GTIN, so they are one record. A2 starts another, and A3 is asked
        // about A2's.
        await says(db, runId, a1, 0, product('Maker A', 'HD 600', '04010118471087'));
        await says(db, runId, a4, 0, product('Maker A', 'HD 600 Silver', '04010118471087'));
        await says(db, runId, a2, 0, named('HD 660S'));
        await says(db, runId, a3, 0, named('HD 660SE'));
        // The record's name is in the lineup, as long as all its sites are willing.
        const open = await resolve(db);
        const e660 = (await entityOf(db, a2))!;
        expect(open.questions).toEqual([{ itemId: a3.id, entityId: e660 }]);
        expect(Object.values(open.lineups ?? {})).toEqual([[{ name: 'HD 600', keptApart: false }]]);

        // One of its pages' sites refuses. Both pages are joined to the record now.
        await siteSays(db, runId, a4, 5, { 'ai-input': 'no' });
        expect((await resolve(db)).lineups).toEqual({});
      }));

    it('leaves out a record that a page whose site refuses joins in the same pass', () =>
      withRollback(async (db) => {
        const { runId } = await seedDataset(db);
        const [a1, a2, a3, a4] = await makerAFour(db);
        await says(db, runId, a1, 0, product('Maker A', 'HD 600', '04010118471087'));
        await says(db, runId, a4, 0, product('Maker A', 'HD 600 Silver', '04010118471087'));
        await says(db, runId, a2, 0, named('HD 660S'));
        await says(db, runId, a3, 0, named('HD 660SE'));
        await siteSays(db, runId, a4, 5, { 'ai-input': 'no' });
        const first = await resolve(db);
        const e660 = (await entityOf(db, a2))!;
        // The question is still asked: whether to ask it is for the match step to decide, from the
        // sites of the pages it shows.
        expect(first.questions).toEqual([{ itemId: a3.id, entityId: e660 }]);
        expect(first.lineups).toEqual({});
      }));

    it('keeps a record whose site refused once but allows AI input in its latest fetch', () =>
      withRollback(async (db) => {
        const { runId } = await seedDataset(db);
        const [a1, a2, a3] = await makerAThree(db);
        await says(db, runId, a1, 0, product('Maker A', 'HD 600', '04010118471087'));
        await says(db, runId, a2, 0, named('HD 660S'));
        await says(db, runId, a3, 0, named('HD 660SE'));
        await siteSays(db, runId, a1, 3, { 'ai-input': 'no' });
        await siteSays(db, runId, a1, 4, { 'ai-input': 'yes' });
        const first = await resolve(db);
        expect(Object.values(first.lineups ?? {})).toEqual([
          [{ name: 'HD 600', keptApart: false }],
        ]);
      }));
  });
});

describe('entityMembers', () => {
  it('lists each joined live page with its record, its address, when it was met, and whether it joined as an edition', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
        runId,
      } = await seedDataset(db);
      await says(db, runId, a1!, 0, product('Maker A', 'DJ 300 PRO X', '04010118471063'));
      await says(db, runId, a2!, 0, product('Maker A', 'DJ 300 PRO X Club', '04010118471070'));
      await resolve(db);
      const e1 = (await entityOf(db, a1!))!;
      await judged(db, a2!, e1, 'edition', 'person');
      await resolve(db);
      // B1 says nothing, so it has no record and isn't listed.
      const rows = await entityMembers(db, 'test-products');
      expect(rows.map(({ firstSeen: _, ...row }) => row)).toEqual([
        { itemId: a1!.id, entityId: e1, url: a1!.locator, edition: false },
        { itemId: a2!.id, entityId: e1, url: a2!.locator, edition: true },
      ]);
      expect(rows.every((row) => row.firstSeen instanceof Date)).toBe(true);
    }));
});
