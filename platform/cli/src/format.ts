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
  lines.push(
    `Pages: ${summary.items}. Changed ${fetches.changed}, unchanged ${fetches.unchanged}, gone ${fetches.gone}, failed ${fetches.failed}, blocked ${fetches.blocked}.`,
    `Statements: ${statements.added} added, ${statements.reseen} seen again, ${statements.withdrawn} withdrawn.`,
    `LLM: ran ${llm.ran}, reused ${llm.reused}, skipped ${llm.skipped}, failed ${llm.failed}; ${llm.inputTokens} tokens in, ${llm.outputTokens} out.`,
    `Entities: ${entities.created} new, ${entities.linked} linked, ${entities.conflicts} conflicts, ${entities.unresolved} without an identity yet.`,
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
 * window, write to the clipboard, and hide where a link goes, and bidi controls reorder the text
 * the eye reads. Spatula's messages can quote what a site wrote, so these are the characters it
 * never prints as they are: every C0 control (tab and newline too), DEL, every C1 control, and the
 * bidi embeddings, overrides, and isolates.
 */
const DRIVES_A_TERMINAL = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;

/** The text with each of those characters spelled out in its place, as \u{1b} for escape. */
export function printable(text: string): string {
  return text.replace(DRIVES_A_TERMINAL, (char) => `\\u{${char.charCodeAt(0).toString(16)}}`);
}
