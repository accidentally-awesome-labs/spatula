/*
 * Trigram similarity, as Postgres's pg_trgm measures it: the share of three-character runs two
 * texts have in common. Each word is lowercased and padded with two spaces in front and one behind,
 * so short words still count and the starts of words weigh more. It can differ from pg_trgm on
 * superscript digits, combining vowel signs, U+0130 (İ), final sigma, and characters outside the
 * Basic Multilingual Plane. Crowdio's catalog sync uses the same function.
 */

function trigrams(text: string): Set<string> {
  const runs = new Set<string>();
  for (const word of text.toLocaleLowerCase('en-US').split(/[^\p{L}\p{N}]+/u)) {
    if (word === '') continue;
    const padded = `  ${word} `;
    for (let index = 0; index + 3 <= padded.length; index += 1) {
      runs.add(padded.slice(index, index + 3));
    }
  }
  return runs;
}

/** How alike two texts are, from 0 to 1. */
export function similarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const run of left) if (right.has(run)) shared += 1;
  return shared / (left.size + right.size - shared);
}
