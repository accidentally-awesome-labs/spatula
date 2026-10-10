import type { RecordType } from './definition';
import { specLabelKey, type FieldValue, type Spec } from './fields';
import type { Method } from './statements';

/*
 * Survivorship: each record's value for a field, chosen from its current statements, with the
 * statement that explains it. A person's word beats a declared rule, which beats an API or feed,
 * then structured data, then a page title, then the LLM. Among equals, the most recently seen
 * wins. Identifiers and other lists combine every current value; specs keep one value per label.
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

/** Orders statements best first: method, then most recently seen, then confidence. */
export function compareStatements(a: StatementView, b: StatementView): number {
  return (
    METHOD_RANK[b.method] - METHOD_RANK[a.method] ||
    compareText(b.lastSeen, a.lastSeen) ||
    b.confidence - a.confidence ||
    compareText(a.valueKey, b.valueKey)
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
      .filter((statement) => statement.property === name)
      .sort(compareStatements);
    const best = own[0];
    if (best === undefined) continue;
    if (!field.list) {
      results.set(name, { values: [best.value], provenance: provenance(best, [best]) });
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
      provenance: provenance(best, kept),
    });
  }
  return results;
}

/** A list's order: trusted methods first, then the page's own order. */
function inPageOrder(a: StatementView, b: StatementView): number {
  return (
    METHOD_RANK[b.method] - METHOD_RANK[a.method] ||
    (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
    compareText(a.valueKey, b.valueKey)
  );
}

function provenance(best: StatementView, kept: StatementView[]): Provenance {
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
