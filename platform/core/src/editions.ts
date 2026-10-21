import type { RecordType } from './definition';
import { textKey } from './identity';
import { nameField, nameWords } from './matching';
import { survivingValues, type StatementView } from './survivorship';

/*
 * A record's base page and its editions (ADR 0003). A record takes its name and its other single
 * values from its base page: the page whose name every other page's differing name extends, as
 * "DJ 300 PRO X Club" extends "DJ 300 PRO X", however either is spelled. Where no name is extended
 * so, the base is the earliest page that gives a name and didn't join as an edition. Pages whose
 * names are written as the base's, once normalized, count with it. The other pages' values fill
 * only the fields those leave unstated, so a recently read edition never takes over the record's
 * name, whichever page Spatula met first. Each page whose name differs from the record's is listed
 * as an edition, with its own GTINs.
 */

/** A page of a record, with its own statements. */
export interface EntityMember {
  /** The page's address, as its statements' `sourceUrl` gives it. */
  url: string;
  /** When Spatula first met the page, as an ISO time. */
  firstSeen: string;
  /** Whether the page joined the record as an edition. */
  edition: boolean;
  /** The page's own current statements. */
  statements: StatementView[];
}

/** An edition as a snapshot lists it. */
export interface Edition {
  name: string;
  officialUrl: string;
  gtins: string[];
}

/** A page's own name, or null where it gives none. */
function ownName(recordType: RecordType, member: EntityMember): string | null {
  const field = nameField(recordType);
  if (field === null) return null;
  const [name] = survivingValues(recordType, member.statements)[field] ?? [];
  return typeof name === 'string' ? name : null;
}

/** Whether a name's words begin with all of another's, and go on. */
function extendsName(longer: string, shorter: string): boolean {
  const words = nameWords(longer).map((word) => word.key);
  const base = nameWords(shorter).map((word) => word.key);
  return words.length > base.length && base.every((key, index) => words[index] === key);
}

/**
 * A record's base page, with the pages whose names are written as its: null for a record without
 * pages. A name group extends another when any of its spellings extends any of the other's. Where
 * every page that gives a name joined as an edition, the earliest of those is the base, and a page
 * without a name is the base only where no page gives one.
 */
export function basePages(
  recordType: RecordType,
  members: readonly EntityMember[],
): EntityMember[] | null {
  if (members.length === 0) return null;
  const named = members.map((member) => ({ member, name: ownName(recordType, member) }));
  // Each name by its key, with every spelling of it: spellings alike once normalized can still
  // split into different words ("Moon River 2", "MoonRiver2"), so which page came first can't
  // decide whether a name extends another.
  const names = new Map<string, Set<string>>();
  for (const { name } of named) {
    if (name !== null) names.set(textKey(name), (names.get(textKey(name)) ?? new Set()).add(name));
  }
  const extendsAny = (longer: ReadonlySet<string>, shorter: ReadonlySet<string>) =>
    [...longer].some((spelling) => [...shorter].some((base) => extendsName(spelling, base)));
  const extended = [...names].filter(([key, spellings]) =>
    [...names].every(([other, longer]) => other === key || extendsAny(longer, spellings)),
  );
  let key: string;
  if (extended.length === 1) {
    key = extended[0]![0];
  } else {
    // A page that gives a name comes first, so a page without one is the base only where none does.
    const [first] = [...named].sort(
      (a, b) =>
        Number(a.name === null) - Number(b.name === null) ||
        Number(a.member.edition) - Number(b.member.edition) ||
        compareText(a.member.firstSeen, b.member.firstSeen) ||
        compareText(a.member.url, b.member.url),
    );
    if (first!.name === null) return [first!.member];
    key = textKey(first!.name);
  }
  return named
    .filter(({ name }) => name !== null && textKey(name) === key)
    .map(({ member }) => member);
}

/**
 * A record's editions: each page whose own name differs from the record's, once normalized, with
 * its address and its own GTINs, by name. None where the record has no name.
 */
export function editionsOf(
  recordType: RecordType,
  members: readonly EntityMember[],
  recordName: string | null,
): Edition[] {
  if (recordName === null) return [];
  const key = textKey(recordName);
  const gtinFields = Object.entries(recordType.fields)
    .filter(([, field]) => field.type === 'gtin')
    .map(([name]) => name);
  return members
    .flatMap((member) => {
      const name = ownName(recordType, member);
      if (name === null || textKey(name) === key) return [];
      const values = survivingValues(recordType, member.statements);
      const gtins = [
        ...new Set(
          gtinFields.flatMap((field) =>
            (values[field] ?? []).filter((value): value is string => typeof value === 'string'),
          ),
        ),
      ];
      return [{ name, officialUrl: member.url, gtins }];
    })
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.officialUrl, b.officialUrl));
}

/** Compares by code unit, the same in every runtime. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
