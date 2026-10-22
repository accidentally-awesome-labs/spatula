import { z } from 'zod';

/**
 * A person's note on an answer or a decision, as the review API takes it. It's kept as text, and in
 * the log's jsonb, which refuses U+0000 and a lone surrogate: a note holding one is the caller's
 * mistake, so it's refused with a 400, not stored.
 */
export const noteSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine(
    (note) => note.isWellFormed() && !note.includes('\u0000'),
    'A note can’t hold U+0000 or a lone surrogate.',
  );

/** The most code units of a stored message: a note, a reason, or a failed run's error. */
const MAX_STORED_TEXT = 500;

/**
 * Text that Postgres will take. A message can carry an exception's text, and exceptions can quote
 * their input; a reason can quote what a site sent, such as the Location of a redirect or the name
 * of a sitemap's root element. Postgres refuses U+0000 in text, and jsonb refuses it and a lone
 * surrogate too. The run summary is jsonb and the last step writes it, so one bad character would
 * fail a run that had otherwise finished, and a fetch that can't be logged fails its step. The text
 * is cut before it is made well formed, which also repairs a pair that the cut split.
 *
 * A caller that quotes a site's words can cut them shorter first, with `limit`, so that the rest of
 * its message survives the cut that follows.
 */
export function storable(text: string, limit = MAX_STORED_TEXT): string {
  return text.replaceAll('\u0000', '').slice(0, limit).toWellFormed();
}
