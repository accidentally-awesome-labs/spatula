import type { FieldValue } from './fields';

/*
 * Statements: "item S says property P = V". Extraction proposes candidates. Only those that
 * normalize become statements, each with how it was found (its method), where (its path), and
 * how far to trust it (its confidence).
 */

export const METHODS = [
  'jsonld',
  'microdata',
  'opengraph',
  'rule',
  'llm',
  'api',
  'feed',
  'human',
] as const;
export type Method = (typeof METHODS)[number];

/** A value found on a page, before it's normalized against its field. */
export interface Candidate {
  property: string;
  raw: unknown;
  method: Method;
  /** Where it was found, such as `jsonld[1].mpn`, `og:title`, `css:h1`, or `fixed`. */
  path: string;
  confidence: number;
}

/** A normalized value, ready to store as a statement. */
export interface StatementInput {
  property: string;
  value: FieldValue;
  /** What makes two values the same value (see `normalizeValue`). */
  valueKey: string;
  /** The value as the source wrote it. */
  original: string;
  method: Method;
  path: string;
  confidence: number;
  /** Its place among a list field's values on the page; `null` for single values. */
  position: number | null;
}
