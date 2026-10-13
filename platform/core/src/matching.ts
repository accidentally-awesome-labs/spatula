import type { RecordType } from './definition';
import { specLabelKey, type FieldValue } from './fields';
import { identityClaims, textKey, type IdentityClaim } from './identity';
import { similarity } from './trigrams';

/*
 * Matching (ADR 0003): which entity a page that isn't joined yet belongs to. Identifiers outrank
 * names, so a page whose identifier an entity owns joins it. A name joins too, unless both records
 * give identifiers of the same kind and none agree: then the cascade is asked, because another
 * color and another impedance both change a GTIN, and only one of them is another product. A page
 * that matches nothing starts its own entity, unless an entity within its scope (for products, its
 * brand) has a similar name: then the cascade is asked about the closest few first. Verdicts
 * decide: "same" joins, "not the same" keeps the page apart for good, and "unsure" waits for a
 * person.
 */

/** How alike two names must be, by trigrams, for the cascade to be asked whether they're one. */
export const MATCH_SIMILARITY = 0.6;
/** The most entities one page is asked about at once: those with the closest names. */
export const MAX_MATCH_CANDIDATES = 3;
/** The most match questions one run asks. The rest wait for the next run. */
export const MAX_MATCH_QUESTIONS = 100;

/** What "same" means when a record type's pack doesn't say. */
export const GENERIC_MATCH_CRITERIA = [
  'same: the two records describe the same thing.',
  'variant: a version of the same thing that differs in a specification.',
  'different: different things.',
].join('\n');

export type MatchVerdict = 'same' | 'not_same' | 'unsure';

export type MatchPlan =
  | { kind: 'unresolvable' }
  | { kind: 'join'; entityId: string }
  | { kind: 'create' }
  | { kind: 'ask'; entityIds: string[] }
  | { kind: 'wait' };

/**
 * A record's name, and the scope it's compared within: the record type's first key of two or more
 * fields, such as brand and name. Null when there's no such key, or the record lacks its values.
 */
export function nameScope(
  recordType: RecordType,
  values: Record<string, FieldValue[]>,
): { scope: string; name: string } | null {
  const key = recordType.identity.keys.find((fields) => fields.length >= 2);
  if (key === undefined) return null;
  const name = textOf(values[key[key.length - 1]!]?.[0]);
  const scope = key.slice(0, -1).map((field) => textKey(textOf(values[field]?.[0]) ?? ''));
  if (name === null || scope.some((part) => part === '')) return null;
  return { scope: scope.join('|'), name };
}

/** Whether two records give identifiers of the same kind and none of their identifiers agree. */
export function identifiersDisagree(
  recordType: RecordType,
  a: Record<string, FieldValue[]>,
  b: Record<string, FieldValue[]>,
): boolean {
  let disagree = false;
  for (const name of recordType.identity.identifiers) {
    const left = new Set((a[name] ?? []).map(identifierKey));
    const right = (b[name] ?? []).map(identifierKey);
    if (left.size === 0 || right.length === 0) continue;
    if (right.some((key) => left.has(key))) return false;
    disagree = true;
  }
  return disagree;
}

/** Adds values to a record's, each once: what an entity's pages say together. */
export function mergeValues(
  into: Record<string, FieldValue[]>,
  values: Record<string, FieldValue[]>,
): void {
  for (const [name, list] of Object.entries(values)) {
    const kept = (into[name] ??= []);
    const seen = new Set(kept.map(valueKeyOf));
    for (const value of list) {
      const key = valueKeyOf(value);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(value);
    }
  }
}

/** What to do with a page that isn't joined yet. */
export function planMatch(input: {
  recordType: RecordType;
  /** The page's surviving values, by field. */
  values: Record<string, FieldValue[]>;
  /** Which entity owns each identity claim. */
  owners: ReadonlyMap<string, string>;
  /** The identifiers each entity's pages give, by entity. */
  identifiers: ReadonlyMap<string, Record<string, FieldValue[]>>;
  /** The entities within the page's scope, with their pages' names. */
  sameScope: readonly { id: string; names: readonly string[] }[];
  /** The verdicts already given on this page, by entity. */
  verdicts: ReadonlyMap<string, MatchVerdict>;
}): MatchPlan {
  const { recordType, values, owners, verdicts } = input;
  const claims = identityClaims(recordType, values);
  if (claims.length === 0) return { kind: 'unresolvable' };
  const given = (verdict: MatchVerdict) =>
    [...verdicts]
      .filter(([, answer]) => answer === verdict)
      .map(([entityId]) => entityId)
      .sort();
  // "Same" is final, and transitive: the page joins the entity.
  const [same] = given('same');
  if (same !== undefined) return { kind: 'join', entityId: same };
  const apart = new Set(given('not_same'));
  const pending = new Set(given('unsure'));

  // The strongest claim an entity owns, unless a verdict keeps the page apart from that entity.
  const strongest = [...claims]
    .sort((a, b) => a.rank - b.rank)
    .map((claim) => ({ claim, entityId: owners.get(claim.value) }))
    .find(
      (owned): owned is { claim: IdentityClaim; entityId: string } =>
        owned.entityId !== undefined && !apart.has(owned.entityId),
    );
  if (strongest !== undefined) {
    if (pending.has(strongest.entityId)) return { kind: 'wait' };
    const byIdentifier = strongest.claim.rank < recordType.identity.identifiers.length;
    const theirs = input.identifiers.get(strongest.entityId) ?? {};
    if (byIdentifier || !identifiersDisagree(recordType, values, theirs)) {
      return { kind: 'join', entityId: strongest.entityId };
    }
    return { kind: 'ask', entityIds: [strongest.entityId] };
  }

  const similar = similarNames(recordType, values, input.sameScope).filter(
    (entityId) => !apart.has(entityId),
  );
  if (similar.some((entityId) => pending.has(entityId))) return { kind: 'wait' };
  return similar.length === 0 ? { kind: 'create' } : { kind: 'ask', entityIds: similar };
}

/** The entities within the page's scope whose names are most like its own, closest first. */
function similarNames(
  recordType: RecordType,
  values: Record<string, FieldValue[]>,
  sameScope: readonly { id: string; names: readonly string[] }[],
): string[] {
  const own = nameScope(recordType, values);
  if (own === null) return [];
  return sameScope
    .map(({ id, names }) => ({
      id,
      score: names.reduce((best, name) => Math.max(best, similarity(own.name, name)), 0),
    }))
    .filter(({ score }) => score >= MATCH_SIMILARITY)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_MATCH_CANDIDATES)
    .map(({ id }) => id);
}

function identifierKey(value: FieldValue): string {
  return textKey(textOf(value) ?? '');
}

function valueKeyOf(value: FieldValue): string {
  return typeof value === 'string' ? value : `${specLabelKey(value.label)}\u001f${value.value}`;
}

function textOf(value: FieldValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
