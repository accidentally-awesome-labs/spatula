import {
  autonomyKind,
  buildReviewRequest,
  changeSchema,
  checkProposals,
  impactOf,
  jobSteps,
  newId,
  NONE_SHELF,
  reviewOutputSchema,
  shelfById,
  stableId,
  standingShelf,
  summarizeEvidence,
  TAXONOMY_REVIEW_MAX_TOKENS,
  type ActorRecord,
  type DownMarks,
  type EvidencePage,
  type LlmUsage,
  type ModelCall,
  type ProposalEvidence,
  type ReviewOutput,
  type RunSummary,
  type Taxonomy,
} from '@spatula/core';
import {
  autonomyOf,
  currentTaxonomy,
  decidedPages,
  decideProposal,
  logAction,
  proposalsOfRun,
  saveProposals,
  seenChanges,
  shelvesEverHeld,
  specLabels,
  taxonomyAt,
  type NewProposal,
} from '@spatula/store';
import { NO_USAGE, usageCalls, type Context, type LlmState, type RefreshPorts } from './pipeline';
import { storable } from './text';

/*
 * The taxonomy review after a run (ADR 0007). One call to the run's model reads the run's evidence
 * summed up: how pages sit on the shelves, what people answered, what the questions ask, where the
 * decider split its vote, and which spec labels recur. It never re-reads a page, and it reads
 * nothing of a page whose site says ai-input=no. Code checks each change it proposes: what passes
 * is kept open for the owner, and what fails is kept as dropped, with why. The run's proposals of
 * kinds that have earned autonomy are then applied on their own, and logged. Proposals take their
 * IDs from the run and their place, so a review that runs again finds its own, asks nothing, and
 * applies nothing twice.
 */

export interface TaxonomyReviewStep {
  taxonomy: NonNullable<RunSummary['taxonomy']>;
  notes: string[];
  /** What the review asked of models (ADR 0010). Absent in results from before it. */
  calls?: ModelCall[];
  /** The providers the review found down. Absent in results from before it. */
  down?: DownMarks;
}

/** Spatula itself, applying a change of a kind that has earned it. */
const DECIDER: ActorRecord = { role: 'decider', client: 'run' };
/**
 * How often a change is tried on its own. Under the dataset's lock no version comes between
 * reading the current one and committing the next, but the commit still compares and sets: should
 * it find a newer version, the next try applies the change on that one.
 */
const APPLY_TRIES = 3;

/**
 * Reviews the dataset's taxonomy after a run. It asks for proposals unless the run has made them
 * already, then applies the run's proposals whose kinds have earned autonomy. What it proposed,
 * dropped, and applied is read back from the store, so a step that runs again says the same.
 */
export async function reviewTaxonomy(
  context: Context,
  llm: LlmState,
  ports: RefreshPorts,
): Promise<TaxonomyReviewStep> {
  const { runId } = context;
  // A replayed step returns its saved result, so it asks nothing and counts no tokens again. The
  // body runs again only after a crash before that result was saved: a review that saved its
  // proposals by then isn't asked again, nor counted again. The accepted limit, as in the run's
  // other LLM steps, is at least once: an answer that saved no proposals (empty, or not fitting
  // the schema) is asked once more, and only the re-run's tokens are counted.
  const saved = await ports.withDb((db) => proposalsOfRun(db, runId));
  const asked =
    saved.length > 0 ? { usage: NO_USAGE, notes: [] } : await propose(context, llm, ports);
  if ('skipped' in asked) {
    return {
      taxonomy: { proposed: 0, dropped: 0, applied: [], ...NO_USAGE, skipped: asked.skipped },
      notes: [],
      calls: [],
      down: {},
    };
  }
  const notes = [...asked.notes, ...(await applyEarned(context, ports))];
  const rows = await ports.withDb((db) => proposalsOfRun(db, runId));
  return {
    taxonomy: {
      proposed: rows.filter((row) => row.status !== 'dropped').length,
      dropped: rows.filter((row) => row.status === 'dropped').length,
      // What Spatula applied on its own, each of which the console can undo.
      applied: rows
        .flatMap((row) =>
          row.status === 'applied' && row.version !== null && row.decidedBy?.role === 'decider'
            ? [{ version: row.version, summary: row.summary ?? row.kind }]
            : [],
        )
        .sort((a, b) => a.version - b.version),
      inputTokens: asked.usage.inputTokens,
      outputTokens: asked.usage.outputTokens,
    },
    notes,
    // Until the cascade reports its calls itself, the usage is one call of the first model.
    calls: usageCalls(
      jobSteps(context.definition, 'taxonomyReview', ports.models.defaultModel)[0]!.model,
      asked.usage,
      asked.failed === true,
    ),
    down: {},
  };
}

/** Asks the review and keeps its proposals; or says why it may not ask. */
async function propose(
  context: Context,
  llm: LlmState,
  ports: RefreshPorts,
): Promise<{ usage: LlmUsage; notes: string[]; failed?: boolean } | { skipped: string }> {
  const { datasetId, definition, runId } = context;
  // It shows a model what the dataset's pages said, which takes what deciding takes (ADR 0003).
  if (!definition.policy.purposes.includes('ai-input')) {
    return { skipped: 'the dataset doesn’t allow AI input' };
  }
  const port = ports.llm;
  if (port === null) return { skipped: 'no model is configured' };
  if (llm.usdLeft <= 0) return { skipped: 'this run’s LLM budget is spent' };
  const read = await ports.withDb(async (db) => ({
    current: await currentTaxonomy(db, datasetId),
    first: await taxonomyAt(db, datasetId, 1),
    pages: await decidedPages(db, datasetId),
    labels: await specLabels(db, datasetId),
    everHeld: await shelvesEverHeld(db, datasetId),
    seen: await seenChanges(db, datasetId),
  }));
  const { current, first } = read;
  if (current === null || first === null) return { skipped: 'the dataset has no taxonomy' };
  const taxonomy = current.taxonomy;
  // The model reads nothing of a page whose site says ai-input=no (ruling 17).
  const shown: EvidencePage[] = read.pages
    .filter((page) => page.aiInput)
    .map((page) => ({ ...page, labels: read.labels.get(page.itemId) ?? [] }));
  if (shown.length === 0) {
    return {
      skipped:
        read.pages.length === 0 ? 'the dataset has no pages yet' : 'no page’s site allows AI input',
    };
  }
  const seeded = first.taxonomy.shelves.map((shelf) => shelf.id);
  const evidence = summarizeEvidence({ taxonomy, pages: shown, seeded, everHeld: read.everHeld });
  let answer: { output: ReviewOutput | null; usage: LlmUsage };
  try {
    answer = await port.structured({
      ...buildReviewRequest(taxonomy, evidence),
      schema: reviewOutputSchema,
      maxTokens: TAXONOMY_REVIEW_MAX_TOKENS,
    });
  } catch (error) {
    // A failed call proposes nothing, as the run's other calls do: the run still finishes, with
    // what it published, and the next run's review asks again.
    const message = error instanceof Error ? error.message : String(error);
    return {
      usage: NO_USAGE,
      failed: true,
      notes: [storable(`The taxonomy review’s call failed: ${message}`)],
    };
  }
  if (answer.output === null) {
    return {
      usage: answer.usage,
      notes: ['The taxonomy review’s answer didn’t fit the schema, so it proposed nothing.'],
    };
  }
  // Where every page sits now, shown to the model or not: a change moves them all.
  const shelves = read.pages.map((page) =>
    page.status === 'irrelevant' ? NONE_SHELF : standingShelf(taxonomy, page.shelves).shelf,
  );
  const checked = checkProposals({
    taxonomy,
    proposals: answer.output.proposals,
    pagesInDataset: new Set(shown.map((page) => page.address)),
    seen: read.seen,
    seededShelfHistory: {
      seededAt: first.createdAt,
      seeded,
      everHeld: read.everHeld,
      holding: shelves.filter((shelf): shelf is string => shelf !== null && shelf !== NONE_SHELF),
    },
    now: context.startedAt,
  });
  // Deciding a page again costs what the decider spent on a page this time, on average.
  const decided = read.pages.filter((page) => page.tokens > 0);
  const tokensPerPage =
    decided.length === 0 ? 0 : decided.reduce((sum, page) => sum + page.tokens, 0) / decided.length;
  const common = { datasetId, runId, base: current.version, createdAt: ports.now() };
  const rows = await Promise.all([
    ...checked.kept.map(
      async (kept): Promise<NewProposal> => ({
        ...common,
        id: await stableId('tp', runId, kept.index),
        kind: kept.kind,
        change: kept.change,
        changeText: kept.changeText,
        summary: kept.summary,
        why: kept.why,
        evidence: evidenceOf(taxonomy, shown, kept.pages),
        impact: impactOf({ taxonomy, change: kept.change, shelves, tokensPerPage }),
        status: 'open',
        dropReason: null,
      }),
    ),
    ...checked.dropped.map(
      async (dropped): Promise<NewProposal> => ({
        ...common,
        id: await stableId('tp', runId, dropped.index),
        kind: dropped.kind,
        // What the review sent, kept as text: it isn't a change Spatula takes.
        change: dropped.change,
        changeText: dropped.change,
        summary: null,
        why: dropped.why,
        evidence: { pages: [] },
        impact: null,
        status: 'dropped',
        dropReason: dropped.reason,
      }),
    ),
  ]);
  await ports.withDb((db) => saveProposals(db, rows));
  return { usage: answer.usage, notes: [] };
}

/** A proposal's evidence: the pages it names, with their titles and the shelves they're on. */
function evidenceOf(
  taxonomy: Taxonomy,
  shown: readonly EvidencePage[],
  named: readonly string[],
): ProposalEvidence {
  const byAddress = new Map(shown.map((page) => [page.address, page]));
  return {
    pages: named.flatMap((address) => {
      const page = byAddress.get(address);
      if (page === undefined) return [];
      const shelf =
        page.status === 'irrelevant' ? NONE_SHELF : standingShelf(taxonomy, page.shelves).shelf;
      return [
        {
          address,
          title: page.title,
          shelf:
            shelf === null || shelf === NONE_SHELF
              ? shelf
              : (shelfById(taxonomy, shelf)?.slug ?? shelf),
        },
      ];
    }),
  };
}

/**
 * Applies the run's open proposals whose kinds have earned autonomy (ADR 0007), each as the next
 * version, logged in the same transaction. A proposal applied already isn't open, so a step that
 * runs again applies nothing twice. Proposals from earlier runs wait for the owner.
 */
async function applyEarned(context: Context, ports: RefreshPorts): Promise<string[]> {
  const { datasetId, runId } = context;
  const { open, earned } = await ports.withDb(async (db) => ({
    open: (await proposalsOfRun(db, runId)).filter((row) => row.status === 'open'),
    earned: new Set(
      (await autonomyOf(db, datasetId)).filter((row) => row.earned).map((row) => row.kind),
    ),
  }));
  const notes: string[] = [];
  for (const proposal of open) {
    const parsed = changeSchema.safeParse(proposal.change);
    const kind = parsed.success ? autonomyKind(parsed.data) : null;
    if (kind === null || !earned.has(kind)) continue;
    const apply = () =>
      ports.withDb((db) =>
        db.transaction(async (tx) => {
          const at = ports.now();
          const decided = await decideProposal(tx, {
            id: proposal.id,
            decision: 'accept',
            actor: DECIDER,
            autonomous: true,
            makeId: () => newId('tx'),
            at,
          });
          if (decided.kind === 'applied') {
            await logAction(tx, {
              datasetId,
              action: 'apply',
              subject: proposal.id,
              actor: DECIDER,
              detail: { kind, version: decided.version, summary: decided.summary },
              at,
            });
          }
          return decided;
        }),
      );
    let result = await apply();
    for (
      let tries = 1;
      tries < APPLY_TRIES && result.kind === 'stale' && result.moved === true;
      tries += 1
    ) {
      result = await apply();
    }
    if (result.kind === 'stale') {
      notes.push(
        `The taxonomy review couldn’t apply ${proposal.summary ?? proposal.kind} on its own: ${result.reason}`,
      );
    }
  }
  return notes;
}
