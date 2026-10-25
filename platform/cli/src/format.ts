import {
  EVAL_TARGETS,
  findItem,
  JOBS,
  NONE_OF_THESE,
  NONE_SHELF,
  REFUSE_AFTER_RUNS,
  reviewAnswers,
  shelfPath,
  type ApplySummary,
  type ComparisonColumn,
  type ComparisonReport,
  type DatasetStatus,
  type DownMarks,
  type EvalScores,
  type EvalView,
  type Feature,
  type GoldenSet,
  type ReviewView,
  type RunSummary,
  type RunView,
  type Tally,
  type Taxonomy,
  type TaxonomyParts,
  type TaxonomySubject,
} from '@spatula/core';

/** What applying a definition changed, or would change. */
export function formatApplySummary(summary: ApplySummary, dryRun: boolean): string[] {
  const { dataset, revision } = summary;
  const lines = [
    summary.created
      ? `${dataset} ${dryRun ? 'would be created' : 'was created'} at revision ${revision}.`
      : summary.changed
        ? `${dataset} ${dryRun ? 'would move' : 'moved'} to revision ${revision}.`
        : `${dataset} is unchanged, at revision ${revision}.`,
  ];
  const { added, removed, changed } = summary.sources;
  if (added.length > 0) lines.push(`Sources added: ${added.join(', ')}.`);
  if (removed.length > 0) lines.push(`Sources removed: ${removed.join(', ')}.`);
  if (changed.length > 0) lines.push(`Sources changed: ${changed.join(', ')}.`);
  // A Worker before ADR 0006 sends no moves, and its plans read as they always did.
  const moved = summary.pages.moved ?? 0;
  if (moved > 0) {
    const where = (summary.moves ?? [])
      .map((move) => `${move.from.join(', ')} → ${move.to}`)
      .join('; ');
    lines.push(
      `Pages: ${summary.pages.added} added, ${moved} moved (${where}), ${summary.pages.removed} removed.`,
    );
  } else if (summary.pages.added + summary.pages.removed > 0) {
    lines.push(`Pages: ${summary.pages.added} added, ${summary.pages.removed} removed.`);
  }
  const unmoved = summary.unmoved;
  if (unmoved !== undefined) {
    const why = [
      unmoved.uncovered > 0 ? `${unmoved.uncovered} that no remaining source covers` : null,
      unmoved.ambiguous > 0 ? `${unmoved.ambiguous} that two or more sources cover` : null,
      unmoved.taken > 0 ? `${unmoved.taken} that their new source already has` : null,
    ].filter((part) => part !== null);
    if (why.length > 0) lines.push(`Pages left excluded: ${why.join(', ')}.`);
  }
  // A Worker before ADR 0010 sends none.
  for (const change of summary.models ?? []) {
    lines.push(`Models, ${change.job}: ${change.before} → ${change.after}.`);
  }
  // A Worker before the taxonomy sends none (ADR 0007).
  if (summary.taxonomyVersion !== undefined) {
    lines.push(
      dryRun
        ? `The new scope would make taxonomy version ${summary.taxonomyVersion}.`
        : `The new scope made taxonomy version ${summary.taxonomyVersion}.`,
    );
  }
  return lines;
}

/** How a run went. */
export function formatRun(run: RunView): string[] {
  if (run.status === 'failed')
    return [`Run ${run.id} failed: ${run.error ?? 'no reason was recorded'}`];
  const lines = [`Run ${run.id}: ${run.status}.`];
  const summary = run.summary;
  if (summary === null) return lines;
  const { fetches, statements, llm, entities, snapshot } = summary;
  // Runs from before slice 1 read every live page, and didn't count what was due.
  const pages =
    summary.due === undefined
      ? `Pages: ${summary.items}.`
      : `Pages: ${summary.items} read, of ${summary.due} due and ${summary.live ?? summary.due} live.`;
  lines.push(
    `${pages} Changed ${fetches.changed}, unchanged ${fetches.unchanged}, gone ${fetches.gone}, failed ${fetches.failed}, blocked ${fetches.blocked}.`,
  );
  // Pages read again from their captures (ADR 0008); a Worker before re-reading says nothing.
  const reread = summary.reread ?? 0;
  if (reread > 0) {
    lines.push(
      `Re-read from the archive: ${reread} ${reread === 1 ? 'page' : 'pages'}, with no request.`,
    );
  }
  // The run's notes are held to a few, and this is how a pause is seen when they ran out.
  const paused = Object.entries(summary.paused ?? {});
  if (paused.length > 0) {
    const sources = paused.map(
      ([source, left]) => `${source}, ${left} ${left === 1 ? 'page' : 'pages'} unread`,
    );
    lines.push(`Paused after pages in a row were blocked or strained: ${sources.join('; ')}.`);
  }
  // What the run found of its sources' standing (ADR 0006); runs before phase 1 say nothing.
  const standing = summary.sources;
  if (standing !== undefined) {
    if (standing.blocked.length > 0) {
      const blocked = standing.blocked.map(
        (source) => `${source.id}, ${source.blockedRuns} of ${REFUSE_AFTER_RUNS} runs in a row`,
      );
      lines.push(`Blocked: ${blocked.join('; ')}.`);
    }
    if (standing.refused.length > 0) {
      lines.push(
        `Refused: ${standing.refused.join(', ')}, after ${REFUSE_AFTER_RUNS} blocked runs in a row. Later runs only probe ${standing.refused.length === 1 ? 'it' : 'them'}.`,
      );
    }
    if (standing.probed.length > 0) {
      const probed = standing.probed.map(
        (probe) =>
          `${probe.id}, ${probe.outcome === 'through' ? 'got through, so it’s live again' : probe.outcome}`,
      );
      lines.push(`Probed: ${probed.join('; ')}.`);
    }
  }
  // Runs from before slice 1, and datasets with no sitemap source, say nothing of sitemaps.
  const discovery = summary.discovery;
  if (discovery !== undefined && discovery.sources > 0) {
    lines.push(
      `Sitemaps: ${discovery.sitemaps} read for ${discovery.sources} ${discovery.sources === 1 ? 'source' : 'sources'}; ${discovery.listed} ${discovery.listed === 1 ? 'page' : 'pages'} listed, ${discovery.added} new, ${discovery.revived} back, ${discovery.missing} missing, ${discovery.gone} gone.`,
    );
    for (const reason of discovery.incomplete) lines.push(`Not read completely: ${reason}.`);
  }
  lines.push(
    `Statements: ${statements.added} added, ${statements.reseen} seen again, ${statements.withdrawn} withdrawn.`,
    `LLM: ran ${llm.ran}, reused ${llm.reused}, skipped ${llm.skipped}, failed ${llm.failed}; ${llm.inputTokens} tokens in, ${llm.outputTokens} out.`,
  );
  // What the run kept of the pages it read (ADR 0008). A Worker before the archive says nothing.
  if (summary.captures !== undefined) {
    const { stored, pruned } = summary.captures;
    lines.push(
      `Archive: ${stored} ${stored === 1 ? 'capture' : 'captures'} stored, ${pruned} cleaned up.`,
    );
  }
  // Runs from before slice 1, and datasets that decide nothing, say nothing of decisions.
  for (const [label, counts] of [
    ['Classified', summary.classify],
    ['Matched', summary.match],
  ] as const) {
    if (counts === undefined) continue;
    const asked =
      counts.rule +
      counts.accepted +
      counts.escalated +
      counts.reused +
      counts.skipped +
      counts.failed;
    if (asked === 0) continue;
    lines.push(
      `${label}: ${counts.rule} by rule, ${counts.accepted} by the decider, ${counts.escalated} for review, ${counts.reused} as before, ${counts.skipped} for the next run, ${counts.failed} failed; ${counts.inputTokens} tokens in, ${counts.outputTokens} out.`,
    );
    // The pairs the model-number rule kept apart, by name (ADR 0003). Runs before it name none.
    const named = label === 'Matched' ? (summary.ruleApart ?? []) : [];
    if (named.length > 0) {
      const rest = counts.rule - named.length;
      lines.push(
        `Kept apart by the model-number rule: ${named.join('; ')}${rest > 0 ? `; and ${rest} more` : ''}.`,
      );
    }
  }
  // What the models cost, and the providers found down (ADR 0010). Runs before it say nothing.
  lines.push(...spendLines(summary.spend));
  for (const { provider, since } of downs(llm.down)) lines.push(`Down: ${provider} ${since}`);
  const irrelevant = summary.irrelevant ?? 0;
  if (irrelevant > 0) {
    lines.push(
      `Not the dataset’s: ${irrelevant} ${irrelevant === 1 ? 'page' : 'pages'}, out until revived.`,
    );
  }
  // What the run decided again of the pages a taxonomy change touched (ADR 0008).
  const backfill = summary.backfill;
  if (backfill !== undefined) {
    lines.push(
      backfill.due === 0
        ? 'Backfill: nothing to decide again.'
        : `Backfill: ${backfill.decided} of ${backfill.due} ${backfill.due === 1 ? 'page' : 'pages'} decided again, ${backfill.fetch} marked to be fetched, ${backfill.waiting} left for the next run.`,
    );
  }
  lines.push(
    `Entities: ${entities.created} new, ${entities.linked} linked, ${entities.conflicts} conflicts, ${entities.unresolved} without an identity yet${(entities.waiting ?? 0) > 0 ? `, ${entities.waiting} waiting for a match answer` : ''}.`,
    snapshot.published
      ? `Snapshot: generation ${snapshot.generation}, ${snapshot.records} records.`
      : `Snapshot: none published, because ${snapshot.reason}.`,
  );
  if (!snapshot.published && snapshot.held !== undefined) {
    lines.push(
      `Held: ${snapshot.held.snapshotId}, ${snapshot.held.records} records. Publish or discard it with spatula review.`,
    );
  }
  for (const left of snapshot.excluded)
    lines.push(`Left out: ${left.canonicalId}, missing ${left.missing.join(', ')}.`);
  // The taxonomy review after the run (ADR 0007). Runs from before it, and datasets without a
  // taxonomy, say nothing.
  const review = summary.taxonomy;
  if (review !== undefined) {
    lines.push(
      review.skipped === undefined
        ? `Taxonomy review: ${review.proposed} ${review.proposed === 1 ? 'proposal' : 'proposals'}, ${review.dropped} dropped by the checks; ${review.inputTokens} tokens in, ${review.outputTokens} out.`
        : `Taxonomy review: skipped, because ${review.skipped}.`,
    );
    for (const change of review.applied) {
      lines.push(
        `Applied on its own: ${change.summary}, as version ${change.version}. The console can undo it.`,
      );
    }
  }
  if (summary.notes.length > 0) lines.push('Notes:', ...summary.notes.map((note) => `  ${note}`));
  return lines;
}

/** Dollars to the cent. Spend under a cent isn't nothing, so it doesn't read as $0.00. */
const dollars = (usd: number) => (usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);

/** An ISO time to the minute, in UTC, as 2026-10-24 12:31 UTC. */
const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/**
 * What each job's models cost a run, a line for each job with its models by what they cost, most
 * first, then the run's total. Each sum is of the unrounded figures, so the total isn't off by the
 * rounding of its parts.
 */
function spendLines(spend: RunSummary['spend']): string[] {
  if (spend === undefined) return [];
  const lines: string[] = [];
  let total = 0;
  for (const job of JOBS) {
    const models = Object.entries(spend[job] ?? {});
    if (models.length === 0) continue;
    const sum = models.reduce((usd, [, model]) => usd + model.usd, 0);
    total += sum;
    const each = models
      .sort(([a, x], [b, y]) => y.usd - x.usd || a.localeCompare(b))
      .map(
        ([model, { usd, calls, failed }]) =>
          `${model} ${dollars(usd)} (${calls} ${calls === 1 ? 'call' : 'calls'}${failed > 0 ? `, ${failed} failed` : ''})`,
      );
    lines.push(`Spend, ${job}: ${dollars(sum)}. ${each.join(', ')}.`);
  }
  if (lines.length > 0) lines.push(`Spend in all: ${dollars(total)}.`);
  return lines;
}

/**
 * Each provider a run found down, with since when and why, and what became of its later calls: a
 * step without a backup, as a job left to the default model always is, failed.
 */
function downs(down: DownMarks | undefined): { provider: string; since: string }[] {
  return Object.entries(down ?? {}).map(([provider, { at, reason }]) => ({
    provider,
    since: `since ${minute(at)}: ${reason}. Its later calls went to their backups, or failed where there was none.`,
  }));
}

/**
 * The open questions, each with what it proposes and the answers it takes. A taxonomy question
 * names its shelves, functions, and values from the taxonomy (ADR 0007), with the slug to answer
 * each by.
 */
export function formatReviews(
  datasetId: string,
  reviews: ReviewView[],
  taxonomy: Taxonomy | null = null,
): string[] {
  if (reviews.length === 0) return ['No questions wait for an answer.'];
  const lines = [
    `${reviews.length} ${reviews.length === 1 ? 'question waits' : 'questions wait'} for an answer.`,
  ];
  for (const review of reviews) {
    const context = review.context;
    const text = (key: string) =>
      typeof context[key] === 'string' ? (context[key] as string) : '';
    const number = (key: string) =>
      typeof context[key] === 'number' ? (context[key] as number) : 0;
    // A match question names the record by its ID, which is how a refusal names it, and then the
    // address of the page that stands for it. A question asked before the ID was kept names the two
    // pages alone.
    const record = text('record');
    const pair =
      record === ''
        ? `${text('page')} and ${text('entity')}`
        : `${text('page')} and ${record} (${text('entity')})`;
    const about =
      review.kind === 'classify'
        ? text('url')
        : review.kind === 'match'
          ? pair
          : text('snapshotId');
    lines.push('', `${review.id}  ${review.kind}  ${about}`);
    if (review.kind === 'publication') {
      lines.push(
        `  ${review.question.prompt} ${number('records')} records: ${number('added')} new, ${number('removed')} removed.`,
      );
      const reasons = Array.isArray(context.reasons) ? context.reasons.map(String) : [];
      if (reasons.length > 0) lines.push(`  Held because ${reasons.join('; ')}.`);
      // Why records left: those the run couldn't complete, and the questions that still wait.
      const incomplete = number('incomplete');
      const openClassify = number('openClassify');
      const openMatch = number('openMatch');
      const why = [
        ...(incomplete > 0 ? [`Left out as incomplete: ${incomplete}.`] : []),
        ...(openClassify + openMatch > 0
          ? [`Open questions: ${openClassify} classify, ${openMatch} match.`]
          : []),
      ];
      if (why.length > 0) lines.push(`  ${why.join(' ')}`);
    } else if (review.question.type === 'taxonomy') {
      lines.push(
        `  ${review.question.prompt}`,
        ...partsLines(taxonomy, review.question.parts, context),
      );
    } else {
      lines.push(`  ${review.question.prompt}`);
      const proposed = text('proposed');
      const reason = text('reason');
      if (proposed !== '') {
        const probabilities = (context.probabilities ?? {}) as Record<string, unknown>;
        const probability = probabilities[proposed];
        const sure = typeof probability === 'number' ? ` (${probability.toFixed(2)})` : '';
        lines.push(`  Proposed: ${proposed}${sure}.${reason === '' ? '' : ` ${reason}`}`);
      } else if (reason !== '') {
        // The decider named no answer, but a person deciding still wants to know why.
        lines.push(`  Nothing proposed. ${reason}`);
      }
    }
    // A reviewer's answer differed from one that stood, so the question waits for the owner's.
    if (review.flagged === true) {
      lines.push(
        '  Flagged: a reviewer’s answer differs from the one that stood. Yours closes it.',
      );
    }
    if (review.suggestion !== undefined) {
      lines.push(`  Suggested: ${suggestionWords(taxonomy, review.suggestion)}.`);
    }
    if (review.question.type !== 'taxonomy') {
      // A match question asked before the relationships takes them too (ADR 0003).
      lines.push(`  Answers: ${reviewAnswers(review.kind, review.question).join(' | ')}`);
    }
  }
  lines.push('');
  if (reviews.some((review) => review.question.type !== 'taxonomy')) {
    lines.push(`Answer with: spatula review ${datasetId} <id> "<answer>"`);
  }
  if (reviews.some((review) => review.question.type === 'taxonomy')) {
    lines.push(
      `Answer in parts with: spatula review ${datasetId} <id> --shelf <slug> --function <slug> --feature <feature>=<value>`,
    );
  }
  if (reviews.some((review) => review.suggestion !== undefined)) {
    lines.push(`Take a suggestion with: spatula review ${datasetId} <id> --suggestion`);
  }
  return lines;
}

/** A taxonomy question's lines: what's proposed and settled, then each part it asks. */
function partsLines(
  taxonomy: Taxonomy | null,
  parts: TaxonomyParts,
  context: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  const chances = isRecord(context.probabilities) ? context.probabilities : {};
  const reason = typeof context.reason === 'string' ? context.reason : '';
  const proposed = answerWords(taxonomy, context.proposed, chances);
  if (proposed !== '') lines.push(`  Proposed: ${proposed}.${reason === '' ? '' : ` ${reason}`}`);
  else if (reason !== '') lines.push(`  Nothing proposed. ${reason}`);
  const settled = answerWords(taxonomy, context.settled, {});
  if (settled !== '') lines.push(`  Settled already: ${settled}.`);
  const earlier = answerWords(taxonomy, context.earlier, {});
  if (earlier !== '') lines.push(`  A person said before: ${earlier}.`);
  const offered = (subject: 'shelf' | 'function' | 'value', ids: string[]) =>
    ids.map((id) => choice(taxonomy, subject, id)).join(', ');
  if (parts.shelves.length > 0) lines.push(`  Shelf, one of: ${offered('shelf', parts.shelves)}`);
  if (parts.functions.length > 0) {
    lines.push(`  Functions, any of: ${offered('function', parts.functions)}`);
  }
  for (const [featureId, values] of Object.entries(parts.features)) {
    if (values.length === 0) continue;
    const found = taxonomy === null ? undefined : findItem(taxonomy, 'feature', featureId);
    const feature = found as Feature | undefined;
    const named = feature === undefined ? featureId : `${feature.slug} (${feature.name})`;
    const takes = feature?.cardinality === 'one' ? 'one of' : 'any of';
    lines.push(`  Feature ${named}, ${takes}: ${offered('value', values)}`);
  }
  return lines;
}

/** A part as it's typed, then what it means: "over-ear (Headphones › Over-ear)". */
function choice(
  taxonomy: Taxonomy | null,
  subject: 'shelf' | 'function' | 'value',
  id: string,
): string {
  if (subject === 'shelf' && id === NONE_SHELF) return `${NONE_SHELF} (${NONE_OF_THESE})`;
  const found = taxonomy === null ? undefined : findItem(taxonomy, subject, id);
  if (taxonomy === null || found === undefined) return id;
  return `${found.slug} (${subject === 'shelf' ? shelfPath(taxonomy, found.id) : found.name})`;
}

/** A three-part answer in words, each part with its probability where there is one. */
function answerWords(
  taxonomy: Taxonomy | null,
  answer: unknown,
  chances: Record<string, unknown>,
): string {
  if (!isRecord(answer)) return '';
  const sure = (key: string) => {
    const chance = chances[key];
    return typeof chance === 'number' ? ` (${chance.toFixed(2)})` : '';
  };
  const words: string[] = [];
  if (typeof answer.shelf === 'string') {
    words.push(`${shelfWords(taxonomy, answer.shelf)}${sure(`shelf:${answer.shelf}`)}`);
  }
  for (const id of strings(answer.functions)) {
    words.push(`${nameOf(taxonomy, 'function', id)}${sure(`function:${id}`)}`);
  }
  for (const id of strings(answer.values)) {
    words.push(`${valueWords(taxonomy, id)}${sure(`value:${id}`)}`);
  }
  return words.join(', ');
}

/** A suggestion in words: its answer, or its parts, which name items by slug or by ID. */
function suggestionWords(taxonomy: Taxonomy | null, suggestion: unknown): string {
  if (!isRecord(suggestion)) return '';
  if (typeof suggestion.answer === 'string') return suggestion.answer;
  const words: string[] = [];
  if (typeof suggestion.shelf === 'string') words.push(shelfWords(taxonomy, suggestion.shelf));
  for (const ref of strings(suggestion.functions)) words.push(nameOf(taxonomy, 'function', ref));
  const features = isRecord(suggestion.features) ? suggestion.features : {};
  for (const refs of Object.values(features)) {
    for (const ref of strings(refs)) words.push(valueWords(taxonomy, ref));
  }
  return words.length === 0 ? 'none of the parts offered' : words.join(', ');
}

/** A shelf as people read it, "Headphones › Over-ear", or "None of these". */
function shelfWords(taxonomy: Taxonomy | null, ref: string): string {
  if (ref === NONE_SHELF || ref === NONE_OF_THESE) return NONE_OF_THESE;
  const found = taxonomy === null ? undefined : findItem(taxonomy, 'shelf', ref);
  return taxonomy === null || found === undefined ? ref : shelfPath(taxonomy, found.id);
}

/** A feature's value with its feature, "Drives: Speakers". */
function valueWords(taxonomy: Taxonomy | null, ref: string): string {
  const value = taxonomy === null ? undefined : findItem(taxonomy, 'value', ref);
  const feature = taxonomy?.features.find((one) =>
    one.values.some((entry) => entry.id === value?.id),
  );
  return value === undefined || feature === undefined ? ref : `${feature.name}: ${value.name}`;
}

function nameOf(taxonomy: Taxonomy | null, subject: TaxonomySubject, ref: string): string {
  return (taxonomy === null ? undefined : findItem(taxonomy, subject, ref))?.name ?? ref;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** Where a dataset stands: its head, what's held, what waits, and what consumers acknowledged. */
export function formatStatus(status: DatasetStatus): string[] {
  const lines = [
    status.headGeneration === 0
      ? `${status.dataset}, revision ${status.revision}: nothing is published yet.`
      : `${status.dataset}, revision ${status.revision}: generation ${status.headGeneration} is published.`,
  ];
  if (status.held !== null) {
    lines.push(
      `Held: ${status.held.snapshotId}, ${status.held.records} records${status.held.reason === null ? '' : `, because ${status.held.reason}`}.`,
    );
  }
  const { classify, match, publication } = status.reviews;
  lines.push(
    classify + match + publication === 0
      ? 'Nothing waits for review.'
      : `Waiting for review: ${classify} classify, ${match} match, ${publication} publication.`,
  );
  for (const consumer of status.consumers) {
    lines.push(
      consumer.generation === null
        ? `${consumer.name}: has acknowledged nothing yet.`
        : `${consumer.name}: ${consumer.outcome} generation ${consumer.generation} at ${consumer.receivedAt}.`,
    );
  }
  // A Worker from before phase 1 says nothing of its sources' standing (ADR 0006).
  if (status.sources !== undefined) {
    const day = (iso: string) => iso.slice(0, 10);
    const standing = status.sources.filter(
      (source) => source.blockedRuns > 0 || source.refusedAt !== null,
    );
    if (standing.length === 0) lines.push('Every source is live.');
    for (const source of standing) {
      if (source.refusedAt === null) {
        lines.push(
          `${source.id}: blocked, ${source.blockedRuns} of ${REFUSE_AFTER_RUNS} runs in a row.`,
        );
        continue;
      }
      const probe =
        source.lastProbeAt === null || source.lastProbe === null
          ? 'not probed yet'
          : `last probe ${day(source.lastProbeAt)}: ${source.lastProbe}`;
      lines.push(
        `${source.id}: refused since ${day(source.refusedAt)}, after ${source.blockedRuns} blocked runs in a row; ${probe}.`,
      );
    }
  }
  // A Worker from before phase 1 doesn't say.
  if (status.verified !== undefined) {
    lines.push(
      status.verified
        ? 'Cloudflare lists Spatula as a verified bot.'
        : 'Cloudflare doesn’t list Spatula as a verified bot yet.',
    );
  }
  // Only when the latest run found a provider down, and never from a Worker before ADR 0010.
  if (status.llm !== undefined) {
    const { runId, down } = status.llm;
    for (const { provider, since } of downs(down)) {
      lines.push(`In the latest run (${runId}), ${provider} was down ${since}`);
    }
  }
  return lines;
}

/**
 * A share as a percentage, floored to one decimal, so a score just under its target never reads as
 * the target: 0.9896 is 98.9%, not 99.0%. The 1e-9 keeps an exact share such as 0.99 from flooring
 * below itself.
 */
const percent = (share: number) => `${(Math.floor(share * 1000 + 1e-9) / 10).toFixed(1)}%`;
const verdict = (met: boolean) => (met ? 'met' : 'not met');

/** A score against the golden set, target by target, then each field. */
export function formatScores(golden: GoldenSet, scores: EvalScores): string[] {
  const lines = [
    `${golden.dataset}, generation ${scores.generation}, against golden set version ${golden.version} (${scores.products} ${scores.products === 1 ? 'product' : 'products'}):`,
    `Precision: ${percent(scores.precision)} (target ${EVAL_TARGETS.precision * 100}%): ${verdict(scores.targets.precision)}.`,
    `Recall: ${percent(scores.recall)}, ${scores.found} of ${scores.products} found (target ${EVAL_TARGETS.recall * 100}%): ${verdict(scores.targets.recall)}.`,
  ];
  // A golden set that names no shelf, function, or feature, as every one before ADR 0007, gets no
  // taxonomy lines.
  const taxonomy = scores.taxonomy;
  const tallies: (readonly [string, Tally, boolean, number])[] = [
    ['Identifiers', scores.identifiers, scores.targets.identifiers, EVAL_TARGETS.identifiers],
    ['Key specs', scores.keySpecs, scores.targets.keySpecs, EVAL_TARGETS.keySpecs],
  ];
  if (taxonomy !== undefined) {
    tallies.push(['Shelf', taxonomy.shelf, taxonomy.targets.shelf, EVAL_TARGETS.shelf]);
  }
  for (const [label, tally, met, target] of tallies) {
    const left = tally.missing === 0 ? '' : `, ${tally.missing} left out`;
    lines.push(
      tally.checked === 0
        ? `${label}: none checked${left}${tally.missing === 0 ? '' : ': not met'}.`
        : `${label}: ${percent(tally.accuracy)} of ${tally.checked} stated${left} (target ${target * 100}%): ${verdict(met)}.`,
    );
  }
  if (taxonomy !== undefined) {
    const { functions, features } = taxonomy;
    if (functions.stated + functions.expected > 0) {
      const precision =
        functions.stated === 0
          ? 'none stated'
          : `precision ${percent(functions.precision)} of ${functions.stated} stated`;
      lines.push(
        `Functions: ${precision}, recall ${percent(functions.recall)} of ${functions.expected} golden (target ${EVAL_TARGETS.functions * 100}%): ${verdict(taxonomy.targets.functions)}.`,
      );
    }
    // Features have no target, so they read as a field does.
    if (features.checked + features.missing > 0) {
      const figure =
        features.checked === 0
          ? 'none checked'
          : `${percent(features.accuracy)} of ${features.checked} stated`;
      const left = features.missing === 0 ? '' : `, ${features.missing} left out`;
      lines.push(`Features: ${figure}${left}.`);
    }
  }
  const fields = Object.entries(scores.fields).sort(([a], [b]) => (a < b ? -1 : 1));
  if (fields.length > 0) {
    // A field none of whose values were stated has no accuracy to show, only what was left out.
    const shown = fields.map(([name, tally]) => {
      const figure =
        tally.checked === 0 ? 'none checked' : `${percent(tally.accuracy)} of ${tally.checked}`;
      return `${name} ${figure}${tally.missing === 0 ? '' : ` (${tally.missing} left out)`}`;
    });
    lines.push(`Fields: ${shown.join(', ')}.`);
  }
  if (scores.split > 0) lines.push(`Spread over several records: ${scores.split}.`);
  if (scores.misses.length > 0) lines.push('Misses:', ...scores.misses.map((miss) => `  ${miss}`));
  return lines;
}

/** The history of a dataset's scores, newest first. */
export function formatEvals(evals: EvalView[]): string[] {
  if (evals.length === 0) {
    return ['No scores are kept yet. spatula eval <golden.json> --save keeps one.'];
  }
  // Nothing checked is not a perfect score, so a tally with nothing checked shows no percentage.
  const accuracy = (tally: Tally) =>
    tally.checked === 0 ? 'none checked' : percent(tally.accuracy);
  return evals.map((saved) => {
    // Scores from before the taxonomy, or of a golden set without it, say nothing of it.
    const taxonomy = saved.scores.taxonomy;
    const placed =
      taxonomy === undefined
        ? ''
        : `  shelf ${accuracy(taxonomy.shelf)}  functions precision ${percent(taxonomy.functions.precision)} recall ${percent(taxonomy.functions.recall)}`;
    return `${saved.createdAt}  generation ${saved.generation}  golden v${saved.goldenVersion}  precision ${percent(saved.scores.precision)}  recall ${percent(saved.scores.recall)}  identifiers ${accuracy(saved.scores.identifiers)}  key specs ${accuracy(saved.scores.keySpecs)}${placed}`;
  });
}

/*
 * A terminal obeys some characters: escape sequences recolor and rewrite the screen, retitle the
 * window, write to the clipboard, and hide where a link goes, bidi controls reorder the text the
 * eye reads, and a line or paragraph separator breaks a line in two wherever a display honors it.
 * Spatula's messages can quote what a site wrote, so these are the characters it never prints as
 * they are:
 *   - the C0 controls (tab and newline too), DEL, and the C1 controls;
 *   - the Bidi_Control characters: U+061C, U+200E, U+200F, U+202A to U+202E, and U+2066 to U+2069;
 *   - the line and paragraph separators, U+2028 and U+2029.
 * The zero-width characters (U+200B to U+200D, U+FEFF) can't drive a terminal or reorder a line, so
 * they stay as they are.
 */
const DRIVES_A_TERMINAL =
  /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{61c}\u{200e}\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;

/** The text with each of those characters spelled out in its place, as \u{1b} for escape. */
export function printable(text: string): string {
  return text.replace(DRIVES_A_TERMINAL, (char) => `\\u{${char.charCodeAt(0).toString(16)}}`);
}

/**
 * What went wrong, as text, whatever was thrown. An error's cause is added when it says more: fetch
 * reports a refused connection or a redirect only there. Reading what was thrown can throw too:
 * `String()` does for an object with no text form, such as one made with `Object.create(null)`, and
 * so does a message or a cause that isn't what it should be. This must never throw, so any failure
 * gives one fixed phrase.
 */
export function describeError(error: unknown): string {
  try {
    if (!(error instanceof Error)) return String(error);
    const cause = causeMessage((error as { cause?: unknown }).cause);
    const more = cause !== '' && cause !== error.message ? ` (${cause})` : '';
    return `${error.message}${more}`;
  } catch {
    return 'an error that can’t be shown as text';
  }
}

/**
 * What a cause says. A name with several addresses, such as localhost, is refused once for each
 * address, and fetch reports that as an AggregateError with an empty message and the refusals in
 * `errors`, so those are said instead, each once.
 */
function causeMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return '';
  if (cause.message !== '' || !(cause instanceof AggregateError)) return cause.message;
  const messages = cause.errors.map((inner: unknown) =>
    inner instanceof Error ? inner.message : '',
  );
  return [...new Set(messages.filter((message) => message !== ''))].join('; ');
}

/**
 * A model comparison's report (ADR 0010, spec §10): two columns, the questions a person answered
 * and the current model's sure ones. The model column has no person's answer to be wrong against,
 * so it shows a dash for "accepted wrongly" and "would go to you". "All parts right" appears only
 * for shelf placements, which carry it.
 */
export function formatComparison(report: ComparisonReport): string[] {
  const { person, model } = report.columns;
  const percent = (column: ComparisonColumn, count: number) => {
    const asked = column.questions - column.failed;
    return asked > 0 ? `${Math.round((count / asked) * 100)}%` : '—';
  };
  const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
  const rows: [string, string, string][] = [
    ['questions', String(person.questions), String(model.questions)],
    ['right / agrees', percent(person, person.right), percent(model, model.right)],
  ];
  if (person.allRight !== undefined || model.allRight !== undefined) {
    rows.push([
      'all parts right',
      percent(person, person.allRight ?? 0),
      percent(model, model.allRight ?? 0),
    ]);
  }
  rows.push(
    ['accepted wrongly', String(person.acceptedWrongly), '—'],
    ['would go to you', String(person.toPerson), '—'],
  );
  if (person.failed > 0 || model.failed > 0) {
    rows.push(['failed calls', String(person.failed), String(model.failed)]);
  }
  rows.push(['median time', seconds(person.medianMs), seconds(model.medianMs)]);
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const head = ['your answers', 'current model’s sure ones'];
  const widths = [
    Math.max(head[0]!.length, ...rows.map((row) => row[1].length)),
    Math.max(head[1]!.length, ...rows.map((row) => row[2].length)),
  ];
  const table = (label: string, one: string, two: string) =>
    `  ${label.padEnd(labelWidth)}  ${one.padStart(widths[0]!)}  ${two.padStart(widths[1]!)}`;
  const usd = person.usd + model.usd;
  const asked = person.questions + model.questions;
  const currents = [person.currentUsd, model.currentUsd].filter((one) => one !== null);
  const current =
    currents.length === 0 ? '' : `; current ${dollars(currents.reduce((a, b) => a + b, 0))}`;
  const per100 = asked > 0 ? `${dollars((usd / asked) * 100)} per 100` : '';
  const cost = `${dollars(usd)} (${per100}${current})`;
  const lines = [
    `Comparison ${report.id}: ${report.model}${report.backup === null ? '' : ` (backup ${report.backup})`} on ${report.job}, at ${report.accept}.`,
    `  ${' '.repeat(labelWidth)}  ${head[0]!.padStart(widths[0]!)}  ${head[1]!.padStart(widths[1]!)}`,
  ];
  const at = rows.findIndex(([label]) => label === 'median time');
  rows.slice(0, at).forEach(([label, one, two]) => lines.push(table(label, one, two)));
  lines.push(`  ${'cost'.padEnd(labelWidth)}  ${cost}`);
  rows.slice(at).forEach(([label, one, two]) => lines.push(table(label, one, two)));
  if (report.stoppedAtBudget) {
    lines.push(
      `Stopped at --max-usd before asking every question${report.skipped > 0 ? `: ${report.skipped} skipped` : ''}.`,
    );
  } else if (report.skipped > 0) {
    lines.push(`Skipped ${report.skipped} questions.`);
  }
  lines.push(
    report.suggestedAccept === null
      ? 'Suggested threshold: none.'
      : `Suggested threshold: ${report.suggestedAccept.toFixed(2)} (at most 1% of what it accepts disagrees with your answers).`,
  );
  if (report.disagreements.length > 0) {
    lines.push(`Where it disagreed with you (${report.disagreements.length}):`);
    for (const one of report.disagreements) {
      lines.push(
        `  ${one.subject}: it said ${one.answered} (${one.sureness.toFixed(2)}); you said ${one.expected}.`,
      );
    }
  }
  lines.push(...report.notes);
  return lines;
}
