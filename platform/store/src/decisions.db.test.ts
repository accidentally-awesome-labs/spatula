import type { Question } from '@spatula/core';
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { seedDataset, T } from '../test/seed';
import type { Executor } from './client';
import {
  closeReview,
  dismissReviews,
  findDecision,
  finalizeDecision,
  getReview,
  joinedEntityOf,
  judge,
  judgementsFor,
  listOpenReviews,
  openReview,
  saveDecision,
  sameVerdictsOf,
  supersedeDecisions,
  type NewDecision,
} from './decisions';
import { datasets, decisionRecords, entities, items, judgements, reviewItems } from './schema';

const QUESTION: Question = {
  type: 'choice',
  prompt: 'Which category does the one product this page is about have?',
  options: ['Headphones', 'DAC/Amp', 'None of these'],
};

const decision = (overrides: Partial<NewDecision> = {}): NewDecision => ({
  id: 'dc_classifya100000000000',
  datasetId: 'test-products',
  type: 'classify',
  subject: 'it_a1',
  subjectKey: 'classify:it_a1',
  state: { title: 'A1 | Maker A' },
  stateHash: 'hash-1',
  question: QUESTION,
  criteriaVersion: 1,
  adapter: 'llm:test-model',
  probabilities: { Headphones: 0.97, 'DAC/Amp': 0.03 },
  evidence: 'It sits over the ears.',
  thresholds: { accept: 0.9 },
  outcome: 'accepted',
  answer: 'Headphones',
  inputTokens: 600,
  outputTokens: 40,
  decidedAt: T(1),
  ...overrides,
});

async function anEntity(tx: Executor, id: string) {
  await tx.insert(entities).values({ id, datasetId: 'test-products', recordType: 'product' });
  return id;
}

describe('decision records', () => {
  it('are found by what they were about, once, until superseded', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      const key = {
        datasetId: 'test-products',
        subjectKey: 'classify:it_a1',
        stateHash: 'hash-1',
        criteriaVersion: 1,
      };
      expect(await findDecision(tx, key)).toBeNull();
      const saved = await saveDecision(tx, decision());
      expect(saved).toMatchObject({
        id: 'dc_classifya100000000000',
        answer: 'Headphones',
        finalAnswer: null,
      });
      // A step that runs again saves the same record, and gets it back.
      expect((await saveDecision(tx, decision({ answer: 'DAC/Amp' }))).answer).toBe('Headphones');
      expect((await findDecision(tx, key))?.id).toBe(saved.id);
      expect(await findDecision(tx, { ...key, stateHash: 'hash-2' })).toBeNull();

      await finalizeDecision(tx, { id: saved.id, finalAnswer: 'DAC/Amp', at: T(2) });
      expect((await findDecision(tx, key))?.finalAnswer).toBe('DAC/Amp');
      await supersedeDecisions(tx, { datasetId: 'test-products', subjects: ['it_a1'], at: T(3) });
      expect(await findDecision(tx, key)).toBeNull();
      // A new question about the same subject can be recorded now.
      expect((await saveDecision(tx, decision({ id: 'dc_classifya100000000001' }))).id).toBe(
        'dc_classifya100000000001',
      );
      // A newer question about the subject retires the one before it.
      await saveDecision(
        tx,
        decision({ id: 'dc_classifya100000000002', stateHash: 'hash-2', decidedAt: T(4) }),
      );
      expect(await findDecision(tx, key)).toBeNull();
      expect((await findDecision(tx, { ...key, stateHash: 'hash-2' }))?.id).toBe(
        'dc_classifya100000000002',
      );
    }));

  it('give a step that runs again its own record, though a newer question has retired it', () =>
    withRollback(async (tx) => {
      await seedDataset(tx);
      const key = {
        datasetId: 'test-products',
        subjectKey: 'classify:it_a1',
        stateHash: 'hash-1',
        criteriaVersion: 1,
      };
      const first = await saveDecision(tx, decision());
      const second = await saveDecision(
        tx,
        decision({ id: 'dc_classifya100000000001', stateHash: 'hash-2', decidedAt: T(2) }),
      );
      expect(await findDecision(tx, key)).toBeNull();
      // The first run's step runs again after the newer question retired its record. It gets that
      // record back, unchanged, and the newer question stays the subject's current one.
      expect(await saveDecision(tx, decision({ answer: 'DAC/Amp' }))).toEqual(first);
      expect(await findDecision(tx, key)).toBeNull();
      expect((await findDecision(tx, { ...key, stateHash: 'hash-2' }))?.id).toBe(second.id);
    }));
});

describe('judgements', () => {
  it('keep a person’s verdict over any later one but a person’s', () =>
    withRollback(async (tx) => {
      const {
        items: [a1],
      } = await seedDataset(tx);
      const entityId = await anEntity(tx, 'sp_entityone000000000000');
      const verdict = (who: 'llm' | 'person', value: 'same' | 'not_same' | 'unsure', at: number) =>
        judge(tx, {
          datasetId: 'test-products',
          itemId: a1!.id,
          entityId,
          verdict: value,
          who,
          confidence: 0.9,
          decisionId: null,
          at: T(at),
        });
      await verdict('llm', 'unsure', 1);
      await verdict('llm', 'same', 2);
      expect(await judgementsFor(tx, 'test-products')).toMatchObject([
        { verdict: 'same', who: 'llm' },
      ]);
      await verdict('person', 'not_same', 3);
      await verdict('llm', 'same', 4);
      expect(await judgementsFor(tx, 'test-products')).toMatchObject([
        { verdict: 'not_same', who: 'person' },
      ]);
      await verdict('person', 'same', 5);
      expect(await judgementsFor(tx, 'test-products')).toMatchObject([
        { verdict: 'same', who: 'person' },
      ]);
    }));
});

describe('the entities a page was judged the same as', () => {
  it('are the ones with a “same” verdict about the page, and who gave it', () =>
    withRollback(async (tx) => {
      const {
        items: [a1, a2],
      } = await seedDataset(tx);
      const [one, two, three] = await Promise.all(
        ['sp_entityone000000000000', 'sp_entitytwo000000000000', 'sp_entitythree0000000000'].map(
          (id) => anEntity(tx, id),
        ),
      );
      const verdict = (
        itemId: string,
        entityId: string,
        value: 'same' | 'not_same' | 'unsure',
        who: 'llm' | 'person',
      ) =>
        judge(tx, {
          datasetId: 'test-products',
          itemId,
          entityId,
          verdict: value,
          who,
          confidence: 0.9,
          decisionId: null,
          at: T(1),
        });
      await verdict(a1!.id, three!, 'same', 'person');
      await verdict(a1!.id, one!, 'same', 'llm');
      await verdict(a1!.id, two!, 'not_same', 'llm');
      await verdict(a2!.id, two!, 'same', 'llm');
      expect(await sameVerdictsOf(tx, a1!.id)).toEqual([
        { entityId: one, who: 'llm' },
        { entityId: three, who: 'person' },
      ]);
      expect(await sameVerdictsOf(tx, a2!.id)).toEqual([{ entityId: two, who: 'llm' }]);
      expect(await sameVerdictsOf(tx, 'it_nobody00000000000')).toEqual([]);
    }));
});

describe('the entity a page is joined to', () => {
  it('is the one the page’s row names, and none before the page is joined', () =>
    withRollback(async (tx) => {
      const {
        items: [a1, a2],
      } = await seedDataset(tx);
      const [one, two] = await Promise.all(
        ['sp_entityone000000000000', 'sp_entitytwo000000000000'].map((id) => anEntity(tx, id)),
      );
      expect(await joinedEntityOf(tx, a1!.id)).toBeNull();
      await tx.update(items).set({ entityId: one }).where(eq(items.id, a1!.id));
      await tx.update(items).set({ entityId: two }).where(eq(items.id, a2!.id));
      expect(await joinedEntityOf(tx, a1!.id)).toBe(one);
      expect(await joinedEntityOf(tx, a2!.id)).toBe(two);
      // A verdict doesn't join a page; only the row does.
      await judge(tx, {
        datasetId: 'test-products',
        itemId: a1!.id,
        entityId: two!,
        verdict: 'same',
        who: 'person',
        confidence: 1,
        decisionId: null,
        at: T(1),
      });
      expect(await joinedEntityOf(tx, a1!.id)).toBe(one);
      expect(await joinedEntityOf(tx, 'it_nobody00000000000')).toBeNull();
    }));
});

describe('review items', () => {
  it('keep one open question per subject, and close once', () =>
    withRollback(async (tx) => {
      const {
        items: [a1],
      } = await seedDataset(tx);
      const saved = await saveDecision(tx, decision({ outcome: 'escalated', answer: null }));
      const open = (id: string, proposed: string) =>
        openReview(tx, {
          id,
          datasetId: 'test-products',
          kind: 'classify',
          subject: a1!.id,
          itemId: a1!.id,
          decisionId: saved.id,
          question: QUESTION,
          context: { url: a1!.locator, proposed },
          at: T(1),
        });
      const first = await open('rv_first00000000000000000', 'Headphones');
      // Asking again while it's open updates the open question rather than adding another.
      expect(await open('rv_second0000000000000000', 'DAC/Amp')).toBe(first);
      const listed = await listOpenReviews(tx, 'test-products');
      expect(listed).toEqual([
        {
          id: first,
          kind: 'classify',
          subject: a1!.id,
          question: QUESTION,
          context: { url: a1!.locator, proposed: 'DAC/Amp' },
          createdAt: T(1).toISOString(),
        },
      ]);
      expect(
        await closeReview(tx, { id: first, status: 'decided', answer: 'Headphones', at: T(2) }),
      ).toMatchObject({ status: 'decided', answer: 'Headphones' });
      expect(
        await closeReview(tx, { id: first, status: 'decided', answer: 'DAC/Amp', at: T(3) }),
      ).toBeNull();
      expect(await listOpenReviews(tx, 'test-products')).toEqual([]);
    }));

  it('are dismissed when their answer came another way', () =>
    withRollback(async (tx) => {
      const {
        items: [a1],
      } = await seedDataset(tx);
      await openReview(tx, {
        id: 'rv_dismissed0000000000000',
        datasetId: 'test-products',
        kind: 'classify',
        subject: a1!.id,
        itemId: a1!.id,
        question: QUESTION,
        context: {},
        at: T(1),
      });
      const dismiss = (kind: 'classify' | 'match') =>
        dismissReviews(tx, { datasetId: 'test-products', kind, subject: a1!.id, at: T(2) });
      expect(await dismiss('match')).toBe(0);
      expect(await dismiss('classify')).toBe(1);
      expect(await listOpenReviews(tx, 'test-products')).toEqual([]);
    }));

  it('are updated, not repeated, when a run asks again under the same ID', () =>
    withRollback(async (tx) => {
      const {
        items: [a1],
      } = await seedDataset(tx);
      const ask = (proposed: string) =>
        openReview(tx, {
          id: 'rv_stable0000000000000000',
          datasetId: 'test-products',
          kind: 'classify',
          subject: a1!.id,
          itemId: a1!.id,
          question: QUESTION,
          context: { proposed },
          at: T(1),
        });
      const first = await ask('Headphones');
      // A page still waiting is asked about on every run, under an ID made from its decision's.
      expect(await ask('DAC/Amp')).toBe(first);
      expect(await listOpenReviews(tx, 'test-products')).toMatchObject([
        { id: first, context: { proposed: 'DAC/Amp' } },
      ]);
    }));

  it('stay closed and unchanged when a step that runs again sends their ID', () =>
    withRollback(async (tx) => {
      const {
        items: [a1],
      } = await seedDataset(tx);
      const ask = (id: string, proposed: string) =>
        openReview(tx, {
          id,
          datasetId: 'test-products',
          kind: 'classify',
          subject: a1!.id,
          itemId: a1!.id,
          question: QUESTION,
          context: { proposed },
          at: T(1),
        });
      const id = await ask('rv_replayed0000000000000', 'Headphones');
      const closed = await closeReview(tx, {
        id,
        status: 'decided',
        answer: 'Headphones',
        at: T(2),
      });
      expect(closed).toMatchObject({ status: 'decided' });
      // The step that opened it runs again after the answer, and sends the ID of a closed review.
      expect(await ask(id, 'DAC/Amp')).toBe(id);
      expect(await getReview(tx, id)).toEqual(closed);
      expect(await listOpenReviews(tx, 'test-products')).toEqual([]);
    }));

  it('keep a newer question about the subject when an older step runs again', () =>
    withRollback(async (tx) => {
      const {
        items: [a1],
      } = await seedDataset(tx);
      const ask = (id: string, proposed: string) =>
        openReview(tx, {
          id,
          datasetId: 'test-products',
          kind: 'classify',
          subject: a1!.id,
          itemId: a1!.id,
          question: QUESTION,
          context: { proposed },
          at: T(1),
        });
      const older = await ask('rv_older00000000000000000', 'Headphones');
      await closeReview(tx, { id: older, status: 'dismissed', answer: null, at: T(2) });
      const newer = await ask('rv_newer00000000000000000', 'None of these');
      // The older step runs again, with what it knew then. That mustn't be written over the newer
      // question, which is the one a person is being asked.
      expect(await ask(older, 'Headphones')).toBe(older);
      expect(await getReview(tx, newer)).toMatchObject({
        status: 'open',
        context: { proposed: 'None of these' },
      });
      expect((await listOpenReviews(tx, 'test-products')).map((review) => review.id)).toEqual([
        newer,
      ]);
    }));

  it('can be asked again once closed, and are found by their ID', () =>
    withRollback(async (tx) => {
      const {
        items: [a1],
      } = await seedDataset(tx);
      const ask = (id: string) =>
        openReview(tx, {
          id,
          datasetId: 'test-products',
          kind: 'classify',
          subject: a1!.id,
          itemId: a1!.id,
          question: QUESTION,
          context: {},
          at: T(1),
        });
      const first = await ask('rv_first00000000000000000');
      expect(await getReview(tx, first)).toMatchObject({
        id: first,
        itemId: a1!.id,
        entityId: null,
        decisionId: null,
        status: 'open',
        answer: null,
        closedAt: null,
      });
      await closeReview(tx, { id: first, status: 'dismissed', answer: null, at: T(2) });
      expect(await getReview(tx, first)).toMatchObject({ status: 'dismissed', closedAt: T(2) });
      // A closed question no longer holds its subject's place.
      const second = await ask('rv_second0000000000000000');
      expect(second).toBe('rv_second0000000000000000');
      expect((await listOpenReviews(tx, 'test-products')).map((review) => review.id)).toEqual([
        second,
      ]);
      expect(await getReview(tx, 'rv_nosuchreview000000000')).toBeNull();
    }));
});

describe('deleting', () => {
  it('a decision keeps the verdicts and reviews that cite it', () =>
    withRollback(async (tx) => {
      const {
        items: [a1],
      } = await seedDataset(tx);
      const entityId = await anEntity(tx, 'sp_entityone000000000000');
      const saved = await saveDecision(tx, decision({ outcome: 'escalated', answer: null }));
      await judge(tx, {
        datasetId: 'test-products',
        itemId: a1!.id,
        entityId,
        verdict: 'unsure',
        who: 'llm',
        confidence: 0.5,
        decisionId: saved.id,
        at: T(1),
      });
      const review = await openReview(tx, {
        id: 'rv_cites0000000000000000',
        datasetId: 'test-products',
        kind: 'classify',
        subject: a1!.id,
        itemId: a1!.id,
        decisionId: saved.id,
        question: QUESTION,
        context: {},
        at: T(1),
      });
      await tx.delete(decisionRecords).where(eq(decisionRecords.id, saved.id));
      expect(await judgementsFor(tx, 'test-products')).toMatchObject([
        { verdict: 'unsure', decisionId: null },
      ]);
      expect(await getReview(tx, review)).toMatchObject({ status: 'open', decisionId: null });
    }));

  it('a page, an entity, or a dataset takes its verdicts and reviews with it', () =>
    withRollback(async (tx) => {
      const {
        items: [a1, a2],
      } = await seedDataset(tx);
      const entityId = await anEntity(tx, 'sp_entityone000000000000');
      const saved = await saveDecision(tx, decision());
      const ask = { datasetId: 'test-products', question: QUESTION, context: {}, at: T(1) };
      for (const item of [a1!, a2!]) {
        await judge(tx, {
          datasetId: 'test-products',
          itemId: item.id,
          entityId,
          verdict: 'same',
          who: 'llm',
          confidence: 0.9,
          decisionId: saved.id,
          at: T(1),
        });
        await openReview(tx, {
          ...ask,
          id: `rv_classify_${item.id}`,
          kind: 'classify',
          subject: item.id,
          itemId: item.id,
        });
      }
      await openReview(tx, {
        ...ask,
        id: 'rv_match0000000000000000',
        kind: 'match',
        subject: `${a2!.id}|${entityId}`,
        itemId: a2!.id,
        entityId,
      });
      const rows = async (table: typeof judgements | typeof reviewItems | typeof decisionRecords) =>
        (await tx.select({ n: count() }).from(table))[0]!.n;
      const left = async () => ({
        judgements: await rows(judgements),
        reviews: await rows(reviewItems),
        decisions: await rows(decisionRecords),
      });
      expect(await left()).toEqual({ judgements: 2, reviews: 3, decisions: 1 });

      await tx.delete(items).where(eq(items.id, a1!.id));
      expect(await left()).toEqual({ judgements: 1, reviews: 2, decisions: 1 });
      // The match review names the entity, so it goes; a2's classify review names only the page.
      await tx.delete(entities).where(eq(entities.id, entityId));
      expect(await left()).toEqual({ judgements: 0, reviews: 1, decisions: 1 });
      await tx.delete(datasets).where(eq(datasets.id, 'test-products'));
      expect(await left()).toEqual({ judgements: 0, reviews: 0, decisions: 0 });
    }));
});
