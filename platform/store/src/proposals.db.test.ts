import {
  applyChanges,
  changeSchema,
  changeText,
  emptyParts,
  finalAnswerText,
  findItem,
  flatProbabilities,
  newId,
  NONE_SHELF,
  noProbabilities,
  type ActorRecord,
  type ProposableChange,
  type TaxonomySubject,
} from '@spatula/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { fetchOf, statementOf, T } from '../test/seed';
import type { Executor } from './client';
import { applyDefinition, listLiveItems } from './datasets';
import { finalizeDecision, openReview, saveDecision, type NewDecision } from './decisions';
import { setItemStatus } from './fetches';
import { testTaxonomy, testTaxonomyDefinition } from './fixtures';
import {
  autonomyOf,
  decidedPages,
  decideProposal,
  getProposal,
  proposalsOfRun,
  revokeAutonomy,
  saveProposals,
  SCOPE_REFUSAL,
  seenChanges,
  shelvesEverHeld,
  specLabels,
  undoVersion,
  type NewProposal,
} from './proposals';
import { startRun } from './runs';
import { autonomy, fetches } from './schema';
import { writeStatements } from './statements';
import { commitTaxonomy, currentTaxonomy, seedTaxonomyVersion, taxonomyHistory } from './taxonomy';

const DATASET = 'test-taxonomy';
const RUN = 'test-taxonomy-202610100000';
const OWNER: ActorRecord = { role: 'owner', client: 'console' };
const REVIEWER: ActorRecord = {
  role: 'reviewer',
  client: 'consumer',
  consumer: 'crowdio',
  reviewer: 'r-7',
};
const DECIDER: ActorRecord = { role: 'decider', client: 'run' };
const TAXONOMY = testTaxonomy();
const id = (subject: TaxonomySubject, slug: string) => findItem(TAXONOMY, subject, slug)!.id;
const makeId = () => newId('tx');
const NONE_ANSWER = { shelf: NONE_SHELF, functions: [], values: [] };

const valueChange = (slug: string, name: string): ProposableChange =>
  changeSchema.parse({
    kind: 'add-value',
    feature: id('feature', 'drives'),
    slug,
    name,
    description: `Drives ${name}`,
  });
const LINE_OUT = changeSchema.parse({
  kind: 'add-value',
  feature: id('feature', 'drives'),
  slug: 'line-out',
  name: 'Line out',
  description: 'Feeds a line-level input',
});
const DESCRIBE_DACS = changeSchema.parse({
  kind: 'describe',
  subject: 'shelf',
  item: id('shelf', 'dacs'),
  description: 'Turn digital audio into an analog signal',
});
const PHONO = changeSchema.parse({
  kind: 'add-subcategory',
  parent: id('shelf', 'amplifiers'),
  slug: 'phono-stages',
  name: 'Phono stages',
  description: 'Raise and equalize a turntable cartridge’s signal',
  implies: [id('function', 'pre-amp')],
  scopeClause: 'amplifiers',
});

/** The test taxonomy dataset, seeded, with a run for proposals to come from. Its pages: A1, A2, B1. */
async function seeded(db: Executor) {
  await applyDefinition(db, testTaxonomyDefinition());
  await seedTaxonomyVersion(db, { datasetId: DATASET, taxonomy: TAXONOMY, actor: OWNER, at: T(0) });
  await startRun(db, { id: RUN, datasetId: DATASET });
  return listLiveItems(db, DATASET);
}

/** An open proposal of the run, checked against version 1. */
const proposal = (
  proposalId: string,
  change: ProposableChange,
  more: Partial<NewProposal> = {},
): NewProposal => ({
  id: proposalId,
  datasetId: DATASET,
  runId: RUN,
  kind: change.kind,
  change,
  changeText: changeText(change),
  summary: null,
  why: 'The run’s pages call for it',
  evidence: { pages: [] },
  impact: null,
  status: 'open',
  dropReason: null,
  base: 1,
  createdAt: T(1),
  ...more,
});

const accept = (db: Executor, proposalId: string, actor = OWNER) =>
  decideProposal(db, { id: proposalId, decision: 'accept', actor, makeId, at: T(2) });
const streakOf = async (db: Executor, kind: string) =>
  (await autonomyOf(db, DATASET)).find((row) => row.kind === kind)!.streak;

/** A taxonomy decision about a page, as a run saves one: its title in its state. */
const placed = (itemId: string, title: string, shelves: Record<string, number>): NewDecision => ({
  id: `dc_${itemId}`,
  datasetId: DATASET,
  type: 'taxonomy',
  subject: itemId,
  subjectKey: `taxonomy:${itemId}`,
  state: {
    page: { url: 'https://maker.example', title },
    rule: null,
    key: 'k',
    asked: emptyParts(),
  },
  stateHash: `hash-${itemId}`,
  question: { type: 'taxonomy', prompt: 'Where?', parts: emptyParts() },
  criteriaVersion: 1,
  adapter: 'llm:test-model',
  probabilities: flatProbabilities({ ...noProbabilities(), shelves }),
  evidence: 'The test’s reason',
  thresholds: { accept: 0.9 },
  outcome: 'accepted',
  answer: null,
  inputTokens: 600,
  outputTokens: 40,
  decidedAt: T(1),
});

describe('saving proposals', () => {
  it('saves a run’s proposals once, and holds an open, rejected, or applied change once', () =>
    withRollback(async (db) => {
      await seeded(db);
      const first = [proposal('tp_line_out', LINE_OUT), proposal('tp_describe', DESCRIBE_DACS)];
      expect(await saveProposals(db, first)).toBe(2);
      // A step that runs again saves nothing twice.
      expect(await saveProposals(db, first)).toBe(0);
      // The same change under another ID isn't held twice while the first is open. A dropped
      // proposal's is, since a dropped change was never one Spatula took.
      expect(await saveProposals(db, [proposal('tp_again', LINE_OUT)])).toBe(0);
      const dropped = proposal('tp_dropped', LINE_OUT, {
        status: 'dropped',
        dropReason: 'A test’s reason.',
      });
      expect(await saveProposals(db, [dropped])).toBe(1);
      expect((await proposalsOfRun(db, RUN)).map((row) => `${row.id} ${row.status}`)).toEqual([
        'tp_describe open',
        'tp_dropped dropped',
        'tp_line_out open',
      ]);
      expect(await seenChanges(db, DATASET)).toEqual(
        new Set([changeText(LINE_OUT), changeText(DESCRIBE_DACS)]),
      );
    }));
});

describe('deciding a proposal', () => {
  it('applies an accepted proposal as the next version, and counts it toward its kind', () =>
    withRollback(async (db) => {
      await seeded(db);
      await saveProposals(db, [proposal('tp_line_out', LINE_OUT)]);
      expect(await accept(db, 'tp_line_out')).toEqual({
        kind: 'applied',
        version: 2,
        summary: 'Add Line out to Drives',
      });
      const current = await currentTaxonomy(db, DATASET);
      expect(findItem(current!.taxonomy, 'value', 'line-out')).toMatchObject({
        name: 'Line out',
        retiredIn: null,
      });
      expect(await getProposal(db, 'tp_line_out')).toMatchObject({
        status: 'applied',
        version: 2,
        decidedBy: OWNER,
        edited: false,
        decidedAt: T(2),
      });
      expect((await taxonomyHistory(db, DATASET))[0]).toMatchObject({
        version: 2,
        actor: OWNER,
        autonomous: false,
        proposalId: 'tp_line_out',
      });
      expect(await streakOf(db, 'add-value')).toBe(1);
      // What's decided stays decided.
      expect(await accept(db, 'tp_line_out')).toEqual({
        kind: 'stale',
        reason: 'That proposal isn’t open: it’s applied.',
      });
    }));

  it('earns a kind its autonomy after ten unedited acceptances, which Spatula’s own don’t add to', () =>
    withRollback(async (db) => {
      await seeded(db);
      const changes = Array.from({ length: 11 }, (_, n) => valueChange(`value-${n}`, `Value ${n}`));
      await saveProposals(
        db,
        changes.map((change, n) => proposal(`tp_value_${n}`, change)),
      );
      for (let n = 0; n < 10; n += 1) await accept(db, `tp_value_${n}`);
      expect((await autonomyOf(db, DATASET)).find((row) => row.kind === 'add-value')).toMatchObject(
        { streak: 10, earned: true },
      );
      const own = await decideProposal(db, {
        id: 'tp_value_10',
        decision: 'accept',
        actor: DECIDER,
        autonomous: true,
        makeId,
        at: T(3),
      });
      expect(own).toMatchObject({ kind: 'applied', version: 12 });
      expect(await streakOf(db, 'add-value')).toBe(10);
      expect((await taxonomyHistory(db, DATASET))[0]).toMatchObject({
        version: 12,
        actor: DECIDER,
        autonomous: true,
      });
    }));

  it('sets a kind’s run to zero on an edit or a rejection, counting only those who may approve it', () =>
    withRollback(async (db) => {
      await seeded(db);
      await saveProposals(db, [
        proposal('tp_a', valueChange('a', 'A')),
        proposal('tp_b', valueChange('b', 'B')),
        proposal('tp_c', valueChange('c', 'C')),
        proposal('tp_d', valueChange('d', 'D')),
        proposal('tp_describe', DESCRIBE_DACS),
      ]);
      await accept(db, 'tp_a');
      expect(await streakOf(db, 'add-value')).toBe(1);
      const edited = await decideProposal(db, {
        id: 'tp_b',
        decision: 'edit',
        change: valueChange('balanced', 'Balanced'),
        actor: OWNER,
        note: 'A clearer name',
        makeId,
        at: T(3),
      });
      expect(edited).toEqual({ kind: 'applied', version: 3, summary: 'Add Balanced to Drives' });
      expect(await getProposal(db, 'tp_b')).toMatchObject({
        status: 'applied',
        edited: true,
        note: 'A clearer name',
      });
      expect(await streakOf(db, 'add-value')).toBe(0);
      // A consumer's reviewer may approve an additive kind, and the approval counts.
      await accept(db, 'tp_c', REVIEWER);
      expect(await streakOf(db, 'add-value')).toBe(1);
      // A reviewer's word on a description doesn't count: the owner approves those.
      await accept(db, 'tp_describe', REVIEWER);
      expect(await getProposal(db, 'tp_describe')).toMatchObject({ status: 'applied' });
      expect(await streakOf(db, 'add-value')).toBe(1);
      expect(
        await decideProposal(db, {
          id: 'tp_d',
          decision: 'reject',
          actor: OWNER,
          note: 'Not a drive',
          makeId,
          at: T(4),
        }),
      ).toEqual({ kind: 'rejected' });
      expect(await getProposal(db, 'tp_d')).toMatchObject({
        status: 'rejected',
        decidedBy: OWNER,
        note: 'Not a drive',
        version: null,
      });
      expect(await streakOf(db, 'add-value')).toBe(0);
    }));

  it('never counts a description toward any run, whoever approves it, edits it, or rejects it', () =>
    withRollback(async (db) => {
      await seeded(db);
      const shelfDescription = (item: string, description: string) =>
        changeSchema.parse({
          kind: 'describe',
          subject: 'shelf',
          item: id('shelf', item),
          description,
        });
      await saveProposals(db, [
        proposal('tp_accepted', DESCRIBE_DACS),
        proposal('tp_edited', shelfDescription('amplifiers', 'Raise a signal’s level')),
        proposal('tp_rejected', shelfDescription('over-ear', 'Cups that sit around the ear')),
        proposal('tp_function', {
          kind: 'describe',
          subject: 'function',
          item: id('function', 'pre-amp'),
          description: 'Raises a line-level signal',
        }),
      ]);
      // A run for add-value, to see that the others leave it alone.
      await saveProposals(db, [proposal('tp_value', valueChange('balanced', 'Balanced'))]);
      await accept(db, 'tp_value');
      expect(await accept(db, 'tp_accepted')).toMatchObject({ kind: 'applied' });
      expect(await accept(db, 'tp_function')).toMatchObject({ kind: 'applied' });
      expect(
        await decideProposal(db, {
          id: 'tp_edited',
          decision: 'edit',
          change: shelfDescription('amplifiers', 'Raise a signal'),
          actor: OWNER,
          makeId,
          at: T(3),
        }),
      ).toMatchObject({ kind: 'applied' });
      expect(
        await decideProposal(db, {
          id: 'tp_rejected',
          decision: 'reject',
          actor: OWNER,
          makeId,
          at: T(4),
        }),
      ).toEqual({ kind: 'rejected' });
      // Four decisions on descriptions: no run for describe, and add-value's is as it was.
      expect(await db.select().from(autonomy).where(eq(autonomy.kind, 'describe'))).toEqual([]);
      expect((await autonomyOf(db, DATASET)).map(({ kind, streak }) => [kind, streak])).toEqual([
        ['add-subcategory', 0],
        ['add-feature', 0],
        ['add-value', 1],
      ]);
    }));

  it('applies a proposal on the version that’s current, and leaves one that no longer applies open', () =>
    withRollback(async (db) => {
      await seeded(db);
      const twin = changeSchema.parse({ ...LINE_OUT, name: 'Line output' });
      await saveProposals(db, [
        proposal('tp_describe', DESCRIBE_DACS),
        proposal('tp_phono', PHONO),
        proposal('tp_line_out', LINE_OUT),
        proposal('tp_twin', twin),
      ]);
      await accept(db, 'tp_describe');
      // Checked against version 1, applied on version 2.
      expect(await accept(db, 'tp_phono')).toEqual({
        kind: 'applied',
        version: 3,
        summary: 'Add Phono stages under Amplifiers',
      });
      await accept(db, 'tp_line_out');
      expect(await accept(db, 'tp_twin')).toEqual({
        kind: 'stale',
        reason:
          'It doesn’t apply to version 4: features.1.values.4.slug: Another value is also called line-out.',
      });
      expect(await getProposal(db, 'tp_twin')).toMatchObject({ status: 'open', version: null });
    }));
});

describe('a dataset that was never seeded', () => {
  it('leaves a proposal open and says so, and commits no version around the seed', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testTaxonomyDefinition());
      await startRun(db, { id: RUN, datasetId: DATASET });
      await saveProposals(db, [proposal('tp_line_out', LINE_OUT)]);
      expect(await accept(db, 'tp_line_out')).toEqual({
        kind: 'stale',
        reason: 'The dataset has no taxonomy.',
      });
      expect(await getProposal(db, 'tp_line_out')).toMatchObject({ status: 'open', version: null });
      expect(await currentTaxonomy(db, DATASET)).toBeNull();
    }));
});

describe('autonomy', () => {
  it('lists every kind that can earn it, never a description, and revokes one back to zero', () =>
    withRollback(async (db) => {
      await seeded(db);
      await db
        .insert(autonomy)
        .values({ datasetId: DATASET, kind: 'add-value', streak: 12, updatedAt: T(1) });
      expect(await autonomyOf(db, DATASET)).toEqual([
        { kind: 'add-subcategory', streak: 0, earned: false, updatedAt: null },
        { kind: 'add-feature', streak: 0, earned: false, updatedAt: null },
        { kind: 'add-value', streak: 12, earned: true, updatedAt: T(1) },
      ]);
      expect(await revokeAutonomy(db, { datasetId: DATASET, kind: 'add-value', at: T(2) })).toBe(
        12,
      );
      expect((await autonomyOf(db, DATASET))[2]).toEqual({
        kind: 'add-value',
        streak: 0,
        earned: false,
        updatedAt: T(2),
      });
    }));

  it('keeps no run for a description: the table’s CHECK refuses one', () =>
    withRollback(async (db) => {
      await seeded(db);
      await expect(
        db
          .insert(autonomy)
          .values({ datasetId: DATASET, kind: 'describe', streak: 1, updatedAt: T(1) }),
      ).rejects.toMatchObject({ cause: { constraint_name: 'autonomy_kind' } });
    }));

  it('applies on its own only an unedited change whose kind has autonomy as it applies', () =>
    withRollback(async (db) => {
      await seeded(db);
      await db
        .insert(autonomy)
        .values({ datasetId: DATASET, kind: 'add-value', streak: 10, updatedAt: T(1) });
      const describeFunction = changeSchema.parse({
        kind: 'describe',
        subject: 'function',
        item: id('function', 'pre-amp'),
        description: 'Raises a line-level signal',
      });
      await saveProposals(db, [
        proposal('tp_line_out', LINE_OUT),
        proposal('tp_describe_function', describeFunction),
        proposal('tp_describe_shelf', DESCRIBE_DACS),
      ]);
      const own = (proposalId: string, more: { decision?: 'edit'; change?: ProposableChange }) =>
        decideProposal(db, {
          id: proposalId,
          decision: 'accept',
          actor: DECIDER,
          autonomous: true,
          makeId,
          at: T(3),
          ...more,
        });
      // The review read add-value as earned. The owner revokes it before Spatula applies the change.
      await revokeAutonomy(db, { datasetId: DATASET, kind: 'add-value', at: T(2) });
      expect(await own('tp_line_out', {})).toEqual({
        kind: 'stale',
        reason: 'Its kind, add-value, doesn’t have autonomy now.',
      });
      // A description is the owner's, of a function or of anything else: its text would reach
      // later prompts as trusted text, so no kind of it has autonomy to earn.
      for (const proposalId of ['tp_describe_function', 'tp_describe_shelf']) {
        expect(await own(proposalId, {})).toEqual({
          kind: 'stale',
          reason: 'Its kind is always the owner’s to apply.',
        });
      }
      // Spatula applies a change only as it was proposed.
      await db.update(autonomy).set({ streak: 10 }).where(eq(autonomy.kind, 'add-value'));
      expect(
        await own('tp_line_out', { decision: 'edit', change: valueChange('line-in', 'Line in') }),
      ).toEqual({
        kind: 'stale',
        reason: 'Spatula applies a change on its own only as it was proposed.',
      });
      for (const proposalId of ['tp_line_out', 'tp_describe_function', 'tp_describe_shelf']) {
        expect(await getProposal(db, proposalId)).toMatchObject({
          status: 'open',
          version: null,
          decidedBy: null,
        });
      }
      expect((await currentTaxonomy(db, DATASET))!.version).toBe(1);
      // With its autonomy back, the same call applies it.
      expect(await own('tp_line_out', {})).toMatchObject({ kind: 'applied', version: 2 });
    }));
});

describe('what the review reads', () => {
  it('gathers each page’s decision, shelf, answer, question, and consent, its labels, and the shelves ever held', () =>
    withRollback(async (db) => {
      const [a1, a2, b1] = await seeded(db);
      const overEar = id('shelf', 'over-ear');
      const onEar = id('shelf', 'on-ear');
      const read = {
        a1: await fetchOf(db, RUN, a1!, T(1)),
        a2: await fetchOf(db, RUN, a2!, T(1)),
        b1: await fetchOf(db, RUN, b1!, T(1)),
      };
      // B1's site says ai-input=no.
      await db
        .update(fetches)
        .set({ signals: { 'ai-input': 'no' } })
        .where(eq(fetches.id, read.b1));

      // A1: on Over-ear, by the decider, with a spec.
      await saveDecision(db, placed(a1!.id, 'A1 | Maker A', { [overEar]: 0.96 }));
      await writeStatements(db, {
        datasetId: DATASET,
        itemId: a1!.id,
        fetchId: read.a1,
        seenAt: T(1),
        methods: ['llm'],
        statements: [
          statementOf('shelf', overEar, 'llm'),
          statementOf('specs', { label: 'Impedance', value: '300 Ω' }, 'llm'),
        ],
      });

      // A2: on On-ear once, then taken out by a person, against the decider's On-ear.
      const a2Decision = await saveDecision(db, placed(a2!.id, 'A2 | Maker A', { [onEar]: 0.7 }));
      await finalizeDecision(db, {
        id: a2Decision.id,
        finalAnswer: finalAnswerText({
          answer: NONE_ANSWER,
          asked: { shelves: [onEar, NONE_SHELF], functions: [], features: {} },
          given: NONE_ANSWER,
        }),
        at: T(2),
      });
      const shelfWrite = { datasetId: DATASET, itemId: a2!.id, fetchId: read.a2 };
      await writeStatements(db, {
        ...shelfWrite,
        seenAt: T(1),
        methods: ['llm'],
        properties: ['shelf'],
        statements: [statementOf('shelf', onEar, 'llm')],
      });
      await writeStatements(db, {
        ...shelfWrite,
        seenAt: T(2),
        methods: ['llm'],
        properties: ['shelf'],
        statements: [],
      });
      await setItemStatus(db, a2!.id, 'irrelevant');

      // B1: no decision yet, and a question about its shelf.
      const parts = {
        shelves: [id('shelf', 'headphone-amps'), id('shelf', 'power-amps')],
        functions: [],
        features: {},
      };
      await openReview(db, {
        id: 'rv_b1',
        datasetId: DATASET,
        kind: 'classify',
        subject: b1!.id,
        itemId: b1!.id,
        question: { type: 'taxonomy', prompt: 'Where?', parts },
        context: {},
        at: T(2),
      });

      expect(await decidedPages(db, DATASET)).toMatchObject([
        {
          itemId: a1!.id,
          address: a1!.locator,
          status: 'live',
          title: 'A1 | Maker A',
          shelves: [{ property: 'shelf', value: overEar, method: 'llm' }],
          probabilities: { [overEar]: 0.96 },
          tokens: 640,
          answered: null,
          open: null,
          aiInput: true,
        },
        {
          itemId: a2!.id,
          address: a2!.locator,
          status: 'irrelevant',
          title: 'A2 | Maker A',
          shelves: [],
          probabilities: { [onEar]: 0.7 },
          tokens: 640,
          answered: { final: { answer: NONE_ANSWER }, probabilities: { [onEar]: 0.7 } },
          open: null,
          aiInput: true,
        },
        {
          itemId: b1!.id,
          address: b1!.locator,
          status: 'live',
          title: null,
          shelves: [],
          probabilities: {},
          tokens: 0,
          answered: null,
          open: parts,
          aiInput: false,
        },
      ]);
      expect(await specLabels(db, DATASET)).toEqual(new Map([[a1!.id, ['impedance']]]));
      expect(await shelvesEverHeld(db, DATASET)).toEqual([overEar, onEar].sort());
    }));
});

describe('undoing a version', () => {
  it('undoes a version as a new one, and takes autonomy from a kind Spatula applied it as', () =>
    withRollback(async (db) => {
      await seeded(db);
      await db
        .insert(autonomy)
        .values({ datasetId: DATASET, kind: 'add-value', streak: 10, updatedAt: T(1) });
      await saveProposals(db, [
        proposal('tp_line_out', LINE_OUT),
        proposal('tp_describe', DESCRIBE_DACS),
      ]);
      await decideProposal(db, {
        id: 'tp_line_out',
        decision: 'accept',
        actor: DECIDER,
        autonomous: true,
        makeId,
        at: T(2),
      });
      await accept(db, 'tp_describe');
      const undo = (version: number) =>
        undoVersion(db, { datasetId: DATASET, version, actor: OWNER, makeId, at: T(3) });

      expect(await undo(2)).toEqual({
        kind: 'undone',
        version: 4,
        summary: 'Retire Line out',
        revoked: 'add-value',
      });
      const current = (await currentTaxonomy(db, DATASET))!.taxonomy;
      expect(findItem(current, 'value', 'line-out')!.retiredIn).toBe(4);
      // Version 3 stands: undoing 2 took back 2's change alone.
      expect(findItem(current, 'shelf', 'dacs')!.description).toBe(
        'Turn digital audio into an analog signal',
      );
      expect((await taxonomyHistory(db, DATASET))[0]).toMatchObject({
        version: 4,
        actor: OWNER,
        autonomous: false,
        undoes: 2,
      });
      expect(await streakOf(db, 'add-value')).toBe(0);

      // Undoing the owner's own change takes no autonomy away.
      expect(await undo(3)).toEqual({
        kind: 'undone',
        version: 5,
        summary: 'Describe DACs anew',
        revoked: null,
      });
      // A version is undone once. Undoing a description again would apply, as core doesn't stop
      // it, so the store does.
      expect(await undo(3)).toEqual({
        kind: 'refused',
        reason: 'Version 3 was undone already, by version 5.',
      });
      expect(await undo(2)).toEqual({
        kind: 'refused',
        reason: 'Version 2 was undone already, by version 4.',
      });
      expect(await undo(1)).toEqual({
        kind: 'refused',
        reason: 'Version 1 is the seed: there’s nothing before it to go back to.',
      });
      expect(await undo(9)).toEqual({ kind: 'missing' });
      // The refusals commit nothing.
      expect((await currentTaxonomy(db, DATASET))!.version).toBe(5);
    }));

  it('leaves the scope to the definition: no edit into a scope change, and no undo of one', () =>
    withRollback(async (db) => {
      await seeded(db);
      await saveProposals(db, [proposal('tp_describe', DESCRIBE_DACS)]);
      const narrower = 'Hi-fi made for audio: headphones and DACs. Out of scope: amplifiers.';
      const scope = changeSchema.parse({ kind: 'scope', scope: narrower });
      expect(
        await decideProposal(db, {
          id: 'tp_describe',
          decision: 'edit',
          change: scope,
          actor: OWNER,
          makeId,
          at: T(2),
        }),
      ).toEqual({ kind: 'stale', reason: SCOPE_REFUSAL });
      expect((await currentTaxonomy(db, DATASET))!.version).toBe(1);

      // A definition with a new scope makes a version with it, which isn't undone.
      const seed = (await currentTaxonomy(db, DATASET))!;
      const rescoped = applyChanges(seed.taxonomy, [scope], makeId);
      if (!rescoped.ok) throw new Error(rescoped.issues.join(' '));
      await commitTaxonomy(db, {
        datasetId: DATASET,
        base: 1,
        taxonomy: rescoped.taxonomy,
        changes: rescoped.applied,
        actor: OWNER,
        at: T(3),
      });
      expect(
        await undoVersion(db, { datasetId: DATASET, version: 2, actor: OWNER, makeId, at: T(4) }),
      ).toEqual({
        kind: 'refused',
        reason:
          'Version 2 changed the scope, which comes from the dataset’s definition: change it there, and apply the definition.',
      });
      expect((await currentTaxonomy(db, DATASET))!.taxonomy.scope).toBe(narrower);
    }));

  it('undoes a batch with the inverses in reverse order', () =>
    withRollback(async (db) => {
      await seeded(db);
      const seed = (await currentTaxonomy(db, DATASET))!;
      // A function and the change that makes a shelf imply it: undone in the order they were
      // applied, the function would be retired while the shelf still implies it.
      const batch = applyChanges(
        seed.taxonomy,
        [
          {
            kind: 'add-function',
            slug: 'streamer',
            name: 'Streamer',
            description: 'Plays a stream',
          },
          { kind: 'implies', shelf: 'dacs', implies: ['dac', 'streamer'] },
        ],
        makeId,
      );
      if (!batch.ok) throw new Error(batch.issues.join(' '));
      await commitTaxonomy(db, {
        datasetId: DATASET,
        base: 1,
        taxonomy: batch.taxonomy,
        changes: batch.applied,
        actor: OWNER,
        at: T(2),
      });

      const undone = await undoVersion(db, {
        datasetId: DATASET,
        version: 2,
        actor: OWNER,
        makeId,
        at: T(3),
      });
      expect(undone).toEqual({
        kind: 'undone',
        version: 3,
        summary: 'Change what DACs implies; Retire Streamer',
        revoked: null,
      });
      const current = (await currentTaxonomy(db, DATASET))!.taxonomy;
      expect(findItem(current, 'function', 'streamer')!.retiredIn).toBe(3);
      expect(current.shelves.find((shelf) => shelf.slug === 'dacs')!.implies).toEqual([
        id('function', 'dac'),
      ]);
    }));
});
