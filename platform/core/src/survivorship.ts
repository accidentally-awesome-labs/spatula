import type { RecordType } from './definition';
import { specLabelKey, type FieldDef, type FieldValue, type Spec } from './fields';
import type { Method } from './statements';

/*
 * Survivorship: each record's value for a field, chosen from its current statements, with the
 * statement that explains it. A person's word beats a declared rule, which beats an API or feed,
 * then structured data, then a page title, then the LLM. Among equals, the most recently seen
 * wins. Identifiers and other lists combine every current value; specs keep one value per label.
 * A statement whose value doesn't have the shape its field's type takes is passed over.
 */

export const METHOD_RANK: Readonly<Record<Method, number>> = {
  human: 7,
  rule: 6,
  api: 5,
  feed: 4,
  jsonld: 3,
  microdata: 2,
  opengraph: 1,
  llm: 0,
};

/** A current statement, as survivorship and snapshots see it. */
export interface StatementView {
  property: string;
  value: FieldValue;
  valueKey: string;
  method: Method;
  confidence: number;
  /** When a fetch last found it, as an ISO time. */
  lastSeen: string;
  sourceUrl: string;
  position: number | null;
}

export interface Provenance {
  sourceUrl: string;
  fetchedAt: string;
  method: Method;
  confidence: number;
}

export interface FieldResult {
  values: FieldValue[];
  provenance: Provenance;
}

/**
 * Orders statements best first: method, then most recently seen, then confidence. Ties go by the
 * value, then the address of the page that said it, then its position, so the order never depends
 * on the order the statements were read in, and a snapshot doesn't change when only that does.
 */
export function compareStatements(a: StatementView, b: StatementView): number {
  return (
    METHOD_RANK[b.method] - METHOD_RANK[a.method] ||
    compareText(b.lastSeen, a.lastSeen) ||
    b.confidence - a.confidence ||
    compareText(a.valueKey, b.valueKey) ||
    compareText(a.sourceUrl, b.sourceUrl) ||
    (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER)
  );
}

/** Each field's surviving values. Fields without statements are left out. */
export function survive(
  recordType: RecordType,
  statements: StatementView[],
): Map<string, FieldResult> {
  const results = new Map<string, FieldResult>();
  for (const [name, field] of Object.entries(recordType.fields)) {
    const own = statements
      .filter((statement) => statement.property === name && fits(field, statement.value))
      .sort(compareStatements);
    const best = own[0];
    if (best === undefined) continue;
    if (!field.list) {
      results.set(name, { values: [best.value], provenance: provenanceOf(best, [best]) });
      continue;
    }
    // Best first, so the first statement for each value (or spec label) is the one that survives.
    const chosen = new Map<string, StatementView>();
    for (const statement of own) {
      const key =
        field.type === 'specs' ? specLabelKey((statement.value as Spec).label) : statement.valueKey;
      if (!chosen.has(key)) chosen.set(key, statement);
    }
    const kept = [...chosen.values()].sort(inPageOrder);
    results.set(name, {
      values: kept.map((statement) => statement.value),
      provenance: provenanceOf(best, kept),
    });
  }
  return results;
}

/** Each field's surviving values, by name: what a record says, without the statements behind it. */
export function survivingValues(
  recordType: RecordType,
  statements: StatementView[],
): Record<string, FieldValue[]> {
  const values: Record<string, FieldValue[]> = {};
  for (const [name, field] of survive(recordType, statements)) values[name] = field.values;
  return values;
}

/**
 * Whether a stored value has the shape its field's type takes now: text for text, enum, gtin, and
 * url fields, and a label with a value for specs. When a definition changes a field's type, the
 * statements made under the old one stay current until their page is read again, which a failed
 * or blocked fetch can put off.
 */
function fits(field: FieldDef, value: unknown): boolean {
  if (field.type !== 'specs') return typeof value === 'string';
  return (
    typeof value === 'object' &&
    value !== null &&
    'label' in value &&
    'value' in value &&
    typeof value.label === 'string' &&
    typeof value.value === 'string'
  );
}

/** A list's order: trusted methods first, then the page's own order. */
function inPageOrder(a: StatementView, b: StatementView): number {
  return (
    METHOD_RANK[b.method] - METHOD_RANK[a.method] ||
    (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
    compareText(a.valueKey, b.valueKey)
  );
}

/**
 * A field's provenance: where its best statement came from, and the lowest confidence among the
 * statements kept for it. A snapshot gives a taxonomy's fields theirs the same way (ADR 0007).
 */
export function provenanceOf(best: StatementView, kept: readonly StatementView[]): Provenance {
  // Reduced rather than spread into Math.min(...), which throws a RangeError on very long lists.
  return {
    sourceUrl: best.sourceUrl,
    fetchedAt: best.lastSeen,
    method: best.method,
    confidence: kept.reduce(
      (lowest, statement) => Math.min(lowest, statement.confidence),
      Number.POSITIVE_INFINITY,
    ),
  };
}

/** Compares by code unit, the same in every runtime, unlike localeCompare. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
