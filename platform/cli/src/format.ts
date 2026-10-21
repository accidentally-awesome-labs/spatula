import {
  EVAL_TARGETS,
  REFUSE_AFTER_RUNS,
  reviewAnswers,
  type ApplySummary,
  type DatasetStatus,
  type EvalScores,
  type EvalView,
  type GoldenSet,
  type ReviewView,
  type RunView,
  type Tally,
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
  const irrelevant = summary.irrelevant ?? 0;
  if (irrelevant > 0) {
    lines.push(
      `Not the dataset’s: ${irrelevant} ${irrelevant === 1 ? 'page' : 'pages'}, out until revived.`,
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
  if (summary.notes.length > 0) lines.push('Notes:', ...summary.notes.map((note) => `  ${note}`));
  return lines;
}

/** The open questions, each with what it proposes and the answers it takes. */
export function formatReviews(datasetId: string, reviews: ReviewView[]): string[] {
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
    // A match question asked before the relationships takes them too (ADR 0003).
    lines.push(`  Answers: ${reviewAnswers(review.kind, review.question).join(' | ')}`);
  }
  lines.push('', `Answer with: spatula review ${datasetId} <id> "<answer>"`);
  return lines;
}

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
  for (const [label, tally, met, target] of [
    ['Identifiers', scores.identifiers, scores.targets.identifiers, EVAL_TARGETS.identifiers],
    ['Key specs', scores.keySpecs, scores.targets.keySpecs, EVAL_TARGETS.keySpecs],
  ] as const) {
    const left = tally.missing === 0 ? '' : `, ${tally.missing} left out`;
    lines.push(
      tally.checked === 0
        ? `${label}: none checked${left}${tally.missing === 0 ? '' : ': not met'}.`
        : `${label}: ${percent(tally.accuracy)} of ${tally.checked} stated${left} (target ${target * 100}%): ${verdict(met)}.`,
    );
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
  return evals.map(
    (saved) =>
      `${saved.createdAt}  generation ${saved.generation}  golden v${saved.goldenVersion}  precision ${percent(saved.scores.precision)}  recall ${percent(saved.scores.recall)}  identifiers ${accuracy(saved.scores.identifiers)}  key specs ${accuracy(saved.scores.keySpecs)}`,
  );
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
