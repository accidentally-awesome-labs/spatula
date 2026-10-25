import {
  applyChanges,
  modelChanges,
  newId,
  parseDefinition,
  sha256Hex,
  sourceCoverage,
  stableStringify,
  type ApplySummary,
  type Definition,
  type ItemView,
  type PagesSource,
} from '@spatula/core';
import { and, asc, eq, inArray, notInArray, or, sql, type AnyColumn } from 'drizzle-orm';
import type { Executor } from './client';
import { supersedeDecisions } from './decisions';
import { captures, datasets, items, sources, taxonomyVersions, type ItemStatus } from './schema';
import { currentTaxonomy } from './taxonomy';

export interface DatasetRow {
  id: string;
  revision: number;
  definition: Definition;
  headGeneration: number;
}

/** A live item, with what a refresh needs to fetch it conditionally and extract it once. */
export interface ItemRef {
  id: string;
  sourceId: string;
  recordType: string;
  locator: string;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  extractInputHash: string | null;
  extractedWith: string | null;
}

/** A page as `applyDefinition` reads it. */
interface PageRow {
  id: string;
  sourceId: string;
  locator: string;
  status: ItemStatus;
}

/** A page of a removed source, and the source it moves to. */
interface Move {
  id: string;
  from: string;
  to: string;
  locator: string;
}

/**
 * Where each page of a removed source goes (ADR 0006): to the one remaining source that covers its
 * address, unless that source already has a page there. A source removed now gives up every page; a
 * source removed before gives up its excluded pages, which come back. A page that can't move stays
 * excluded. Only those of sources removed now are counted, so a page an earlier apply couldn't move
 * isn't reported on every apply. Pages that aren't excluded claim an address before excluded ones,
 * then by source and address, so the outcome doesn't depend on the order the rows came in.
 */
function planMoves(input: {
  definition: Definition;
  current: { id: string; removedAt: Date | null }[];
  listed: PageRow[];
  removed: string[];
}): { moved: Move[]; unmoved: NonNullable<ApplySummary['unmoved']> } {
  const wanted = new Set(input.definition.sources.map((source) => source.id));
  const removedNow = new Set(input.removed);
  const removedBefore = new Set(
    input.current
      .filter((source) => source.removedAt !== null && !wanted.has(source.id))
      .map((source) => source.id),
  );
  const leaving = input.listed.filter(
    (page) =>
      removedNow.has(page.sourceId) ||
      (removedBefore.has(page.sourceId) && page.status === 'excluded'),
  );
  // An address a remaining source already has stays that page's.
  const claimed = new Set(
    input.listed
      .filter((page) => wanted.has(page.sourceId))
      .map((page) => `${page.sourceId} ${page.locator}`),
  );
  // What each remaining source covers, worked out once. The store keys a page by its text, so a
  // pages source holds an address under the spelling it lists. A page it lists another way stays
  // where it is: moved, it would be a second page for the address, beside the source's own.
  const remaining = input.definition.sources.map((source) => ({
    id: source.id,
    covers: sourceCoverage(source),
    listed: source.kind === 'pages' ? new Set(source.pages) : null,
  }));
  const ordered = [...leaving].sort(
    (a, b) =>
      Number(a.status === 'excluded') - Number(b.status === 'excluded') ||
      a.sourceId.localeCompare(b.sourceId) ||
      a.locator.localeCompare(b.locator),
  );
  const moved: Move[] = [];
  const unmoved = { uncovered: 0, ambiguous: 0, taken: 0 };
  for (const page of ordered) {
    const covering = remaining.filter((source) => source.covers(page.locator));
    const to = covering.length === 1 ? covering[0]! : null;
    const why =
      covering.length === 0
        ? ('uncovered' as const)
        : to === null
          ? ('ambiguous' as const)
          : claimed.has(`${to.id} ${page.locator}`) ||
              (to.listed !== null && !to.listed.has(page.locator))
            ? ('taken' as const)
            : null;
    if (why === null && to !== null) {
      claimed.add(`${to.id} ${page.locator}`);
      moved.push({ id: page.id, from: page.sourceId, to: to.id, locator: page.locator });
    } else if (why !== null && removedNow.has(page.sourceId) && page.status !== 'excluded') {
      unmoved[why] += 1;
    }
  }
  return { moved, unmoved };
}

/** The moves, by the source that took the pages in, each with the sources they left, in order. */
function movesByTarget(moved: Move[]): NonNullable<ApplySummary['moves']> {
  const byTarget = new Map<string, { from: Set<string>; pages: number }>();
  for (const move of moved) {
    const entry = byTarget.get(move.to) ?? { from: new Set<string>(), pages: 0 };
    entry.from.add(move.from);
    entry.pages += 1;
    byTarget.set(move.to, entry);
  }
  return [...byTarget]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([to, entry]) => ({ from: [...entry.from].sort(), to, pages: entry.pages }));
}

/**
 * Applies a definition: the dataset, its sources, and an item for each page a pages source lists.
 * Pages and sources that leave the definition are excluded, not deleted, and come back if they
 * return. A sitemap source's pages are not the definition's to make or exclude: discovery does.
 * A removed source's page instead moves to the one remaining source that covers its address, with
 * its status and history, and an excluded page of a source removed earlier comes back live the same
 * way (ADR 0006). Nothing else changes, and the revision stays, when the definition is the same. A
 * dry run only reports.
 */
export async function applyDefinition(
  db: Executor,
  definition: Definition,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<ApplySummary> {
  const id = definition.dataset;
  const hash = await sha256Hex(stableStringify(definition));
  // The stored definition is read as it is, not through the schema: one an earlier version stored
  // may no longer pass the checks, and applying a new one is how the owner fixes that.
  const [existing] = await db
    .select({
      revision: datasets.revision,
      definitionHash: datasets.definitionHash,
      definition: datasets.definition,
    })
    .from(datasets)
    .where(eq(datasets.id, id));
  const current =
    existing === undefined
      ? []
      : await db
          .select({ id: sources.id, config: sources.config, removedAt: sources.removedAt })
          .from(sources)
          .where(eq(sources.datasetId, id))
          // In a fixed order, so the summary lists removed sources the same way every time.
          .orderBy(sources.id);
  const listed: PageRow[] =
    existing === undefined
      ? []
      : await db
          .select({
            id: items.id,
            sourceId: items.sourceId,
            locator: items.locator,
            status: items.status,
          })
          .from(items)
          .where(eq(items.datasetId, id));

  const active = new Map(
    current
      .filter((source) => source.removedAt === null)
      .map((source) => [source.id, source.config]),
  );
  const wanted = new Map(definition.sources.map((source) => [source.id, source]));
  const pageSources = definition.sources.filter(
    (source): source is PagesSource => source.kind === 'pages',
  );
  const listedBySitemaps = new Set(
    definition.sources.filter((source) => source.kind === 'sitemap').map((source) => source.id),
  );
  const wantedPages = new Set(
    pageSources.flatMap((source) => source.pages.map((page) => `${source.id} ${page}`)),
  );
  // A sitemap source's pages come and go with its sitemaps (discovery), not with the definition.
  const livePages = new Set(
    listed
      .filter((item) => item.status !== 'excluded' && !listedBySitemaps.has(item.sourceId))
      .map((item) => `${item.sourceId} ${item.locator}`),
  );
  const changed = existing === undefined || existing.definitionHash !== hash;
  const removed = [...active.keys()].filter((sourceId) => !wanted.has(sourceId));
  const moves = planMoves({ definition, current, listed, removed });
  // A page a move fills in a pages source isn't new, and one it takes away isn't removed.
  const movedIn = new Set(moves.moved.map((move) => `${move.to} ${move.locator}`));
  const movedOut = new Set(moves.moved.map((move) => `${move.from} ${move.locator}`));
  const summary: ApplySummary = {
    dataset: id,
    revision: existing === undefined ? 1 : changed ? existing.revision + 1 : existing.revision,
    created: existing === undefined,
    changed,
    sources: {
      added: [...wanted.keys()].filter((sourceId) => !active.has(sourceId)),
      removed,
      changed: [...wanted]
        .filter(
          ([sourceId, source]) =>
            active.has(sourceId) &&
            stableStringify(active.get(sourceId)) !== stableStringify(source),
        )
        .map(([sourceId]) => sourceId),
    },
    pages: {
      added: [...wantedPages].filter((page) => !livePages.has(page) && !movedIn.has(page)).length,
      removed: [...livePages].filter((page) => !wantedPages.has(page) && !movedOut.has(page))
        .length,
      moved: moves.moved.length,
    },
    moves: movesByTarget(moves.moved),
    unmoved: moves.unmoved,
  };
  // The taxonomy keeps to the definition's scope: a new scope is a new taxonomy version (ADR 0007).
  const taxonomyNow = existing === undefined ? null : await currentTaxonomy(db, id);
  const rescoped =
    changed &&
    definition.scope !== undefined &&
    taxonomyNow !== null &&
    taxonomyNow.taxonomy.scope !== definition.scope
      ? applyChanges(taxonomyNow.taxonomy, [{ kind: 'scope', scope: definition.scope }], () =>
          newId('tx'),
        )
      : null;
  if (rescoped?.ok === true) summary.taxonomyVersion = rescoped.taxonomy.version;
  // The jobs whose models the definition changes (ADR 0010), as `plan` shows any other change.
  const models =
    existing !== undefined && changed ? modelChanges(existing.definition, definition) : [];
  if (models.length > 0) summary.models = models;
  if (dryRun || (!changed && moves.moved.length === 0)) return summary;

  await db.transaction(async (tx) => {
    const now = new Date();
    if (changed) {
      await tx
        .insert(datasets)
        .values({ id, revision: summary.revision, definition, definitionHash: hash })
        .onConflictDoUpdate({
          target: datasets.id,
          set: { revision: summary.revision, definition, definitionHash: hash, updatedAt: now },
        });
      for (const source of definition.sources) {
        await tx
          .insert(sources)
          .values({ datasetId: id, id: source.id, kind: source.kind, config: source })
          .onConflictDoUpdate({
            target: [sources.datasetId, sources.id],
            set: { kind: source.kind, config: source, removedAt: null },
          });
      }
      if (rescoped?.ok === true && taxonomyNow !== null) {
        await tx.insert(taxonomyVersions).values({
          datasetId: id,
          version: rescoped.taxonomy.version,
          taxonomy: rescoped.taxonomy,
          changes: rescoped.applied,
          actor: { role: 'owner', client: 'cli' },
          autonomous: false,
          proposalId: null,
          undoes: null,
          createdAt: now,
        });
      }
    }
    // Pages move once every source they move to exists, and before anything is excluded or a pages
    // source's own pages are written. So a moved page keeps its status and history, and is the
    // page its new pages source lists, not a second one.
    const byTarget = new Map<string, string[]>();
    for (const move of moves.moved) {
      const ids = byTarget.get(move.to);
      if (ids === undefined) byTarget.set(move.to, [move.id]);
      else ids.push(move.id);
    }
    for (const source of definition.sources) {
      const ids = byTarget.get(source.id);
      if (ids === undefined) continue;
      await tx
        .update(items)
        .set({
          sourceId: source.id,
          // The new source's record type, as its own listing writes it.
          recordType: source.recordType,
          // A page that apply had excluded comes back live, as a listing brings one back: whether
          // its source was removed earlier, or had dropped the page from its list before it left.
          // Every other status stays: gone, refused, and irrelevant, the owner's "None of these".
          status: sql`case when ${items.status} = 'excluded' then 'live' else ${items.status} end`,
          // The new source's first complete read takes the page over.
          listedAt: null,
          listedLastmod: null,
          missingStreak: 0,
        })
        .where(inArray(items.id, ids));
    }
    if (!changed) return;
    for (const source of pageSources) {
      for (const page of source.pages) {
        await tx
          .insert(items)
          .values({
            id: newId('it'),
            datasetId: id,
            sourceId: source.id,
            recordType: source.recordType,
            locator: page,
          })
          .onConflictDoUpdate({
            target: [items.datasetId, items.sourceId, items.locator],
            // A page listed again comes back; one that's gone or refused stays as it is.
            set: {
              recordType: source.recordType,
              status: sql`case when ${items.status} = 'excluded' then 'live' else ${items.status} end`,
            },
          });
      }
      await tx
        .update(items)
        .set({ status: 'excluded' })
        .where(
          and(
            eq(items.datasetId, id),
            eq(items.sourceId, source.id),
            notInArray(items.locator, source.pages),
          ),
        );
    }
    if (removed.length > 0) {
      await tx
        .update(sources)
        .set({ removedAt: now })
        .where(and(eq(sources.datasetId, id), inArray(sources.id, removed)));
      await tx
        .update(items)
        .set({ status: 'excluded' })
        .where(and(eq(items.datasetId, id), inArray(items.sourceId, removed)));
    }
  });
  return summary;
}

/**
 * A dataset whose stored definition no longer passes the checks, as an earlier version of Spatula
 * may have left it. Nothing can run on the dataset until the owner applies the definition again.
 */
export class StaleDefinitionError extends Error {
  constructor(datasetId: string, issues: string[]) {
    super(
      `Dataset ${datasetId}’s stored definition no longer passes the checks (${issues[0]}). Apply it again.`,
    );
    this.name = 'StaleDefinitionError';
  }
}

/**
 * The dataset, with its definition read through the schema again, so a definition stored by an
 * earlier version gets the defaults of keys added since. One that no longer passes is a
 * StaleDefinitionError, which the owner fixes by applying the definition again.
 */
export async function getDataset(db: Executor, id: string): Promise<DatasetRow | null> {
  const [row] = await db
    .select({
      id: datasets.id,
      revision: datasets.revision,
      definition: datasets.definition,
      headGeneration: datasets.headGeneration,
    })
    .from(datasets)
    .where(eq(datasets.id, id));
  if (row === undefined) return null;
  const parsed = parseDefinition(row.definition);
  if (!parsed.ok) throw new StaleDefinitionError(id, parsed.issues);
  return { ...row, definition: parsed.definition };
}

/**
 * The dataset's definition revision, or null when it isn't stored. Like `datasetExists` it doesn't
 * read the definition, so a stored definition that no longer passes the checks doesn't stop it.
 */
export async function revisionOf(db: Executor, datasetId: string): Promise<number | null> {
  const [row] = await db
    .select({ revision: datasets.revision })
    .from(datasets)
    .where(eq(datasets.id, datasetId));
  return row?.revision ?? null;
}

/**
 * Whether the dataset is stored. Unlike `getDataset` it doesn't read the definition, so a dataset
 * whose stored definition no longer passes the checks still counts.
 */
export async function datasetExists(db: Executor, id: string): Promise<boolean> {
  const [row] = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.id, id));
  return row !== undefined;
}

/**
 * Every dataset, by ID, with its revision and the generation at its head: what the console opens
 * with. Like `datasetExists`, it doesn't read the definitions, so one that no longer passes the
 * checks is listed too.
 */
export async function listDatasets(
  db: Executor,
): Promise<{ id: string; revision: number; headGeneration: number }[]> {
  return db
    .select({
      id: datasets.id,
      revision: datasets.revision,
      headGeneration: datasets.headGeneration,
    })
    .from(datasets)
    .orderBy(asc(datasets.id));
}

/** The dataset's live items, by source and page. */
export async function listLiveItems(db: Executor, datasetId: string): Promise<ItemRef[]> {
  return db
    .select({
      id: items.id,
      sourceId: items.sourceId,
      recordType: items.recordType,
      locator: items.locator,
      etag: items.etag,
      lastModified: items.lastModified,
      contentHash: items.contentHash,
      extractInputHash: items.extractInputHash,
      extractedWith: items.extractedWith,
    })
    .from(items)
    .where(and(eq(items.datasetId, datasetId), eq(items.status, 'live')))
    .orderBy(items.sourceId, items.locator);
}

/** Every item of the dataset, whatever its status, with the entity it joined. */
export async function listItems(db: Executor, datasetId: string): Promise<ItemView[]> {
  return db
    .select({
      locator: items.locator,
      sourceId: items.sourceId,
      status: items.status,
      entityId: items.entityId,
    })
    .from(items)
    .where(eq(items.datasetId, datasetId))
    .orderBy(items.sourceId, items.locator);
}

/** The statuses a named page can be revived from. Excluded pages come back by being listed. */
export const REVIVABLE_STATUSES: ItemStatus[] = ['refused', 'gone', 'irrelevant'];

/**
 * A column a page keeps while it is revived from its capture (ADR 0008): an irrelevant page whose
 * capture holds its stored copy keeps it, and every other page has it null, as a page never read.
 */
const keptFromCapture = (column: AnyColumn) =>
  sql`case when ${items.status} = 'irrelevant' and exists (select 1 from ${captures} where ${captures.itemId} = ${items.id} and ${captures.contentHash} = ${items.contentHash}) then ${column} else null end`;

/**
 * Puts pages back to live: every refused page with `refused`, every irrelevant one with
 * `irrelevant`, and the pages named, from any revivable status. Their streaks start again, and a
 * revived page counts as never read, so the next run reads it whenever it was last read. A revived
 * irrelevant page also loses the decision that made it irrelevant and its extraction mark, so the
 * next run reads it and asks afresh. With `fromCaptures` (ADR 0008), an irrelevant page whose
 * capture holds its stored copy isn't counted as never read: it keeps its last fetch and what that
 * found, so once its code is older, as applying a definition makes it, the run reads it again from
 * the capture with no request. Every other page is fetched.
 *
 * The revival is one transaction: a failure partway leaves every page as it was. It starts by
 * locking the pages it will revive, and then acts on those and no others. A run can commit between
 * two statements, so a page that was something else when the revive read it, such as one a run has
 * just found irrelevant, is left alone: reviving it would leave its answer current and its mark
 * set, and no run would read or ask again. The lock holds back other changes to a locked page's
 * status until the revival ends, but not the inserts of a run that refer to the page.
 */
export async function reviveItems(
  db: Executor,
  input: {
    datasetId: string;
    pages?: string[];
    refused?: boolean;
    irrelevant?: boolean;
    fromCaptures?: boolean;
  },
): Promise<number> {
  const which = [
    ...(input.refused === true ? [eq(items.status, 'refused')] : []),
    ...(input.irrelevant === true ? [eq(items.status, 'irrelevant')] : []),
    ...(input.pages !== undefined && input.pages.length > 0
      ? [and(inArray(items.locator, input.pages), inArray(items.status, REVIVABLE_STATUSES))]
      : []),
  ];
  if (which.length === 0) return 0;
  return db.transaction(async (tx) => {
    // In a fixed order, so two revivals that overlap can't deadlock: one waits for the other.
    const locked = await tx
      .select({ id: items.id, status: items.status })
      .from(items)
      .where(and(eq(items.datasetId, input.datasetId), or(...which)))
      .orderBy(items.id)
      .for('no key update');
    if (locked.length === 0) return 0;
    const rows = await tx
      .update(items)
      .set({
        status: 'live',
        // Postgres evaluates every `set` against the row as it was, so these read the page's old
        // status. Without `fromCaptures`, they're null: the page counts as never read.
        lastOutcome: input.fromCaptures === true ? keptFromCapture(items.lastOutcome) : null,
        outcomeStreak: 0,
        missingStreak: 0,
        lastFetchedAt: input.fromCaptures === true ? keptFromCapture(items.lastFetchedAt) : null,
      })
      .where(
        inArray(
          items.id,
          locked.map((row) => row.id),
        ),
      )
      .returning({ id: items.id });
    const irrelevant = locked.filter((row) => row.status === 'irrelevant').map((row) => row.id);
    if (irrelevant.length > 0) {
      // The answer that made them irrelevant is retired, and the pages read again, so the next run
      // asks afresh instead of reusing it.
      await supersedeDecisions(tx, {
        datasetId: input.datasetId,
        subjects: irrelevant,
        at: new Date(),
      });
      await tx.update(items).set({ extractedWith: null }).where(inArray(items.id, irrelevant));
    }
    return rows.length;
  });
}
