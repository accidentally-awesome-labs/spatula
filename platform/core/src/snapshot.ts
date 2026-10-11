import { z } from 'zod';
import type { RecordType } from './definition';
import { survive, type StatementView } from './survivorship';

/*
 * Snapshots, in the format consumers read (Crowdio's ADR 0021): the project, the snapshot's ID and
 * generation, when it was published, and each record's canonical ID, fields, and where each field
 * came from. The schema checks what Crowdio's reader checks, so a snapshot that passes here reads
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
}

/** A record left out of a snapshot, and the required fields it lacked. */
export interface Excluded {
  canonicalId: string;
  missing: string[];
}

/** Each entity's record, in canonical-ID order, and the entities left out for missing fields. */
export function buildRecords(
  recordType: RecordType,
  entities: EntityStatements[],
): { records: SnapshotRecord[]; excluded: Excluded[] } {
  const records: SnapshotRecord[] = [];
  const excluded: Excluded[] = [];
  const ordered = [...entities].sort((a, b) =>
    a.canonicalId < b.canonicalId ? -1 : a.canonicalId > b.canonicalId ? 1 : 0,
  );
  for (const entity of ordered) {
    const results = survive(recordType, entity.statements);
    const missing = Object.entries(recordType.fields)
      .filter(([name, field]) => field.required && !results.has(name))
      .map(([name]) => name);
    if (missing.length > 0) {
      excluded.push({ canonicalId: entity.canonicalId, missing });
      continue;
    }
    const fields: SnapshotRecord['fields'] = {};
    const provenance: SnapshotRecord['provenance'] = {};
    for (const [name, field] of Object.entries(recordType.fields)) {
      const result = results.get(name);
      if (result === undefined) continue;
      fields[name] = field.list ? result.values : result.values[0];
      provenance[name] = result.provenance;
    }
    records.push({ canonicalId: entity.canonicalId, fields, provenance });
  }
  return { records, excluded };
}
