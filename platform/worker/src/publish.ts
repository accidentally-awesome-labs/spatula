import {
  buildRecords,
  checkGates,
  newId,
  sha256Hex,
  snapshotSchema,
  stableId,
  stableStringify,
  type EntityStatements,
  type PublishResult,
  type Question,
  type Snapshot,
  type SnapshotRecord,
  type StatementView,
} from '@spatula/core';
import {
  commitSnapshot,
  currentStatements,
  headGenerationOf,
  heldSnapshot,
  holdSnapshot,
  latestSnapshot,
  listOpenReviews,
  publishHeld,
  snapshotById,
  snapshotOfRun,
  supersedeHeld,
  type SnapshotRow,
  type StoredSnapshot,
} from '@spatula/store';
import { heldKey, snapshotKey, type Context, type RefreshPorts } from './pipeline';

/*
 * Publishing (ADR 0004). A run's records become a snapshot only when they changed. The gates decide
 * whether it publishes now or waits for the owner: held, its records wait in R2 and its row in the
 * database, with no generation, until the owner publishes or discards it, or a newer run
 * supersedes it. Publishing, now or later, moves the dataset's head generation compared and set,
 * so two publications never share a generation.
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
 * What a snapshot's records say, without when each value was last seen. A run that only sees
 * the same values again publishes nothing; consumers already have them.
 */
export async function recordsDigest(records: SnapshotRecord[]): Promise<string> {
  return sha256Hex(
    stableStringify(
      records.map((record) => ({
        canonicalId: record.canonicalId,
        fields: record.fields,
        provenance: Object.fromEntries(
          Object.entries(record.provenance).map(([name, { sourceUrl, method, confidence }]) => [
            name,
            { sourceUrl, method, confidence },
          ]),
        ),
      })),
    ),
  );
}

/** Publishes the dataset's records if they changed and the gates allow it, or holds them. */
export async function publish(context: Context, ports: RefreshPorts): Promise<PublishResult> {
  const { runId, datasetId, definition, revision } = context;
  return ports.withDb(async (db) => {
    // A step that runs again finds what it made the first time.
    const made = await snapshotOfRun(db, runId);
    if (made !== null) return resultOf(made);
    const [recordType] = Object.values(definition.recordTypes);
    if (recordType === undefined) throw new Error(`Dataset ${datasetId} has no record type`);
    // Pushed in place: copying an entity's list for every statement would be quadratic.
    const said = new Map<string, StatementView[]>();
    for (const statement of await currentStatements(db, datasetId)) {
      const id = statement.entityId;
      if (id === null) continue;
      const list = said.get(id);
      if (list === undefined) said.set(id, [statement]);
      else list.push(statement);
    }
    const entities: EntityStatements[] = [...said].map(([canonicalId, statements]) => ({
      canonicalId,
      statements,
    }));
    const { records, excluded } = buildRecords(recordType, entities);
    if (records.length === 0) {
      // Publishing a snapshot held earlier would bring back records no run finds now.
      const superseded = await supersedeHeld(db, { datasetId, at: ports.now() });
      return {
        published: false,
        reason: `no record is complete${superseded > 0 ? ', so the snapshot held for review is superseded' : ''}`,
        excluded,
      };
    }
    const digest = await recordsDigest(records);
    const latest = await latestSnapshot(db, datasetId);
    if (latest !== null && latest.recordsSha256 === digest) {
      // A snapshot held earlier is older than these records, which are the published ones again.
      const superseded = await supersedeHeld(db, { datasetId, at: ports.now() });
      return {
        published: false,
        reason: `nothing changed since generation ${latest.generation}${superseded > 0 ? ', so the snapshot held for review is superseded' : ''}`,
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
    });

    if (!gates.publish) {
      // The guard counts every record that leaves, as Crowdio's sync does, but a record doesn't
      // only leave because its page did: a withdrawn category leaves it incomplete, and a page
      // that waits for an answer stays out. So the owner is told how many records are incomplete
      // and how many questions are open.
      const open = await listOpenReviews(db, datasetId);
      const draft = JSON.stringify({ project: datasetId, snapshotId, records });
      const key = heldKey(datasetId, snapshotId);
      await ports.blobs.put(key, draft, 'application/json');
      await holdSnapshot(db, {
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
      });
      return {
        published: false,
        reason: `it’s held for review: ${gates.reasons.join('; ')}`,
        excluded,
        held: { snapshotId, records: records.length, reasons: gates.reasons },
      };
    }

    const body = JSON.stringify(snapshot);
    // A file of its own for each attempt, which the row names once it commits. A step that runs
    // twice at once makes the same snapshot ID twice, and the attempt that loses the
    // compare-and-set mustn't overwrite the file the winner's row names: every reader checks the
    // file against its hash.
    const key = snapshotKey(datasetId, `${snapshotId}.${newId('try')}`);
    await ports.blobs.put(key, body, 'application/json');
    const committed = await commitSnapshot(db, {
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
    });
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
  const { records } = JSON.parse(new TextDecoder().decode(draft)) as { records: SnapshotRecord[] };
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
    const generation = (await ports.withDb((db) => headGenerationOf(db, input.datasetId))) + 1;
    const snapshot = snapshotSchema.parse({
      project: input.datasetId,
      snapshotId: row.id,
      generation,
      publishedAt: ports.now().toISOString(),
      records,
    });
    const body = JSON.stringify(snapshot);
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
