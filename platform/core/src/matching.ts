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
 * that gives only a name waits, rather than join an entity or start one, while it isn't settled
 * which entities carry that name: the pages that give identifiers under it still disagree, or a
 * person has yet to say whether a page of that name is an entity's (`contestedNames`).
 * A page that matches nothing starts its own entity, unless an entity within its scope (for
 * products, its brand) has a similar name: then the cascade is asked about the closest few first.
 * Verdicts decide: "same" joins, "edition" joins as an edition, "not the same" keeps the page apart
 * for good, and "unsure" waits for a person. Below, "same" means either join. Several "same"
 * verdicts join the page to nothing, unless exactly one is a person's:
 * the page joins that entity. A decider's lone "same" beside a question that waits for a person
 * waits for that question.
 */

/** How alike two names must be, by trigrams, for the cascade to be asked whether they're one. */
export const MATCH_SIMILARITY = 0.6;
/** The most entities one page is asked about at once: those with the closest names. */
export const MAX_MATCH_CANDIDATES = 3;
/** The most match questions one run asks. The rest wait for the next run. */
export const MAX_MATCH_QUESTIONS = 100;
/** At most this many other records are shown beside a match question (its lineup). */
export const MAX_LINEUP = 10;
/** A name in a lineup is cut to this many characters. */
const LINEUP_NAME_MAX = 100;
/** A run's summary names at most this many pairs the model-number rule kept apart. */
export const RULE_PAIRS_NAMED = 10;

/** Another record in the page's scope, shown beside a match question (ADR 0003). */
export interface LineupEntry {
  /** Its name closest to the page's. */
  name: string;
  /** Whether a person kept it apart from the record the question asks about. */
  keptApart: boolean;
}

/** What each relationship means when a record type's pack doesn't say. */
export const GENERIC_MATCH_CRITERIA = [
  'same: the two records describe the same thing, listed twice.',
  'edition: the same thing in another look or packaging, with the same specifications.',
  'spec-version: the same name, but a specification differs.',
  'other-model: another model of the same line, with another number, generation, or tier.',
  'unrelated: different things.',
].join('\n');

/** A verdict on a page and an entity: "same" and "edition" join them (ADR 0003). */
export type MatchVerdict = 'same' | 'edition' | 'not_same' | 'unsure';

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
  // the page waits for a person. A person's "same" settles it whatever else is said, if it is the
  // only one a person gave. Several "same" verdicts contradict each other, as the entities were
  // kept apart: the page joins none of them. One beside a question that waits for a person waits
  // for that question.
  // An edition joins the page to the entity, as "same" does (ADR 0003).
  const same = [...new Set([...given('same'), ...given('edition')])].sort();
  const chosen = same.filter((entityId) => input.byPerson.has(entityId));
  if (chosen.length === 1) return { kind: 'join', entityId: chosen[0]! };
  if (same.length === 1 && pending.size === 0) return { kind: 'join', entityId: same[0]! };
  if (same.length > 1) return { kind: 'dispute', entityIds: same };
  if (same.length === 1) return { kind: 'wait' };
  // A page that gives only a name can't say which entity it belongs to, or whether it starts one,
  // while it isn't settled which entities carry that name: the pages that give identifiers under it
  // are sorting that out, or a person has a question to answer about a page of that name. It waits
  // whatever it would do: joining, starting an entity, or asking about the others.
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
    // A name belongs to whichever entity claimed it first, but others may carry it too: an answer
    // that keeps a version apart ("spec-version") splits it off with the name it shares. The page
    // could be any of them.
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

/**
 * A word of a name as the model-number rule reads it (ADR 0003): its text as the name writes it,
 * and the key it compares by.
 */
export interface NameWord {
  text: string;
  key: string;
}

/** The Roman numerals the rule reads as numbers, when they stand as whole words. */
const ROMAN: Readonly<Record<string, string>> = {
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
};

/**
 * A name's words: runs of letters, runs of digits, and each "+", so that "MoonRiver2" is two
 * words, "SPM1400" two, and "II+" two. A key is lowercased and without accents. The Roman numerals
 * II to IX are their numbers, "Mk" glued to one ("MkII") is two words, and "+" is "plus". So
 * "Mk II", "MkII", and "Mk 2" read alike.
 */
export function nameWords(name: string): NameWord[] {
  const words: NameWord[] = [];
  for (const [text] of name.normalize('NFC').matchAll(/[\p{L}\p{M}]+|\p{N}+|\+/gu)) {
    const key = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    const glued = /^mk(i{2,3}|iv|vi{0,3}|ix)$/u.exec(key)?.[1];
    if (glued !== undefined) {
      words.push(
        { text: text.slice(0, 2), key: 'mk' },
        { text: text.slice(2), key: ROMAN[glued]! },
      );
    } else {
      words.push({ text, key: key === '+' ? 'plus' : (ROMAN[key] ?? key) });
    }
  }
  return words;
}

/**
 * The words two names don't share, once the words they share at the start, and then those they
 * share at the end, are set aside.
 */
export function wordDifference(
  a: readonly NameWord[],
  b: readonly NameWord[],
): { onlyA: NameWord[]; onlyB: NameWord[] } {
  let start = 0;
  while (start < a.length && start < b.length && a[start]!.key === b[start]!.key) start += 1;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end]!.key === b[b.length - 1 - end]!.key
  ) {
    end += 1;
  }
  return { onlyA: a.slice(start, a.length - end), onlyB: b.slice(start, b.length - end) };
}

/** A model mark: a number (a Roman numeral from II to IX among them), "Mk", "+", or "Plus". */
function isModelMark(key: string): boolean {
  return /^\p{N}+$/u.test(key) || key === 'mk' || key === 'plus';
}

/**
 * Whether two names differ only by model marks (ADR 0003): what's left of each, once the words
 * they share at the start and at the end are set aside, is made only of model marks, and at least
 * one has something left. "Hugo 2" and "Hugo" do. "DT 990 PRO X" and "DT 990 PRO" don't, since "X"
 * can be a generation or a collaboration, and nor do two names with the same words.
 */
export function differsOnlyByModelMarks(a: string, b: string): boolean {
  const { onlyA, onlyB } = wordDifference(nameWords(a), nameWords(b));
  const left = [...onlyA, ...onlyB];
  return left.length > 0 && left.every((word) => isModelMark(word.key));
}

/** Why the model-number rule kept two records apart, as its decision records it. */
export const MODEL_NUMBER_REASON =
  'The names differ only by model numbers or marks (a number, Mk, +, or Plus), so the records are other models.';

/**
 * The record type's name field: the last field of its first key of two or more fields, such as
 * `name` in brand and name. Null where there's no such key.
 */
export function nameField(recordType: RecordType): string | null {
  const key = recordType.identity.keys.find((fields) => fields.length >= 2);
  return key === undefined ? null : key[key.length - 1]!;
}

/**
 * The model-number rule (ADR 0003), asked before any decider: `other-model` when the page and the
 * record are in one scope (for products, one brand) and the page's name differs only by model marks
 * from every name the record carries. Otherwise null, and the decider is asked. A record that
 * carries the page's name, however written, is never kept apart by the rule.
 */
export function modelNumberRule(
  recordType: RecordType,
  page: Record<string, FieldValue[]>,
  entity: Record<string, FieldValue[]>,
): 'other-model' | null {
  const own = nameScope(recordType, page);
  const theirs = nameScope(recordType, entity);
  const field = nameField(recordType);
  if (own === null || theirs === null || field === null || own.scope !== theirs.scope) return null;
  const names = (entity[field] ?? []).filter((value): value is string => typeof value === 'string');
  // `every` is true of no names at all, and a record that carries none is never kept apart.
  if (names.length === 0) return null;
  return names.every((name) => differsOnlyByModelMarks(own.name, name)) ? 'other-model' : null;
}

/**
 * A match question's lineup: the records in the page's scope other than the one asked about, each
 * by its name closest to the page's, closest first, at most 10. It is evidence, and never part of
 * the question's key, so a new record in the scope doesn't ask a settled pair again.
 */
export function lineupOf(input: {
  /** The page's name. */
  name: string;
  /** The entities in the page's scope, with their pages' names. */
  sameScope: readonly { id: string; names: readonly string[] }[];
  /** The entity the question asks about, which isn't listed. */
  entityId: string;
  /** The entities a person kept apart from that one. */
  apart: ReadonlySet<string>;
}): LineupEntry[] {
  return input.sameScope
    .filter(({ id, names }) => id !== input.entityId && names.length > 0)
    .map(({ id, names }) => {
      const [closest] = names
        .map((name) => ({ name, score: similarity(input.name, name) }))
        .sort((a, b) => b.score - a.score || compareText(a.name, b.name));
      return { id, name: closest!.name, score: closest!.score };
    })
    .sort((a, b) => b.score - a.score || compareText(a.id, b.id))
    .slice(0, MAX_LINEUP)
    .map(({ id, name }) => ({
      // Cut at whole characters, so a pair is never split.
      name: [...name].slice(0, LINEUP_NAME_MAX).join(''),
      keptApart: input.apart.has(id),
    }));
}

/** Compares by code unit, the same in every runtime. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
