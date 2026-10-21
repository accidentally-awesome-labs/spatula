import {
  applyChanges,
  AUTONOMY_AFTER,
  autonomyKind,
  changeSchema,
  EARNABLE_KINDS,
  mayApprove,
  readFinalAnswer,
  sha256Hex,
  specLabelKey,
  splitProbabilities,
  type ActorRecord,
  type ChangeKind,
  type EvidencePage,
  type ProposableChange,
  type ProposalEvidence,
  type ProposalImpact,
  type StatementView,
  type TaxonomyParts,
} from '@spatula/core';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Executor } from './client';
import {
  autonomy,
  decisionRecords,
  fetches,
  items,
  reviewItems,
  statements,
  taxonomyProposals,
  type ProposalStatus,
} from './schema';
import { lockDataset } from './snapshots';
import { commitTaxonomy, currentTaxonomy } from './taxonomy';

/*
 * The taxonomy review's proposals and each kind's autonomy (ADR 0007). A proposal is decided once:
 * accepted as it is, edited, or rejected. Accepting applies it at once, as the next taxonomy
 * version, on whatever version is current then. An unedited acceptance from someone allowed to
 * approve the kind adds one to the kind's run; an edit or a rejection from them sets it to zero;
 * and Spatula's own applications don't count. Each write here takes the dataset's row first, as
 * committing a version does, so decisions about one dataset go one at a time.
 */

export interface NewProposal {
  id: string;
  datasetId: string;
  runId: string | null;
  kind: string;
  change: unknown;
  changeText: string;
  summary: string | null;
  why: string;
  evidence: ProposalEvidence;
  impact: ProposalImpact | null;
  status: 'open' | 'dropped';
  dropReason: string | null;
  base: number;
  createdAt: Date;
}

export interface ProposalRow extends Omit<NewProposal, 'status'> {
  status: ProposalStatus;
  version: number | null;
  decidedBy: ActorRecord | null;
  edited: boolean;
  note: string | null;
  decidedAt: Date | null;
}

export interface AutonomyRow {
  kind: ChangeKind;
  /** Unedited acceptances in a row, from someone allowed to approve the kind. */
  streak: number;
  /** Whether the kind applies on its own. */
  earned: boolean;
  updatedAt: Date | null;
}

/** A page as the review reads it, with its item, and whether its site allows AI input. */
export type DecidedPage = Omit<EvidencePage, 'labels'> & { itemId: string; aiInput: boolean };

const PROPOSAL = {
  id: taxonomyProposals.id,
  datasetId: taxonomyProposals.datasetId,
  runId: taxonomyProposals.runId,
  kind: taxonomyProposals.kind,
  change: taxonomyProposals.change,
  changeText: taxonomyProposals.changeText,
  summary: taxonomyProposals.summary,
  why: taxonomyProposals.why,
  evidence: taxonomyProposals.evidence,
  impact: taxonomyProposals.impact,
  status: taxonomyProposals.status,
  dropReason: taxonomyProposals.dropReason,
  base: taxonomyProposals.base,
  version: taxonomyProposals.version,
  decidedBy: taxonomyProposals.decidedBy,
  edited: taxonomyProposals.edited,
  note: taxonomyProposals.note,
  createdAt: taxonomyProposals.createdAt,
  decidedAt: taxonomyProposals.decidedAt,
};

/** The most proposals a list returns, newest first. */
const LISTED_MAX = 500;
/** The proposals whose change isn't proposed again (ruling 17). */
const SEEN_STATUSES: ProposalStatus[] = ['open', 'rejected', 'applied'];

/**
 * Saves a review's proposals, and says how many it inserted. A step that runs again sends the same
 * IDs, and an open, rejected, or applied change is held once: either way the row is skipped.
 */
export async function saveProposals(
  db: Executor,
  proposals: readonly NewProposal[],
): Promise<number> {
  if (proposals.length === 0) return 0;
  const rows = await Promise.all(
    proposals.map(async (proposal) => ({
      ...proposal,
      changeHash: await sha256Hex(proposal.changeText),
    })),
  );
  const inserted = await db
    .insert(taxonomyProposals)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: taxonomyProposals.id });
  return inserted.length;
}

/** A run's proposals, kept and dropped, in an order that never changes. */
export async function proposalsOfRun(db: Executor, runId: string): Promise<ProposalRow[]> {
  return db
    .select(PROPOSAL)
    .from(taxonomyProposals)
    .where(eq(taxonomyProposals.runId, runId))
    .orderBy(asc(taxonomyProposals.createdAt), asc(taxonomyProposals.id));
}

/** A dataset's proposals, newest first: all of them, or those with one status. */
export async function listProposals(
  db: Executor,
  datasetId: string,
  filter: { status?: ProposalStatus } = {},
): Promise<ProposalRow[]> {
  return db
    .select(PROPOSAL)
    .from(taxonomyProposals)
    .where(
      and(
        eq(taxonomyProposals.datasetId, datasetId),
        filter.status === undefined ? undefined : eq(taxonomyProposals.status, filter.status),
      ),
    )
    .orderBy(desc(taxonomyProposals.createdAt), asc(taxonomyProposals.id))
    .limit(LISTED_MAX);
}

export async function getProposal(db: Executor, id: string): Promise<ProposalRow | null> {
  const [row] = await db
    .select(PROPOSAL)
    .from(taxonomyProposals)
    .where(eq(taxonomyProposals.id, id));
  return row ?? null;
}

/** The changes, as changeText writes them, that a review mustn't propose again. */
export async function seenChanges(db: Executor, datasetId: string): Promise<Set<string>> {
  const rows = await db
    .select({ text: taxonomyProposals.changeText })
    .from(taxonomyProposals)
    .where(
      and(
        eq(taxonomyProposals.datasetId, datasetId),
        inArray(taxonomyProposals.status, SEEN_STATUSES),
      ),
    );
  return new Set(rows.map((row) => row.text));
}

/**
 * Decides an open proposal. A rejection closes it. An acceptance, or an edit with the change it
 * makes instead, applies on the current version as the next one: the proposal was checked against
 * its base, which may be older by now. A change that no longer applies leaves the proposal open, and
 * says why. The kind's run moves only for someone allowed to approve the kind, and never for
 * Spatula's own application. The caller logs the decision in the same transaction.
 */
export async function decideProposal(
  db: Executor,
  input: {
    id: string;
    decision: 'accept' | 'edit' | 'reject';
    /** An edit's change, applied in the proposal's place. */
    change?: ProposableChange;
    actor: ActorRecord;
    /** Whether Spatula applies it on its own, with its kind's earned autonomy. */
    autonomous?: boolean;
    note?: string | null;
    makeId: () => string;
    at: Date;
  },
): Promise<
  | { kind: 'applied'; version: number; summary: string }
  | { kind: 'rejected' }
  | { kind: 'stale'; reason: string; moved?: true }
> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ datasetId: taxonomyProposals.datasetId })
      .from(taxonomyProposals)
      .where(eq(taxonomyProposals.id, input.id));
    if (found === undefined) return { kind: 'stale' as const, reason: 'There’s no such proposal.' };
    const { datasetId } = found;
    // The dataset's row first, as every taxonomy write takes it, then the proposal's.
    await lockDataset(tx, datasetId);
    const [proposal] = await tx
      .select(PROPOSAL)
      .from(taxonomyProposals)
      .where(eq(taxonomyProposals.id, input.id))
      .for('update');
    if (proposal === undefined) {
      return { kind: 'stale' as const, reason: 'There’s no such proposal.' };
    }
    if (proposal.status !== 'open') {
      return {
        kind: 'stale' as const,
        reason: `That proposal isn’t open: it’s ${proposal.status}.`,
      };
    }
    const proposed = changeSchema.safeParse(proposal.change);
    if (!proposed.success) {
      return { kind: 'stale' as const, reason: 'Its change no longer reads as one Spatula takes.' };
    }
    const earnable = autonomyKind(proposed.data);
    const counted: ChangeKind | null =
      earnable !== null && input.autonomous !== true && mayApprove(input.actor.role, earnable)
        ? earnable
        : null;
    const decided = { decidedBy: input.actor, note: input.note ?? null, decidedAt: input.at };

    if (input.decision === 'reject') {
      await tx
        .update(taxonomyProposals)
        .set({ status: 'rejected', ...decided })
        .where(eq(taxonomyProposals.id, input.id));
      if (counted !== null) await setStreak(tx, datasetId, counted, 0, input.at);
      return { kind: 'rejected' as const };
    }
    const change = input.decision === 'edit' ? input.change : proposed.data;
    if (change === undefined) throw new Error('An edit needs the change it makes');
    const current = await currentTaxonomy(tx, datasetId);
    if (current === null) return { kind: 'stale' as const, reason: 'The dataset has no taxonomy.' };
    const applied = applyChanges(current.taxonomy, [change], input.makeId);
    if (!applied.ok) {
      return {
        kind: 'stale' as const,
        reason: `It doesn’t apply to version ${current.version}: ${applied.issues.join(' ')}`,
      };
    }
    const committed = await commitTaxonomy(tx, {
      datasetId,
      base: current.version,
      taxonomy: applied.taxonomy,
      changes: applied.applied,
      actor: input.actor,
      autonomous: input.autonomous === true,
      proposalId: input.id,
      at: input.at,
    });
    if (!committed.committed) {
      return {
        kind: 'stale' as const,
        reason: `Version ${committed.version} came first.`,
        moved: true as const,
      };
    }
    await tx
      .update(taxonomyProposals)
      .set({
        status: 'applied',
        version: committed.version,
        edited: input.decision === 'edit',
        ...decided,
      })
      .where(eq(taxonomyProposals.id, input.id));
    if (counted !== null) {
      const streak = input.decision === 'edit' ? 0 : (await streakOf(tx, datasetId, counted)) + 1;
      await setStreak(tx, datasetId, counted, streak, input.at);
    }
    return {
      kind: 'applied' as const,
      version: committed.version,
      summary: applied.applied.map((entry) => entry.summary).join('; '),
    };
  });
}

/** Every kind that can earn autonomy, with its run: zero for a kind never approved. */
export async function autonomyOf(db: Executor, datasetId: string): Promise<AutonomyRow[]> {
  const rows = await db.select().from(autonomy).where(eq(autonomy.datasetId, datasetId));
  return EARNABLE_KINDS.map((kind): AutonomyRow => {
    const row = rows.find((entry) => entry.kind === kind);
    const streak = row?.streak ?? 0;
    return { kind, streak, earned: streak >= AUTONOMY_AFTER, updatedAt: row?.updatedAt ?? null };
  });
}

/** Sets a kind's run to zero, and returns the run it had. */
export async function revokeAutonomy(
  db: Executor,
  input: { datasetId: string; kind: ChangeKind; at: Date },
): Promise<number> {
  return db.transaction(async (tx) => {
    await lockDataset(tx, input.datasetId);
    const was = await streakOf(tx, input.datasetId, input.kind);
    await setStreak(tx, input.datasetId, input.kind, 0, input.at);
    return was;
  });
}

/** A kind's run. Every writer holds the dataset's row, so reading and then writing is safe. */
async function streakOf(db: Executor, datasetId: string, kind: ChangeKind): Promise<number> {
  const [row] = await db
    .select({ streak: autonomy.streak })
    .from(autonomy)
    .where(and(eq(autonomy.datasetId, datasetId), eq(autonomy.kind, kind)));
  return row?.streak ?? 0;
}

async function setStreak(
  db: Executor,
  datasetId: string,
  kind: ChangeKind,
  streak: number,
  at: Date,
): Promise<void> {
  await db
    .insert(autonomy)
    .values({ datasetId, kind, streak, updatedAt: at })
    .onConflictDoUpdate({
      target: [autonomy.datasetId, autonomy.kind],
      set: { streak, updatedAt: at },
    });
}

/**
 * What the review reads of each live or irrelevant page, by source and address: its current place
 * decision (its title, its shelves' probabilities, and what it cost), its current shelf statements,
 * what a person last said of it and what the decider had proposed then, its open taxonomy
 * question, and whether its site allowed AI input when it was last read. A page never read, or
 * last read before sites' signals were kept, counts as not allowing it.
 */
export async function decidedPages(db: Executor, datasetId: string): Promise<DecidedPage[]> {
  const pages = await db
    .select({ id: items.id, locator: items.locator, status: items.status })
    .from(items)
    .where(and(eq(items.datasetId, datasetId), inArray(items.status, ['live', 'irrelevant'])))
    .orderBy(asc(items.sourceId), asc(items.locator));
  if (pages.length === 0) return [];
  const decisions = await db
    .select({
      subject: decisionRecords.subject,
      state: decisionRecords.state,
      probabilities: decisionRecords.probabilities,
      inputTokens: decisionRecords.inputTokens,
      outputTokens: decisionRecords.outputTokens,
    })
    .from(decisionRecords)
    .where(
      and(
        eq(decisionRecords.datasetId, datasetId),
        eq(decisionRecords.type, 'taxonomy'),
        isNull(decisionRecords.supersededAt),
      ),
    );
  const finals = await db
    .selectDistinctOn([decisionRecords.subject], {
      subject: decisionRecords.subject,
      finalAnswer: decisionRecords.finalAnswer,
      probabilities: decisionRecords.probabilities,
    })
    .from(decisionRecords)
    .where(and(eq(decisionRecords.datasetId, datasetId), isNotNull(decisionRecords.finalizedAt)))
    .orderBy(decisionRecords.subject, desc(decisionRecords.finalizedAt), desc(decisionRecords.id));
  const shelves = await db
    .select({
      itemId: statements.itemId,
      sourceUrl: items.locator,
      property: statements.property,
      value: statements.value,
      valueKey: statements.valueKey,
      method: statements.method,
      confidence: statements.confidence,
      lastSeen: statements.lastSeen,
      position: statements.position,
    })
    .from(statements)
    .innerJoin(items, eq(items.id, statements.itemId))
    .where(
      and(
        eq(statements.datasetId, datasetId),
        eq(statements.property, 'shelf'),
        isNull(statements.withdrawnAt),
      ),
    )
    .orderBy(asc(statements.itemId), asc(statements.id));
  // As anyRefusesAiInput reads a page's consent: its latest fetch that kept the site's signals.
  const signals = await db
    .selectDistinctOn([fetches.itemId], { itemId: fetches.itemId, signals: fetches.signals })
    .from(fetches)
    .innerJoin(items, eq(items.id, fetches.itemId))
    .where(and(eq(items.datasetId, datasetId), isNotNull(fetches.signals)))
    .orderBy(fetches.itemId, desc(fetches.startedAt), desc(fetches.id));
  const questions = await db
    .select({ itemId: reviewItems.itemId, question: reviewItems.question })
    .from(reviewItems)
    .where(
      and(
        eq(reviewItems.datasetId, datasetId),
        eq(reviewItems.kind, 'classify'),
        eq(reviewItems.status, 'open'),
      ),
    );

  const decisionOf = new Map(decisions.map((row) => [row.subject, row]));
  const finalOf = new Map(finals.map((row) => [row.subject, row]));
  const consentOf = new Map(signals.map((row) => [row.itemId, row.signals?.['ai-input'] !== 'no']));
  const openOf = new Map<string, TaxonomyParts>();
  for (const { itemId, question } of questions) {
    if (itemId !== null && question.type === 'taxonomy') openOf.set(itemId, question.parts);
  }
  const shelvesOf = new Map<string, StatementView[]>();
  for (const { itemId, ...row } of shelves) {
    const list = shelvesOf.get(itemId) ?? [];
    list.push({ ...row, lastSeen: row.lastSeen.toISOString() });
    shelvesOf.set(itemId, list);
  }
  return pages.map((page): DecidedPage => {
    const decision = decisionOf.get(page.id);
    const final = finalOf.get(page.id);
    const answer = readFinalAnswer(final?.finalAnswer ?? null);
    const state = decision?.state as { page?: { title?: unknown } } | undefined;
    return {
      itemId: page.id,
      address: page.locator,
      status: page.status === 'irrelevant' ? 'irrelevant' : 'live',
      title: typeof state?.page?.title === 'string' ? state.page.title : null,
      shelves: shelvesOf.get(page.id) ?? [],
      probabilities:
        decision === undefined ? {} : splitProbabilities(decision.probabilities).shelves,
      tokens: decision === undefined ? 0 : decision.inputTokens + decision.outputTokens,
      answered:
        answer === null || final === undefined
          ? null
          : { final: answer, probabilities: splitProbabilities(final.probabilities).shelves },
      open: openOf.get(page.id) ?? null,
      aiInput: consentOf.get(page.id) ?? false,
    };
  });
}

/**
 * The spec labels each live page's current statements give, as specLabelKey writes them, each once
 * and sorted: what the review counts as recurring properties.
 */
export async function specLabels(db: Executor, datasetId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .selectDistinct({
      itemId: statements.itemId,
      label: sql<string | null>`${statements.value} ->> 'label'`,
    })
    .from(statements)
    .innerJoin(items, eq(items.id, statements.itemId))
    .where(
      and(
        eq(statements.datasetId, datasetId),
        eq(items.status, 'live'),
        isNull(statements.withdrawnAt),
        sql`jsonb_typeof(${statements.value}) = 'object'`,
      ),
    );
  const labels = new Map<string, Set<string>>();
  for (const row of rows) {
    const label = row.label === null ? '' : specLabelKey(row.label);
    if (label === '') continue;
    const set = labels.get(row.itemId) ?? new Set<string>();
    set.add(label);
    labels.set(row.itemId, set);
  }
  return new Map([...labels].map(([itemId, set]) => [itemId, [...set].sort()]));
}

/** Every shelf a statement has ever named, withdrawn or not, sorted: for the retirement rule. */
export async function shelvesEverHeld(db: Executor, datasetId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ shelf: sql<string>`${statements.value} #>> '{}'` })
    .from(statements)
    .where(and(eq(statements.datasetId, datasetId), eq(statements.property, 'shelf')));
  return rows.map((row) => row.shelf).sort();
}
