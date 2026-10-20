import { z } from 'zod';
import type { RecordType } from './definition';
import { basePages, editionsOf, type EntityMember } from './editions';
import { nameField } from './matching';
import { survive, type StatementView } from './survivorship';

/*
 * Snapshots, in the format consumers read (Crowdio's ADR 0021): the project, the snapshot's ID and
 * generation, when it was published, and each record's canonical ID, fields, where each field
 * came from, and its editions where it has any (ADR 0003). The schema checks what Crowdio's reader
 * checks, and Crowdio's reader ignores keys it doesn't know, so a snapshot that passes here reads
 * there. A record missing a required field is left out and reported, never published half-known.
 */

const NO_CONTROL = /^[^\p{Cc}]*$/u;
const id = z
  .string()
  .trim()
  .min(1)
  .regex(NO_CONTROL, 'It can’t contain line breaks or other control characters.');

export const snapshotSchema = z
  .strictObject({
    project: id.max(100),
    snapshotId: id,
    generation: z.number().int().positive(),
    publishedAt: z.iso.datetime({ offset: true }),
    records: z.array(
      z.strictObject({
        canonicalId: id.max(200),
        fields: z.record(z.string(), z.unknown()),
        provenance: z.record(
          z.string(),
          z.strictObject({
            sourceUrl: z.string(),
            fetchedAt: z.iso.datetime({ offset: true }),
            method: z.string(),
            confidence: z.number().min(0).max(1),
          }),
        ),
        // Absent where the record has none, so a snapshot from before editions reads as it did.
        editions: z
          .array(
            z.strictObject({
              name: z.string().trim().min(1),
              officialUrl: z.string(),
              gtins: z.array(z.string()),
            }),
          )
          .optional(),
      }),
    ),
  })
  .superRefine((snapshot, ctx) => {
    // Crowdio refuses a snapshot that lists a canonical ID twice, so this schema does too, and the
    // issue points at the repeat.
    const seen = new Set<string>();
    for (const [index, record] of snapshot.records.entries()) {
      if (seen.has(record.canonicalId)) {
        ctx.addIssue({
          code: 'custom',
          message: 'The snapshot has this record more than once.',
          path: ['records', index, 'canonicalId'],
        });
      }
      seen.add(record.canonicalId);
    }
  });

export type Snapshot = z.output<typeof snapshotSchema>;
export type SnapshotRecord = Snapshot['records'][number];

export interface EntityStatements {
  canonicalId: string;
  statements: StatementView[];
  /**
   * The record's pages, each with its own statements, the same objects as in `statements`
   * (ADR 0003). Absent: every statement counts alike, and no edition is listed.
   */
  members?: EntityMember[];
}

/** A record left out of a snapshot, and the required fields it lacked. */
export interface Excluded {
  canonicalId: string;
  missing: string[];
}

/**
 * Each entity's record, in canonical-ID order, and the entities left out for missing fields. Where
 * an entity comes with its pages, its single values come from its base page, and its editions are
 * listed (ADR 0003). Its lists hold every page's values either way.
 */
export function buildRecords(
  recordType: RecordType,
  entities: EntityStatements[],
): { records: SnapshotRecord[]; excluded: Excluded[] } {
  const records: SnapshotRecord[] = [];
  const excluded: Excluded[] = [];
  const ordered = [...entities].sort((a, b) =>
    a.canonicalId < b.canonicalId ? -1 : a.canonicalId > b.canonicalId ? 1 : 0,
  );
  const named = nameField(recordType);
  for (const entity of ordered) {
    const results = survive(recordType, entity.statements);
    const missing = Object.entries(recordType.fields)
      .filter(([name, field]) => field.required && !results.has(name))
      .map(([name]) => name);
    if (missing.length > 0) {
      excluded.push({ canonicalId: entity.canonicalId, missing });
      continue;
    }
    const base = basePages(recordType, entity.members ?? []);
    const own = new Set(base?.flatMap((member) => member.statements) ?? []);
    // A person's word outranks every other (ADR 0003), so it counts wherever it was said.
    const fromBase =
      base === null
        ? results
        : survive(recordType, [
            ...own,
            ...entity.statements.filter(
              (statement) => statement.method === 'human' && !own.has(statement),
            ),
          ]);
    const fields: SnapshotRecord['fields'] = {};
    const provenance: SnapshotRecord['provenance'] = {};
    for (const [name, field] of Object.entries(recordType.fields)) {
      // A single value is the base page's, unless the base pages leave it unstated.
      const result = field.list ? results.get(name) : (fromBase.get(name) ?? results.get(name));
      if (result === undefined) continue;
      fields[name] = field.list ? result.values : result.values[0];
      provenance[name] = result.provenance;
    }
    const recordName = named === null ? undefined : fields[named];
    const editions =
      entity.members === undefined
        ? []
        : editionsOf(
            recordType,
            entity.members,
            typeof recordName === 'string' ? recordName : null,
          );
    records.push({
      canonicalId: entity.canonicalId,
      fields,
      provenance,
      ...(editions.length > 0 ? { editions } : {}),
    });
  }
  return { records, excluded };
}
