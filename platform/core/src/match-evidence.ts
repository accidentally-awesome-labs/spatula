import type { RecordType } from './definition';
import { specLabelKey, type FieldValue } from './fields';
import { textKey } from './identity';
import { nameField, nameWords, wordDifference, type LineupEntry, type NameWord } from './matching';

/*
 * What a match question shows a decider (ADR 0003): both records' field values, never their pages'
 * text, laid out to show what matters. The names come first, with the words that differ called
 * out; then each side's identifiers, and whether any match; then every other value side by side,
 * in four groups: the same in both, different, only in A, and only in B. Last come the record's
 * known editions, and the other records in the same scope that exist separately already, closest
 * by name first. At most 20 values of a field are shown, as a question's state keeps them. The
 * request wraps all of it as untrusted (`buildDeciderRequest`).
 */

/** One side of a match question: a page's values, or a record's merged from its pages. */
export interface MatchSide {
  url: string;
  values: Record<string, FieldValue[]>;
}

/** At most this many values of a field are shown. */
const SHOWN_VALUES_MAX = 20;

/** Values side by side: a field's, or a spec's by its label. */
interface Row {
  label: string;
  a: string[];
  b: string[];
}

export function matchEvidence(input: {
  recordType: RecordType;
  page: MatchSide;
  entity: MatchSide;
  /** The names of the record's editions. */
  editions?: readonly string[];
  /** Other records in the same scope, closest to the page's name first. */
  lineup?: readonly LineupEntry[];
}): string {
  const { recordType, page, entity } = input;
  const shown = (side: MatchSide, field: string) =>
    (side.values[field] ?? []).slice(0, SHOWN_VALUES_MAX);
  const texts = (side: MatchSide, field: string) =>
    shown(side, field).filter((value): value is string => typeof value === 'string');
  const lines = [
    `Record A (${page.url}): the page asked about.`,
    `Record B (${entity.url}): the record it may belong to.`,
  ];

  const name = nameField(recordType);
  if (name !== null) {
    const [a] = texts(page, name);
    const [b] = texts(entity, name);
    if (a !== undefined || b !== undefined) {
      lines.push('', 'Names:', `A: ${a ?? '(none)'}`, `B: ${b ?? '(none)'}`);
      if (a !== undefined && b !== undefined) lines.push(nameDifference(a, b));
    }
  }

  const identifiers = recordType.identity.identifiers.flatMap((field) =>
    identifierLine(field, texts(page, field), texts(entity, field)),
  );
  if (identifiers.length > 0) lines.push('', 'Identifiers:', ...identifiers);

  const skipped = new Set([...(name === null ? [] : [name]), ...recordType.identity.identifiers]);
  const rows = rowsOf(
    Object.keys(recordType.fields).filter((field) => !skipped.has(field)),
    (field) => shown(page, field),
    (field) => shown(entity, field),
  );
  const both = rows.filter((row) => row.a.length > 0 && row.b.length > 0);
  const groups: [string, string[]][] = [
    ['The same in both:', both.filter(alike).map((row) => `- ${row.label}: ${row.a.join(', ')}`)],
    [
      'Different:',
      both
        .filter((row) => !alike(row))
        .map((row) => `- ${row.label}: A ${row.a.join(', ')}; B ${row.b.join(', ')}`),
    ],
    [
      'Only in A:',
      rows.filter((row) => row.b.length === 0).map((row) => `- ${row.label}: ${row.a.join(', ')}`),
    ],
    [
      'Only in B:',
      rows.filter((row) => row.a.length === 0).map((row) => `- ${row.label}: ${row.b.join(', ')}`),
    ],
  ];
  if (rows.length > 0) {
    lines.push('', 'Specifications:');
    for (const [heading, group] of groups) if (group.length > 0) lines.push(heading, ...group);
  }

  const editions = input.editions ?? [];
  if (editions.length > 0) lines.push('', `B’s known editions: ${editions.join('; ')}`);
  const lineup = input.lineup ?? [];
  if (lineup.length > 0) {
    lines.push(
      '',
      `Other records with the same ${scopeOf(recordType)}, each already a record of its own:`,
      ...lineup.map((entry) => `- ${entryText(entry)}`),
    );
  }
  return lines.join('\n');
}

/** How two names differ, word by word: the words one adds, or has in place of the other's. */
export function nameDifference(a: string, b: string): string {
  const { onlyA, onlyB } = wordDifference(nameWords(a), nameWords(b));
  const words = (list: readonly NameWord[]) => list.map((word) => word.text).join(' ');
  if (onlyA.length === 0 && onlyB.length === 0) return 'The names have the same words.';
  if (onlyB.length === 0) return `A adds: ${words(onlyA)}`;
  if (onlyA.length === 0) return `B adds: ${words(onlyB)}`;
  return `A has ${words(onlyA)} where B has ${words(onlyB)}`;
}

/**
 * The lineup as a decision record keeps it, in its evidence text, since the lineup isn't part of
 * the question's state. Empty for none.
 */
export function lineupNote(lineup: readonly LineupEntry[]): string {
  return lineup.length === 0 ? '' : `Shown beside it: ${lineup.map(entryText).join('; ')}.`;
}

function entryText(entry: LineupEntry): string {
  return entry.keptApart ? `${entry.name} (a person kept it apart from B)` : entry.name;
}

/** One identifier's line: what each side gives, and whether any match. */
function identifierLine(field: string, a: string[], b: string[]): string[] {
  if (a.length === 0 && b.length === 0) return [];
  const listed = (values: string[]) => (values.length === 0 ? 'none' : values.join(', '));
  const theirs = new Set(b.map(textKey));
  const shared = a.filter((value) => theirs.has(textKey(value)));
  const verdict =
    a.length === 0 || b.length === 0
      ? ''
      : shared.length === 0
        ? ' None match.'
        : ` Both give ${shared.join(', ')}.`;
  return [`- ${field}: A gives ${listed(a)}; B gives ${listed(b)}.${verdict}`];
}

/**
 * Every value but the name and the identifiers, side by side: a field's under its name, and a
 * spec's under its label, which two sides match whatever their case. Each value once, in the order
 * the fields are defined, A's first.
 */
function rowsOf(
  fields: readonly string[],
  a: (field: string) => FieldValue[],
  b: (field: string) => FieldValue[],
): Row[] {
  const rows = new Map<string, Row>();
  const add = (key: string, label: string, side: 'a' | 'b', text: string) => {
    const row = rows.get(key) ?? { label, a: [], b: [] };
    rows.set(key, row);
    if (!row[side].includes(text)) row[side].push(text);
  };
  for (const field of fields) {
    for (const [side, values] of [
      ['a', a(field)],
      ['b', b(field)],
    ] as const) {
      for (const value of values) {
        if (typeof value === 'string') add(`field\u001f${field}`, field, side, value);
        else {
          add(
            `spec\u001f${field}\u001f${specLabelKey(value.label)}`,
            value.label,
            side,
            value.value,
          );
        }
      }
    }
  }
  return [...rows.values()];
}

/** Whether a row's two sides say the same, once case, accents, and punctuation are set aside. */
function alike(row: Row): boolean {
  const a = new Set(row.a.map(textKey));
  const b = new Set(row.b.map(textKey));
  return a.size === b.size && [...a].every((key) => b.has(key));
}

/** What a record's name is compared within, in words: "brand", or "scope" without such a key. */
function scopeOf(recordType: RecordType): string {
  const key = recordType.identity.keys.find((fields) => fields.length >= 2);
  return key === undefined ? 'scope' : key.slice(0, -1).join(' and ');
}
