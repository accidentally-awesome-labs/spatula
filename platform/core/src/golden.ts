import { z } from 'zod';
import { specLabelKey } from './fields';
import { normalizeGtin } from './gtin';
import { textKey } from './identity';
import type { Snapshot } from './snapshot';

/*
 * The golden set (ADR 0004): products a person checked against sources Spatula doesn't read, and a
 * dataset's score against them. Each golden product names the pages Spatula reads for it, which is
 * how its record is found. Precision asks whether a record ever mixes golden products; recall,
 * whether each has a published record; accuracy, whether the values the record states are the
 * golden ones. A golden value the record leaves out is coverage, not an error: it is counted apart,
 * as missing, and a target is not met on values that were all left out.
 *
 * Text compares by its key (case, spaces, and punctuation ignored, plus signs kept), a GTIN as its
 * 14 digits, and a list is right when every value the record states is in the golden list. Key
 * specs compare by value, under a label that contains the golden label or is contained by it,
 * because specs' labels differ from one sheet to the next while their values don't (ruling 13).
 */

/** Crowdio's ADR 0021 targets for products. */
export const EVAL_TARGETS = { precision: 0.99, recall: 0.9, identifiers: 0.98, keySpecs: 0.98 };
/** At most this many misses are listed, and then how many more there were. */
const MAX_MISSES = 200;

const httpsUrl = z
  .string()
  .trim()
  .refine((value) => URL.canParse(value) && new URL(value).protocol === 'https:', {
    message: 'Use an https:// address.',
  });
const specSchema = z.strictObject({
  label: z.string().trim().min(1).max(60),
  value: z.string().min(1).max(200),
});

export const goldenSetSchema = z
  .strictObject({
    dataset: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u),
    // Kept with each score in a Postgres integer, so nine digits at most.
    version: z.number().int().min(1).max(999_999_999),
    /** When a person last checked it all. */
    checked: z.iso.date(),
    /** The fields scored together against the identifiers target. */
    identifiers: z.array(z.string().min(1)).max(10),
    /** The field of key specifications, scored against the key specs target. */
    specs: z.string().min(1).optional(),
    products: z
      .array(
        z.strictObject({
          key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/u),
          pages: z.array(httpsUrl).min(1).max(10),
          fields: z.record(
            z.string(),
            z.union([
              z.string().min(1).max(500),
              z.array(z.string().min(1).max(500)).max(50),
              z.array(specSchema).max(100),
            ]),
          ),
          /** Where the person checked the values. */
          checkedAgainst: z.array(httpsUrl).min(1).max(10),
        }),
      )
      .min(1)
      .max(1000),
  })
  .superRefine((golden, ctx) => {
    const seen = new Set<string>();
    for (const [index, product] of golden.products.entries()) {
      if (seen.has(product.key)) {
        ctx.addIssue({
          code: 'custom',
          message: 'This product is listed twice.',
          path: ['products', index, 'key'],
        });
      }
      seen.add(product.key);
    }
  });

export type GoldenSet = z.output<typeof goldenSetSchema>;

/** An item as the API lists it. */
export interface ItemView {
  locator: string;
  sourceId: string;
  status: string;
  entityId: string | null;
}

export interface Tally {
  /** Golden values the records state, right or wrong. */
  checked: number;
  correct: number;
  /** Golden values the record leaves out: reported as coverage, not counted as wrong. */
  missing: number;
  /** The share of the checked values that are right; 1 when none is checked. */
  accuracy: number;
}

export interface EvalScores {
  generation: number;
  products: number;
  /** Golden products with a published record. */
  found: number;
  recall: number;
  /** The share of records with a golden product's page that hold one golden product only. */
  precision: number;
  /** Golden products spread over more than one record. */
  split: number;
  fields: Record<string, Tally>;
  identifiers: Tally;
  keySpecs: Tally;
  targets: { precision: boolean; recall: boolean; identifiers: boolean; keySpecs: boolean };
  /**
   * The merges of golden products into one record, then the products' misses: the first 200 of
   * them, and a last line saying how many more there were, if any.
   */
  misses: string[];
}

type Spec = { label: string; value: string };
type Counts = { checked: number; correct: number; missing: number };

export function scoreDataset(input: {
  golden: GoldenSet;
  snapshot: Snapshot;
  items: readonly ItemView[];
}): EvalScores {
  const { golden, snapshot, items } = input;
  // Every item's page tells a page nobody lists from one with no record. Only a live item that
  // joined an entity can lead to a record.
  const itemPages = new Set<string>();
  const entityOf = new Map<string, string>();
  for (const item of items) {
    itemPages.add(href(item.locator));
    if (item.status === 'live' && item.entityId !== null) {
      entityOf.set(href(item.locator), item.entityId);
    }
  }
  const records = new Map(snapshot.records.map((record) => [record.canonicalId, record]));
  const goldenOf = new Map<string, Set<string>>();
  const fields = new Map<string, Counts>();
  const identifiers: Counts = { checked: 0, correct: 0, missing: 0 };
  const keySpecs: Counts = { checked: 0, correct: 0, missing: 0 };
  const misses: string[] = [];
  let found = 0;
  let split = 0;

  for (const product of golden.products) {
    const ids = [
      ...new Set(
        product.pages.flatMap((pageUrl) => {
          const id = entityOf.get(href(pageUrl));
          return id !== undefined && records.has(id) ? [id] : [];
        }),
      ),
    ].sort();
    for (const id of ids) goldenOf.set(id, (goldenOf.get(id) ?? new Set()).add(product.key));
    if (ids.length === 0) {
      misses.push(
        product.pages.some((pageUrl) => itemPages.has(href(pageUrl)))
          ? `${product.key}: no published record`
          : `${product.key}: no item for ${product.pages.length === 1 ? 'its page' : 'any of its pages'}`,
      );
      continue;
    }
    found += 1;
    if (ids.length > 1) {
      split += 1;
      misses.push(`${product.key}: spread over ${ids.length} records`);
    }
    const record = records.get(ids[0]!)!;
    for (const [name, expected] of Object.entries(product.fields)) {
      const actual = record.fields[name];
      if (name === golden.specs) {
        const theirs = Array.isArray(actual) ? actual.filter(isSpec) : [];
        // Golden specs that aren't a list of label-and-value pairs count nothing.
        for (const spec of (Array.isArray(expected) ? expected : []).filter(isSpec)) {
          // Several of the record's labels can fit a short golden label ("Weight" is in "Shipping
          // weight"), so the one with the golden value wins, then the one with the golden label
          // itself, which is the one a miss should name, and else the first.
          const named = theirs.filter((candidate) => sameLabel(candidate.label, spec.label));
          const match =
            named.find((candidate) => textKey(candidate.value) === textKey(spec.value)) ??
            named.find((candidate) => specLabelKey(candidate.label) === specLabelKey(spec.label)) ??
            named[0];
          const right = match !== undefined && textKey(match.value) === textKey(spec.value);
          count(keySpecs, match !== undefined, right);
          if (!right) {
            misses.push(
              `${product.key}: ${name} ${spec.label} is ${match?.value ?? 'missing'}, not ${spec.value}`,
            );
          }
        }
        continue;
      }
      // A golden list that is empty, or holds no text, has nothing to check or to leave out.
      if (valueKeys(expected).length === 0) continue;
      const right = sameValue(expected, actual);
      const stated = valueKeys(actual).length > 0;
      const tally = fields.get(name) ?? { checked: 0, correct: 0, missing: 0 };
      count(tally, stated, right);
      fields.set(name, tally);
      if (golden.identifiers.includes(name)) count(identifiers, stated, right);
      if (!right)
        misses.push(`${product.key}: ${name} is ${shown(actual)}, not ${shown(expected)}`);
    }
  }
  const touching = [...goldenOf];
  const mixes = touching
    .filter(([, keys]) => keys.size > 1)
    .map(([id, keys]) => `${id} mixes ${[...keys].sort().join(', ')}`);
  const pure = touching.filter(([, keys]) => keys.size === 1).length;
  const tallied = (tally: Counts): Tally => ({
    ...tally,
    accuracy: tally.checked === 0 ? 1 : tally.correct / tally.checked,
  });
  const scores = {
    precision: touching.length === 0 ? 0 : pure / touching.length,
    recall: golden.products.length === 0 ? 0 : found / golden.products.length,
    identifiers: tallied(identifiers),
    keySpecs: tallied(keySpecs),
  };
  // A merge is what a precision failure comes from, and a run can miss more than 200 values, so the
  // merges go first and the cut takes other misses before them.
  const all = [...mixes, ...misses];
  const listed = all.slice(0, MAX_MISSES);
  if (all.length > MAX_MISSES) listed.push(`…and ${all.length - MAX_MISSES} more`);
  return {
    generation: snapshot.generation,
    products: golden.products.length,
    found,
    recall: scores.recall,
    precision: scores.precision,
    split,
    fields: Object.fromEntries([...fields].map(([name, tally]) => [name, tallied(tally)])),
    identifiers: scores.identifiers,
    keySpecs: scores.keySpecs,
    targets: {
      precision: scores.precision >= EVAL_TARGETS.precision,
      recall: scores.recall >= EVAL_TARGETS.recall,
      // Accuracy counts only what the records state, so values left out with nothing stated don't pass.
      identifiers:
        (scores.identifiers.checked > 0 || scores.identifiers.missing === 0) &&
        scores.identifiers.accuracy >= EVAL_TARGETS.identifiers,
      keySpecs:
        (scores.keySpecs.checked > 0 || scores.keySpecs.missing === 0) &&
        scores.keySpecs.accuracy >= EVAL_TARGETS.keySpecs,
    },
    misses: listed,
  };
}

/** Counts a golden value: checked when the record states it, right or wrong; missing when not. */
function count(tally: Counts, stated: boolean, right: boolean): void {
  if (!stated) {
    tally.missing += 1;
    return;
  }
  tally.checked += 1;
  if (right) tally.correct += 1;
}

function href(address: string): string {
  return URL.canParse(address) ? new URL(address).href : address;
}

function isSpec(value: unknown): value is Spec {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Spec).label === 'string' &&
    typeof (value as Spec).value === 'string'
  );
}

/** Labels match when one contains the other: "Impedance" and "Nominal impedance". */
function sameLabel(a: string, b: string): boolean {
  const left = specLabelKey(a);
  const right = specLabelKey(b);
  return left.includes(right) || right.includes(left);
}

/**
 * The key of a text value, or of each text in a list. Anything that isn't text has none. Everything
 * compares by its key, and a key that is a valid GTIN compares as its 14 digits: the golden set
 * writes a GTIN as its source does (8, 12, 13, or 14 digits), and Spatula keeps 14, so they compare
 * as GS1 compares them. A part number as long as a GTIN is a key first too, so "1234.5670" and
 * "12345670" are one part number.
 */
function valueKeys(value: unknown): string[] {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => {
      const key = textKey(entry);
      return normalizeGtin(key) ?? key;
    });
}

/**
 * Text by its key, and a GTIN as its 14 digits. A list is right when every value stated is a golden
 * one.
 */
function sameValue(expected: unknown, actual: unknown): boolean {
  const want = new Set(valueKeys(expected));
  const have = valueKeys(actual);
  return have.length > 0 && have.every((key) => want.has(key));
}

function shown(value: unknown): string {
  if (value === undefined) return 'missing';
  return Array.isArray(value) ? value.map(String).join(', ') : String(value);
}
