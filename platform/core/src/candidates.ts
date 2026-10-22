import type { RecordType, Rule, Source } from './definition';
import { normalizeValue } from './fields';
import type { RecordTypePack } from './pack';
import type { Page } from './page';
import type { Candidate, Method, StatementInput } from './statements';

/*
 * Turns a page into one item's statements. For each field, a source either fixes the value or
 * declares how to find it (a CSS rule, or the page's own address), and that replaces whatever
 * the pack would read for the field: a rule a person wrote beats a guess, and if the rule finds
 * nothing the field is missing rather than wrong. The pack reads the other fields from structured
 * data. Every value is normalized against its field; one that doesn't normalize is rejected, with
 * the reason.
 */

/** Bump when extraction code changes what it finds, so stored pages are read again. */
export const EXTRACTION_VERSION = 2;

/** The methods a page's extraction speaks for: their statements that aren't found again are withdrawn. */
export const PAGE_METHODS: readonly Method[] = ['jsonld', 'opengraph', 'rule'];

const FIXED = 1;
const DECLARED_RULE = 0.9;

export interface PageExtraction {
  statements: StatementInput[];
  rejected: { property: string; path: string; reason: string }[];
  /** The record type's fields that this page gave no value for. */
  missing: string[];
}

export function extractFromPage(input: {
  page: Page;
  source: Source;
  recordType: RecordType;
  pack: RecordTypePack | null;
}): PageExtraction {
  const { page, source, recordType, pack } = input;
  const declared = new Set([...Object.keys(source.fixed), ...Object.keys(source.extract)]);
  let candidates: Candidate[] = [];
  for (const [property, value] of Object.entries(source.fixed)) {
    const values = recordType.fields[property]?.list && Array.isArray(value) ? value : [value];
    for (const raw of values)
      candidates.push({ property, raw, method: 'rule', path: 'fixed', confidence: FIXED });
  }
  for (const [property, rule] of Object.entries(source.extract)) {
    const raw = applyRule(page, rule);
    if (raw !== null) {
      candidates.push({
        property,
        raw,
        method: 'rule',
        path: ruleLabel(rule),
        confidence: DECLARED_RULE,
      });
    }
  }
  if (pack !== null) {
    candidates.push(
      ...pack
        .extract(page)
        .filter((c) => !declared.has(c.property) && c.property in recordType.fields),
    );
    if (pack.finish) candidates = pack.finish(candidates);
  }
  return normalizeCandidates(candidates, recordType);
}

/** Candidates as statements: normalized, one per value and method, list values numbered in order. */
export function normalizeCandidates(
  candidates: Candidate[],
  recordType: RecordType,
): PageExtraction {
  const statements: StatementInput[] = [];
  const rejected: PageExtraction['rejected'] = [];
  const seen = new Set<string>();
  const positions = new Map<string, number>();
  for (const candidate of candidates) {
    const field = recordType.fields[candidate.property];
    if (field === undefined) continue;
    const normalized = normalizeValue(field, candidate.raw);
    if (!normalized.ok) {
      rejected.push({
        property: candidate.property,
        path: candidate.path,
        reason: normalized.reason,
      });
      continue;
    }
    const identity = `${candidate.property}\u0000${candidate.method}\u0000${normalized.key}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    let position: number | null = null;
    if (field.list) {
      position = positions.get(candidate.property) ?? 0;
      positions.set(candidate.property, position + 1);
    }
    statements.push({
      property: candidate.property,
      value: normalized.value,
      valueKey: normalized.key,
      original: typeof candidate.raw === 'string' ? candidate.raw : JSON.stringify(candidate.raw),
      method: candidate.method,
      path: candidate.path,
      confidence: candidate.confidence,
      position,
    });
  }
  const found = new Set(statements.map((statement) => statement.property));
  return {
    statements,
    rejected,
    missing: Object.keys(recordType.fields).filter((name) => !found.has(name)),
  };
}

/** The text a source's rule finds on a page: its canonical address, or a selector's text. */
export function applyRule(page: Page, rule: Rule): string | null {
  return 'url' in rule ? page.canonicalUrl : page.select(rule.css, rule.attr);
}

function ruleLabel(rule: Rule): string {
  return 'url' in rule
    ? 'canonical'
    : `css:${rule.css}${rule.attr === undefined ? '' : `@${rule.attr}`}`;
}
