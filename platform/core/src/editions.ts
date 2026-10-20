import type { RecordType } from './definition';
import { textKey } from './identity';
import { nameField, nameWords } from './matching';
import { survivingValues, type StatementView } from './survivorship';

/*
 * A record's base page and its editions (ADR 0003). A record takes its name and its other single
 * values from its base page: the page whose name every other page's differing name extends, as
 * "DJ 300 PRO X Club" extends "DJ 300 PRO X". Where no name is extended so, the base is the
 * earliest page that didn't join as an edition. Pages whose names are written as the base's, once
 * normalized, count with it. The other pages' values fill only the fields those leave unstated, so
 * a recently read edition never takes over the record's name, whichever page Spatula met first.
 * Each page whose name differs from the record's is listed as an edition, with its own GTINs.
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
 * pages. Where every page joined as an edition, the earliest page is the base.
 */
export function basePages(
  recordType: RecordType,
  members: readonly EntityMember[],
): EntityMember[] | null {
  if (members.length === 0) return null;
  const named = members.map((member) => ({ member, name: ownName(recordType, member) }));
  // Each way of writing a name once, by its key, with the first page's spelling.
  const names = new Map<string, string>();
  for (const { name } of named) {
    if (name !== null && !names.has(textKey(name))) names.set(textKey(name), name);
  }
  const extended = [...names].filter(([key, name]) =>
    [...names].every(([other, longer]) => other === key || extendsName(longer, name)),
  );
  let key: string;
  if (extended.length === 1) {
    key = extended[0]![0];
  } else {
    const [first] = [...named].sort(
      (a, b) =>
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
