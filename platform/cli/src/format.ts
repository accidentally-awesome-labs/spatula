import type { ApplySummary, RunView } from '@spatula/core';

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
  if (summary.pages.added + summary.pages.removed > 0) {
    lines.push(`Pages: ${summary.pages.added} added, ${summary.pages.removed} removed.`);
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
  // The run's notes are held to a few, and this is how a pause is seen when they ran out.
  const paused = Object.entries(summary.paused ?? {});
  if (paused.length > 0) {
    const sources = paused.map(
      ([source, left]) => `${source}, ${left} ${left === 1 ? 'page' : 'pages'} unread`,
    );
    lines.push(`Paused after blocks in a row: ${sources.join('; ')}.`);
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
  for (const left of snapshot.excluded)
    lines.push(`Left out: ${left.canonicalId}, missing ${left.missing.join(', ')}.`);
  if (summary.notes.length > 0) lines.push('Notes:', ...summary.notes.map((note) => `  ${note}`));
  return lines;
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
