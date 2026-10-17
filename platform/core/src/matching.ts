import type { RecordType } from './definition';
import { specLabelKey, type FieldValue } from './fields';
import { identityClaims, textKey, type IdentityClaim } from './identity';
import { similarity } from './trigrams';

/*
 * Matching (ADR 0003): which entity a page that isn't joined yet belongs to. Identifiers outrank
 * names, so a page whose identifier an entity owns joins it. A name joins too, unless both records
 * give identifiers of the same kind and none agree: then the cascade is asked, because another
 * color and another impedance both change a GTIN, and only one of them is another product. The
 * same goes for a name that several entities carry, as the versions of one model do once an answer
 * has split them: a name alone doesn't say which, so the cascade is asked about them all. A page
 * that gives only a name waits, rather than join an entity or start one, while the pages that give
 * identifiers under that name are still sorting out the entities that carry it (`contestedNames`).
 * A page that matches nothing starts its own entity, unless an entity within its scope (for
 * products, its brand) has a similar name: then the cascade is asked about the closest few first.
 * Verdicts decide: "same" joins, "not the same" keeps the page apart for good, and "unsure" waits
 * for a person. A page that is said to be the same as several entities, or as one while a question
 * about it waits, joins only the one a person chose, and otherwise waits for a person.
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
  | { kind: 'wait' }
  /** The page gives only a name, and the claim on that name is contested. */
  | { kind: 'hold'; name: string }
  /** The page is said to be the same as these entities, and no person chose one of them. */
  | { kind: 'dispute'; entityIds: string[] };

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

/**
 * The words that make a claim on a name, as the record wrote them, such as its brand and name. Null
 * where the claim isn't one of the record type's keys, or the record lacks one of its values.
 */
export function claimLabel(
  recordType: RecordType,
  values: Record<string, FieldValue[]>,
  claim: string,
): string | null {
  const index = /^key(\d+):/u.exec(claim)?.[1];
  const fields = index === undefined ? undefined : recordType.identity.keys[Number(index)];
  if (fields === undefined) return null;
  const parts = fields.map((field) => textOf(values[field]?.[0]) ?? '');
  return parts.some((part) => part === '') ? null : parts.join(' ');
}

/**
 * The names whose entities aren't settled, as the claims that make them. A name is contested while
 * the pages that give identifiers under it and aren't joined yet give some that disagree with each
 * other, or with the entity that owns the name, compared as `planMatch` compares a page with an
 * entity; and while a page that carries it waits for a person to say whether it is that entity's.
 * A page that gives only a name can't tell which entity it belongs to, or whether it starts one,
 * until the contest settles.
 */
export function contestedNames(input: {
  recordType: RecordType;
  /** The pages that aren't joined yet: their surviving values, and the verdicts given on them. */
  pages: readonly {
    values: Record<string, FieldValue[]>;
    verdicts: ReadonlyMap<string, MatchVerdict>;
  }[];
  /** Which entity owns each identity claim. */
  owners: ReadonlyMap<string, string>;
  /** The identifiers each entity's pages give, by entity. */
  identifiers: ReadonlyMap<string, Record<string, FieldValue[]>>;
}): Set<string> {
  const { recordType, owners } = input;
  const contested = new Set<string>();
  // The identifiers pages give under each name, one record for each distinct set.
  const given = new Map<string, Map<string, Record<string, FieldValue[]>>>();
  for (const { values, verdicts } of input.pages) {
    const signature = identifierSignature(recordType, values);
    for (const claim of identityClaims(recordType, values)) {
      if (claim.rank < recordType.identity.identifiers.length) continue;
      const owner = owners.get(claim.value);
      if (owner !== undefined && verdicts.get(owner) === 'unsure') contested.add(claim.value);
      if (signature === null) continue;
      const sets = given.get(claim.value) ?? new Map<string, Record<string, FieldValue[]>>();
      sets.set(signature, values);
      given.set(claim.value, sets);
    }
  }
  for (const [name, sets] of given) {
    if (contested.has(name)) continue;
    const owner = owners.get(name);
    const theirs = owner === undefined ? undefined : input.identifiers.get(owner);
    if (
      anyDisagree(
        recordType,
        theirs === undefined ? [...sets.values()] : [theirs, ...sets.values()],
      )
    ) {
      contested.add(name);
    }
  }
  return contested;
}

/** Whether any two of the records give identifiers that disagree. */
function anyDisagree(recordType: RecordType, records: readonly Record<string, FieldValue[]>[]) {
  return records.some((record, index) =>
    records.slice(index + 1).some((other) => identifiersDisagree(recordType, record, other)),
  );
}

/**
 * The identifiers a record gives, as `identifiersDisagree` compares them, or null where it gives
 * none. Records with one signature compare alike with any other record.
 */
function identifierSignature(
  recordType: RecordType,
  values: Record<string, FieldValue[]>,
): string | null {
  const kinds = recordType.identity.identifiers.map((name) =>
    [...new Set((values[name] ?? []).map(identifierKey))].sort(),
  );
  return kinds.every((keys) => keys.length === 0) ? null : JSON.stringify(kinds);
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
  /** The entities a person gave a verdict about on this page. */
  byPerson: ReadonlySet<string>;
  /** The names that are contested, by the claims that make them (see `contestedNames`). */
  contested: ReadonlySet<string>;
}): MatchPlan {
  const { recordType, values, owners, verdicts } = input;
  const claims = identityClaims(recordType, values);
  if (claims.length === 0) return { kind: 'unresolvable' };
  const keyRank = recordType.identity.identifiers.length;
  const given = (verdict: MatchVerdict) =>
    [...verdicts]
      .filter(([, answer]) => answer === verdict)
      .map(([entityId]) => entityId)
      .sort();
  const apart = new Set(given('not_same'));
  const pending = new Set(given('unsure'));
  // "Same" is final, and the page joins the entity, when it is the only one and nothing else about
  // the page waits for a person. A person's "same" settles it whatever else is said. Several
  // decisions that the page is the same as entities that were kept apart contradict each other, and
  // so does one beside a question that waits: a person says which.
  const same = given('same');
  const chosen = same.filter((entityId) => input.byPerson.has(entityId));
  if (chosen.length === 1) return { kind: 'join', entityId: chosen[0]! };
  if (same.length === 1 && pending.size === 0) return { kind: 'join', entityId: same[0]! };
  if (same.length > 1) return { kind: 'dispute', entityIds: same };
  if (same.length === 1) return { kind: 'wait' };
  // A page that gives only a name can't say which entity it belongs to, or whether it starts one,
  // while the pages that give identifiers under that name are sorting out the entities that carry
  // it. It waits whatever it would do: joining, starting an entity, or asking about the others.
  const contested = claims.find((claim) => input.contested.has(claim.value));
  if (contested !== undefined && claims.every((claim) => claim.rank >= keyRank)) {
    // One that waits for a person already is not held for the contest.
    return pending.size > 0 ? { kind: 'wait' } : { kind: 'hold', name: contested.value };
  }

  // The strongest claim an entity owns, unless a verdict keeps the page apart from that entity.
  const strongest = [...claims]
    .sort((a, b) => a.rank - b.rank)
    .map((claim) => ({ claim, entityId: owners.get(claim.value) }))
    .find(
      (owned): owned is { claim: IdentityClaim; entityId: string } =>
        owned.entityId !== undefined && !apart.has(owned.entityId),
    );
  if (strongest !== undefined) {
    const owner = strongest.entityId;
    if (pending.has(owner)) return { kind: 'wait' };
    if (strongest.claim.rank < keyRank) return { kind: 'join', entityId: owner };
    // A name belongs to whichever entity claimed it first, but others may carry it too: a "variant"
    // answer splits a version off with the name it shares. The page could be any of them.
    const sharing = sharingName(recordType, values, input.sameScope).filter(
      (entityId) => entityId !== owner && !apart.has(entityId),
    );
    if (sharing.length > 0) {
      const asked = [owner, ...sharing].slice(0, MAX_MATCH_CANDIDATES);
      return asked.some((entityId) => pending.has(entityId))
        ? { kind: 'wait' }
        : { kind: 'ask', entityIds: asked };
    }
    if (identifiersDisagree(recordType, values, input.identifiers.get(owner) ?? {})) {
      return { kind: 'ask', entityIds: [owner] };
    }
    return { kind: 'join', entityId: owner };
  }

  const similar = similarNames(recordType, values, input.sameScope, apart);
  if (similar.some((entityId) => pending.has(entityId))) return { kind: 'wait' };
  return similar.length === 0 ? { kind: 'create' } : { kind: 'ask', entityIds: similar };
}

/** The entities within the page's scope with a page named as it is, by their IDs. */
function sharingName(
  recordType: RecordType,
  values: Record<string, FieldValue[]>,
  sameScope: readonly { id: string; names: readonly string[] }[],
): string[] {
  const own = nameScope(recordType, values);
  if (own === null) return [];
  const key = textKey(own.name);
  return sameScope
    .filter(({ names }) => names.some((name) => textKey(name) === key))
    .map(({ id }) => id)
    .sort();
}

/**
 * The entities within the page's scope whose names are most like its own, closest first, leaving
 * out those already judged not the same: the closest few that remain, so that judging three apart
 * brings the fourth.
 */
function similarNames(
  recordType: RecordType,
  values: Record<string, FieldValue[]>,
  sameScope: readonly { id: string; names: readonly string[] }[],
  apart: ReadonlySet<string>,
): string[] {
  const own = nameScope(recordType, values);
  if (own === null) return [];
  return sameScope
    .filter(({ id }) => !apart.has(id))
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
