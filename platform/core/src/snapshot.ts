import { z } from 'zod';
import { hasTaxonomy, type RecordType } from './definition';
import { basePages, editionsOf, type EntityMember } from './editions';
import { nameField } from './matching';
import { survive, type StatementView } from './survivorship';
import { taxonomySchema, type Taxonomy } from './taxonomy';
import { canonicalTaxonomy, placementIssues, placeRecord } from './taxonomy-records';

/*
 * Snapshots, in the format consumers read (Crowdio's ADR 0021): the project, the snapshot's ID and
 * generation, when it was published, and each record's canonical ID, fields, where each field
 * came from, and its editions where it has any (ADR 0003). The schema checks what Crowdio's reader
 * checks, and Crowdio's reader ignores keys it doesn't know, so a snapshot that passes here reads
 * there. A record missing a required field is left out and reported, never published half-known.
 *
 * A dataset whose record type has a taxonomy (ADR 0007) publishes the taxonomy whole, at the
 * version its records were placed in, and each record's place in it: its shelf, its functions with
 * those the shelf implies, the features on its shelf, and its category's name for one release. A
 * record whose shelf is unknown is left out, missing its shelf. A snapshot without a taxonomy is
 * what it always was, byte for byte.
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
    // The dataset's taxonomy, whole, when its record type has one (ADR 0007).
    taxonomy: taxonomySchema.optional(),
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
      // With a taxonomy, every record is placed in it as the contract says.
      if (snapshot.taxonomy === undefined) continue;
      for (const issue of placementIssues(snapshot.taxonomy, record.fields)) {
        ctx.addIssue({
          code: 'custom',
          message: issue.message,
          path: ['records', index, 'fields', ...issue.path],
        });
      }
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
 * listed (ADR 0003). Its lists hold every page's values either way. A record type with a taxonomy
 * places each record in it, after the record type's own fields, from the base page as well, or
 * from every page when the base page names no live shelf: a record whose shelf is unknown, or that
 * has no taxonomy to be placed in yet, is left out, missing its shelf (ADR 0007). A record type
 * without one ignores the taxonomy.
 */
export function buildRecords(
  recordType: RecordType,
  entities: EntityStatements[],
  taxonomy: Taxonomy | null = null,
): { records: SnapshotRecord[]; excluded: Excluded[] } {
  const records: SnapshotRecord[] = [];
  const excluded: Excluded[] = [];
  const placing = hasTaxonomy(recordType);
  const ordered = [...entities].sort((a, b) =>
    a.canonicalId < b.canonicalId ? -1 : a.canonicalId > b.canonicalId ? 1 : 0,
  );
  const named = nameField(recordType);
  for (const entity of ordered) {
    const results = survive(recordType, entity.statements);
    const missing = Object.entries(recordType.fields)
      .filter(([name, field]) => field.required && !results.has(name))
      .map(([name]) => name);
    const base = basePages(recordType, entity.members ?? []);
    const own = new Set(base?.flatMap((member) => member.statements) ?? []);
    // A person's word outranks every other (ADR 0003), so it counts wherever it was said.
    const baseSaid =
      base === null
        ? entity.statements
        : [
            ...own,
            ...entity.statements.filter(
              (statement) => statement.method === 'human' && !own.has(statement),
            ),
          ];
    // A shelf is a single value, so it's the base pages' too, unless they name no live shelf.
    const placed =
      placing && taxonomy !== null
        ? (placeRecord(taxonomy, baseSaid) ?? placeRecord(taxonomy, entity.statements))
        : null;
    if (placing && placed === null) missing.push('shelf');
    if (missing.length > 0) {
      excluded.push({ canonicalId: entity.canonicalId, missing });
      continue;
    }
    const fromBase = base === null ? results : survive(recordType, baseSaid);
    const fields: SnapshotRecord['fields'] = {};
    const provenance: SnapshotRecord['provenance'] = {};
    for (const [name, field] of Object.entries(recordType.fields)) {
      // A single value is the base page's, unless the base pages leave it unstated.
      const result = field.list ? results.get(name) : (fromBase.get(name) ?? results.get(name));
      if (result === undefined) continue;
      fields[name] = field.list ? result.values : result.values[0];
      provenance[name] = result.provenance;
    }
    // The place comes after the record type's own fields. Its category is the shelf's: a record
    // type with a taxonomy can't declare category, so a category stated before it isn't read.
    if (placed !== null) {
      Object.assign(fields, placed.fields);
      Object.assign(provenance, placed.provenance);
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

/**
 * A snapshot as its file holds it, and as publishing writes every file: compact JSON, with its keys
 * in the contract's order, the taxonomy's included, and each record's editions where it has any. A
 * snapshot without a taxonomy comes out as it always did. The example snapshot, which Crowdio keeps
 * a copy of, is its output.
 */
export function serializeSnapshot(snapshot: Snapshot): string {
  return JSON.stringify({
    project: snapshot.project,
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
    publishedAt: snapshot.publishedAt,
    ...(snapshot.taxonomy === undefined ? {} : { taxonomy: canonicalTaxonomy(snapshot.taxonomy) }),
    records: snapshot.records.map((record) => ({
      canonicalId: record.canonicalId,
      fields: record.fields,
      provenance: record.provenance,
      ...(record.editions === undefined
        ? {}
        : {
            editions: record.editions.map(({ name, officialUrl, gtins }) => ({
              name,
              officialUrl,
              gtins,
            })),
          }),
    })),
  });
}
