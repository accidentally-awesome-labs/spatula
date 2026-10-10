import type { Definition } from './definition';
import type { FieldType } from './fields';
import type { Page } from './page';
import type { Candidate } from './statements';

/*
 * A dataset pack knows a kind of record (a product, an offer) well enough to read it from
 * structured data. A definition opts in for a record type with `pack: <pack>/<record type>`, and
 * the fields the pack fills must have the types it fills them with.
 */

export interface RecordTypePack {
  /** The fields this pack fills, with the type each must have in a definition. */
  fields: Record<string, { type: FieldType; list: boolean }>;
  /** Candidate values from the page's structured data. */
  extract(page: Page): Candidate[];
  /** A last pass over all of a page's candidates, declared ones included, before they're normalized. */
  finish?(candidates: Candidate[]): Candidate[];
}

export type PackRegistry = Readonly<Record<string, RecordTypePack>>;

/** Problems with a definition's packs, as `path: message`; none means its packs fit. */
export function packIssues(definition: Definition, packs: PackRegistry): string[] {
  const issues: string[] = [];
  for (const [typeName, recordType] of Object.entries(definition.recordTypes)) {
    if (recordType.pack === undefined) continue;
    const pack = packs[recordType.pack];
    if (pack === undefined) {
      issues.push(`recordTypes.${typeName}.pack: There’s no pack called ${recordType.pack}.`);
      continue;
    }
    for (const [fieldName, expected] of Object.entries(pack.fields)) {
      const field = recordType.fields[fieldName];
      if (field !== undefined && (field.type !== expected.type || field.list !== expected.list)) {
        issues.push(
          `recordTypes.${typeName}.fields.${fieldName}: The ${recordType.pack} pack fills ${fieldName} as ${expected.list ? 'a list of ' : ''}${expected.type}.`,
        );
      }
    }
  }
  return issues;
}
