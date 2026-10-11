import type { RecordType } from './definition';
import type { FieldValue } from './fields';

/*
 * Identity: which values tell records apart, and which existing entity an item belongs to.
 * Identifiers outrank keys: a GTIN, then a part number within its brand, then the brand and name
 * together. Text compares as a key that ignores case, accents, spaces, and punctuation, but not
 * plus signs: the Magni 3 and the Magni 3+ are different products.
 */

export interface IdentityClaim {
  /** The claim as an index key, such as `gtins:00819343015004`. */
  value: string;
  /** Its strength: lower is stronger. */
  rank: number;
}

export type Resolution =
  | { kind: 'existing'; entityId: string }
  | { kind: 'new' }
  | { kind: 'unresolvable' };

/** "HD 660S2" and "hd-660 s2" are "hd660s2"; "Magni 3+" and "Magni 3 Plus" are "magni3plus". */
export function textKey(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\+/gu, 'plus')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** An item's identity claims, strongest first, from its values for each field. */
export function identityClaims(
  recordType: RecordType,
  values: Record<string, FieldValue[]>,
): IdentityClaim[] {
  const claims: IdentityClaim[] = [];
  let rank = 0;
  for (const name of recordType.identity.identifiers) {
    const field = recordType.fields[name];
    // The brand's key, or null when the field has no scope. A part number means nothing without its
    // brand, so it can't claim anything alone, and a brand whose name has no letters or digits has
    // an empty key, which is no brand at all.
    const scope =
      field?.scope === undefined ? null : textKey(textOf(values[field.scope]?.[0]) ?? '');
    if (field !== undefined && scope !== '') {
      for (const value of values[name] ?? []) {
        const text = textOf(value);
        const key = text === null ? '' : field.type === 'gtin' ? text : textKey(text);
        if (key === '') continue;
        claims.push({ value: scope === null ? `${name}:${key}` : `${name}:${scope}:${key}`, rank });
      }
    }
    rank += 1;
  }
  recordType.identity.keys.forEach((fields, index) => {
    const keys = fields.map((name) => textKey(textOf(values[name]?.[0]) ?? ''));
    if (keys.every((key) => key !== ''))
      claims.push({ value: `key${index}:${keys.join('|')}`, rank: rank + index });
  });
  return claims;
}

/** The entity the strongest owned claim points to; new if none is owned; unresolvable without claims. */
export function resolveIdentity(
  claims: IdentityClaim[],
  owners: ReadonlyMap<string, string>,
): Resolution {
  if (claims.length === 0) return { kind: 'unresolvable' };
  const strongest = [...claims]
    .sort((a, b) => a.rank - b.rank)
    .find((claim) => owners.has(claim.value));
  const entityId = strongest === undefined ? undefined : owners.get(strongest.value);
  return entityId === undefined ? { kind: 'new' } : { kind: 'existing', entityId };
}

function textOf(value: FieldValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
