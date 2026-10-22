import {
  buildRecords,
  canonicalTaxonomy,
  checkGates,
  hasTaxonomy,
  newId,
  serializeSnapshot,
  sha256Hex,
  snapshotSchema,
  stableId,
  stableStringify,
  type EntityMember,
  type EntityStatements,
  type Excluded,
  type PublishResult,
  type Question,
  type Snapshot,
  type SnapshotRecord,
  type StatementView,
  type Taxonomy,
} from '@spatula/core';
import {
  commitSnapshot,
  currentStatements,
  entityMembers,
  headGenerationOf,
  heldSnapshot,
  holdSnapshot,
  latestSnapshot,
  listOpenReviews,
  newerRunSnapshot,
  publishHeld,
  revisionOf,
  snapshotById,
  snapshotOfRun,
  supersedeHeld,
  unlessNewerRun,
  type Executor,
  type NewerSnapshot,
  type SnapshotRow,
  type StoredSnapshot,
} from '@spatula/store';
import { heldKey, snapshotKey, type Context, type RefreshPorts } from './pipeline';
import { runTaxonomy } from './taxonomy';

/*
 * Publishing (ADR 0004). A run's records become a snapshot only when they changed. The gates decide
 * whether it publishes now or waits for the owner: held, its records wait in R2 and its row in the
 * database, with no generation, until the owner publishes or discards it, or a newer run
 * supersedes it. Publishing, now or later, moves the dataset's head generation compared and set,
 * so two publications never share a generation. A run publishes, holds, and supersedes nothing
 * once a run that started after it has a snapshot, and a definition applied while a run goes
 * holds that run's snapshot. A dataset with a taxonomy (ADR 0007) publishes it whole beside its
 * records, at the version the run placed its pages in, and a held snapshot keeps that version
 * until it's published.
 */

/** The owner's question about a held snapshot. */
export const PUBLISH_QUESTION: Question = {
  type: 'choice',
  prompt: 'Publish this held snapshot?',
  options: ['publish', 'discard'],
};

/** How many times publishing a held snapshot tries the next generation when the head moves. */
const PUBLISH_ATTEMPTS = 3;

/**
 * A snapshot's file isn't in the blob store. A retry would find the same, so a Workflow doesn't
 * retry the step that hit it (workflow.ts).
 */
export class SnapshotFileMissingError extends Error {
  constructor(snapshot: { id: string; key: string }) {
    super(`The file of snapshot ${snapshot.id} is missing from the blob store (${snapshot.key})`);
    this.name = 'SnapshotFileMissingError';
  }
}

/**
 * What a snapshot's records say, their editions included, without when each value was last seen,
 * and the taxonomy version they were placed in (ADR 0007). A run that only sees the same values
 * again publishes nothing; consumers already have them. A newly found edition publishes (ADR 0003),
 * and so does a new taxonomy version, though no record changed: readers need its names,
 * descriptions, and migrations. A record without editions, under no taxonomy version, digests as
 * records always did, so no dataset publishes again for either.
 */
export async function recordsDigest(
  records: SnapshotRecord[],
  taxonomyVersion?: number,
): Promise<string> {
  const said = records.map((record) => ({
    canonicalId: record.canonicalId,
    fields: record.fields,
    provenance: Object.fromEntries(
      Object.entries(record.provenance).map(([name, { sourceUrl, method, confidence }]) => [
        name,
        { sourceUrl, method, confidence },
      ]),
    ),
    ...(record.editions === undefined ? {} : { editions: record.editions }),
  }));
  return sha256Hex(
    stableStringify(taxonomyVersion === undefined ? said : { records: said, taxonomyVersion }),
  );
}

/** Publishes the dataset's records if they changed and the gates allow it, or holds them. */
export async function publish(context: Context, ports: RefreshPorts): Promise<PublishResult> {
  const { runId, datasetId, definition, revision } = context;
  const [recordType] = Object.values(definition.recordTypes);
  if (recordType === undefined) throw new Error(`Dataset ${datasetId} has no record type`);
  // The version the run placed its pages in (ADR 0007), read before the database is opened for the
  // rest, since runTaxonomy opens it on its own. Null without a taxonomy, or before one is seeded.
  const taxonomy = hasTaxonomy(recordType) ? await runTaxonomy(context, ports) : null;
  return ports.withDb(async (db) => {
    // A step that runs again finds what it made the first time.
    const made = await snapshotOfRun(db, runId);
    if (made !== null) return resultOf(made);
    // The records come from the dataset's current statements, whichever run wrote them, so once a
    // run that started after this one has a snapshot, in any state, this one publishes, holds, and
    // supersedes nothing. Each change below asks again under the dataset's row, in the change's own
    // transaction, so a snapshot that lands while this one is made counts too.
    const newer = await newerRunSnapshot(db, { datasetId, runId });
    if (newer !== null) return overtaken(newer, []);
    const unlessNewer = <T>(change: (tx: Executor) => Promise<T>) =>
      unlessNewerRun(db, { datasetId, runId }, change);
    // Each record's pages, for its base page and its editions (ADR 0003).
    const members = new Map<string, EntityMember[]>();
    const memberOf = new Map<string, EntityMember>();
    for (const row of await entityMembers(db, datasetId)) {
      const member: EntityMember = {
        url: row.url,
        firstSeen: row.firstSeen.toISOString(),
        edition: row.edition,
        statements: [],
      };
      memberOf.set(row.itemId, member);
      const list = members.get(row.entityId);
      if (list === undefined) members.set(row.entityId, [member]);
      else list.push(member);
    }
    // Pushed in place: copying an entity's list for every statement would be quadratic. A page's
    // list holds the same statements as its record's.
    const said = new Map<string, StatementView[]>();
    for (const statement of await currentStatements(db, datasetId)) {
      const id = statement.entityId;
      if (id === null) continue;
      const list = said.get(id);
      if (list === undefined) said.set(id, [statement]);
      else list.push(statement);
      memberOf.get(statement.itemId)?.statements.push(statement);
    }
    const entities: EntityStatements[] = [...said].map(([canonicalId, statements]) => ({
      canonicalId,
      statements,
      members: members.get(canonicalId) ?? [],
    }));
    const { records, excluded } = buildRecords(recordType, entities, taxonomy);
    if (records.length === 0) {
      // Publishing a snapshot held earlier would bring back records no run finds now.
      const superseding = await unlessNewer((tx) =>
        supersedeHeld(tx, { datasetId, at: ports.now() }),
      );
      if ('newer' in superseding) return overtaken(superseding.newer, excluded);
      return {
        published: false,
        reason: `no record is complete${superseding.made > 0 ? ', so the snapshot held for review is superseded' : ''}`,
        excluded,
      };
    }
    const digest = await recordsDigest(records, taxonomy?.version);
    const latest = await latestSnapshot(db, datasetId);
    if (latest !== null && latest.recordsSha256 === digest) {
      // A snapshot held earlier is older than these records, which are the published ones again.
      const superseding = await unlessNewer((tx) =>
        supersedeHeld(tx, { datasetId, at: ports.now() }),
      );
      if ('newer' in superseding) return overtaken(superseding.newer, excluded);
      return {
        published: false,
        reason: `nothing changed since generation ${latest.generation}${superseding.made > 0 ? ', so the snapshot held for review is superseded' : ''}`,
        excluded,
      };
    }
    const waiting = await heldSnapshot(db, datasetId);
    if (waiting !== null && waiting.recordsSha256 === digest && waiting.revision === revision) {
      return {
        published: false,
        reason: 'the snapshot held for review is unchanged',
        excluded,
        held: heldOf(waiting),
      };
    }

    const snapshotId = await stableId('sn', runId);
    const snapshot: Snapshot = {
      project: datasetId,
      snapshotId,
      generation: (await headGenerationOf(db, datasetId)) + 1,
      publishedAt: ports.now().toISOString(),
      ...(taxonomy === null ? {} : { taxonomy }),
      records,
    };
    // Checked before the gates, so a held snapshot can always be published as it is.
    const checked = snapshotSchema.safeParse(snapshot);
    if (!checked.success) {
      // That is a fault in this run, not news about the data, so what is held stays held.
      const issue = checked.error.issues[0];
      return {
        published: false,
        reason: `the snapshot breaks the published format at ${issue?.path.join('.')}: ${issue?.message}${waiting === null ? '' : ', so the snapshot held for review stays'}`,
        excluded,
        ...(waiting === null ? {} : { held: heldOf(waiting) }),
      };
    }
    const gates = checkGates({
      approval: definition.publication.approval,
      maxRemovals: definition.gates.maxRemovals,
      previous:
        latest === null
          ? null
          : { canonicalIds: await recordIdsOf(ports, latest), revision: latest.revision },
      next: { canonicalIds: records.map((record) => record.canonicalId), revision },
      // A definition applied while the run went holds what it made. A dataset that's gone has no
      // revision, and the change below fails without its row.
      revisionNow: (await revisionOf(db, datasetId)) ?? revision,
    });

    if (!gates.publish) {
      // The guard counts every record that leaves, as Crowdio's sync does, but a record doesn't
      // only leave because its page did: a withdrawn category leaves it incomplete, and a page
      // that waits for an answer stays out. So the owner is told how many records are incomplete
      // and how many questions are open.
      const open = await listOpenReviews(db, datasetId);
      // The draft keeps the taxonomy its records were placed in, so it publishes as it was held.
      const draft = JSON.stringify({
        project: datasetId,
        snapshotId,
        ...(taxonomy === null ? {} : { taxonomy: canonicalTaxonomy(taxonomy) }),
        records,
      });
      const key = heldKey(datasetId, snapshotId);
      await ports.blobs.put(key, draft, 'application/json');
      const held = {
        id: snapshotId,
        datasetId,
        runId,
        revision,
        recordCount: records.length,
        recordsSha256: digest,
        key,
        sha256: await sha256Hex(draft),
        bytes: new TextEncoder().encode(draft).byteLength,
        heldReason: gates.reasons.join('; '),
        report: { excluded, gates },
        at: ports.now(),
        review: {
          id: await stableId('rv', snapshotId),
          question: PUBLISH_QUESTION,
          context: {
            snapshotId,
            records: records.length,
            added: gates.added,
            removed: gates.removed,
            reasons: gates.reasons,
            previousGeneration: latest?.generation ?? null,
            incomplete: excluded.length,
            openClassify: open.filter((review) => review.kind === 'classify').length,
            openMatch: open.filter((review) => review.kind === 'match').length,
          },
        },
      };
      const holding = await unlessNewer((tx) => holdSnapshot(tx, held));
      if ('newer' in holding) return overtaken(holding.newer, excluded);
      return {
        published: false,
        reason: `it’s held for review: ${gates.reasons.join('; ')}`,
        excluded,
        held: { snapshotId, records: records.length, reasons: gates.reasons },
      };
    }

    const body = serializeSnapshot(snapshot);
    // A file of its own for each attempt, which the row names once it commits. A step that runs
    // twice at once makes the same snapshot ID twice, and the attempt that loses the
    // compare-and-set mustn't overwrite the file the winner's row names: every reader checks the
    // file against its hash.
    const key = snapshotKey(datasetId, `${snapshotId}.${newId('try')}`);
    await ports.blobs.put(key, body, 'application/json');
    const row = {
      id: snapshotId,
      datasetId,
      generation: snapshot.generation,
      runId,
      revision,
      recordCount: records.length,
      recordsSha256: digest,
      key,
      sha256: await sha256Hex(body),
      bytes: new TextEncoder().encode(body).byteLength,
      publishedAt: snapshot.publishedAt,
      report: { excluded, gates },
    };
    const committing = await unlessNewer((tx) => commitSnapshot(tx, row));
    if ('newer' in committing) return overtaken(committing.newer, excluded);
    const committed = committing.made;
    // Another run took this generation first. The step fails, and its retry starts from the new
    // head.
    if (!committed.committed) {
      throw new Error(`Generation ${committed.headGeneration} was published by another run`);
    }
    return {
      published: true,
      generation: snapshot.generation,
      snapshotId,
      records: records.length,
      excluded,
    };
  });
}

/**
 * Publishes a held snapshot, as the owner asked: its records get the next generation, compared and
 * set, and a head that moves meanwhile means trying the one after. A snapshot that isn't held any
 * more, because it was published, discarded, or superseded by a newer run, is stale.
 */
export async function publishHeldSnapshot(
  ports: Pick<RefreshPorts, 'withDb' | 'blobs' | 'now'>,
  input: { datasetId: string; snapshotId: string },
): Promise<{ kind: 'published'; generation: number } | { kind: 'stale'; state: string }> {
  const row = await ports.withDb((db) => snapshotById(db, input.snapshotId));
  if (row === null || row.datasetId !== input.datasetId) return { kind: 'stale', state: 'missing' };
  if (row.state !== 'held') return { kind: 'stale', state: row.state };
  const draft = await ports.blobs.get(row.key);
  if (draft === null) throw new SnapshotFileMissingError(row);
  // A draft held before the taxonomy has none, and publishes as it always did.
  const { records, taxonomy } = JSON.parse(new TextDecoder().decode(draft)) as {
    records: SnapshotRecord[];
    taxonomy?: Taxonomy;
  };
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
    const generation = (await ports.withDb((db) => headGenerationOf(db, input.datasetId))) + 1;
    const snapshot = snapshotSchema.parse({
      project: input.datasetId,
      snapshotId: row.id,
      generation,
      publishedAt: ports.now().toISOString(),
      ...(taxonomy === undefined ? {} : { taxonomy }),
      records,
    });
    const body = serializeSnapshot(snapshot);
    // Each attempt writes a file of its own, which its row names once it's published. Two
    // answers sent at once both get this far, and the one that loses the compare-and-set mustn't
    // overwrite the file the winner's row names: every reader checks the file against its hash.
    const key = snapshotKey(input.datasetId, `${row.id}.${newId('try')}`);
    await ports.blobs.put(key, body, 'application/json');
    const sha256 = await sha256Hex(body);
    const outcome = await ports.withDb((db) =>
      publishHeld(db, {
        datasetId: input.datasetId,
        snapshotId: row.id,
        generation,
        key,
        sha256,
        bytes: new TextEncoder().encode(body).byteLength,
        publishedAt: snapshot.publishedAt,
      }),
    );
    if ('stale' in outcome) return { kind: 'stale', state: outcome.stale };
    if (outcome.committed) return { kind: 'published', generation };
  }
  throw new Error(`The head generation kept moving, so snapshot ${row.id} wasn’t published`);
}

/**
 * The canonical IDs of a published snapshot's records, from its file. The file is the only copy of
 * its records, and a retry would find it as missing as this did.
 */
async function recordIdsOf(ports: RefreshPorts, snapshot: SnapshotRow): Promise<string[]> {
  const body = await ports.blobs.get(snapshot.key);
  if (body === null) throw new SnapshotFileMissingError(snapshot);
  const { records } = JSON.parse(new TextDecoder().decode(body)) as { records: SnapshotRecord[] };
  return records.map((record) => record.canonicalId);
}

/**
 * What a run's snapshot step comes to when a run that started after it already has a snapshot: it
 * publishes, holds, and supersedes nothing (ADR 0004).
 */
function overtaken(newer: NewerSnapshot, excluded: Excluded[]): PublishResult {
  return {
    published: false,
    reason: `a newer run (${newer.runId}) already has a snapshot, so this run’s isn’t published`,
    excluded,
  };
}

function heldOf(snapshot: StoredSnapshot): {
  snapshotId: string;
  records: number;
  reasons: string[];
} {
  return {
    snapshotId: snapshot.id,
    records: snapshot.recordCount,
    reasons: snapshot.report.gates?.reasons ?? [],
  };
}

/** What a run's own snapshot came to, for a step that runs again. */
function resultOf(snapshot: StoredSnapshot): PublishResult {
  const excluded = snapshot.report.excluded;
  if (snapshot.state === 'published' && snapshot.generation !== null) {
    return {
      published: true,
      generation: snapshot.generation,
      snapshotId: snapshot.id,
      records: snapshot.recordCount,
      excluded,
    };
  }
  if (snapshot.state === 'held') {
    return {
      published: false,
      reason: `it’s held for review: ${snapshot.heldReason ?? 'the gates held it'}`,
      excluded,
      held: heldOf(snapshot),
    };
  }
  return { published: false, reason: `its snapshot was ${snapshot.state}`, excluded };
}
