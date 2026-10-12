import {
  newId,
  parseDefinition,
  sha256Hex,
  stableStringify,
  type ApplySummary,
  type Definition,
  type PagesSource,
} from '@spatula/core';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Executor } from './client';
import { datasets, items, sources } from './schema';

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

/**
 * Applies a definition: the dataset, its sources, and an item for each page a pages source lists.
 * Pages and sources that leave the definition are excluded, not deleted, and come back if they
 * return. A sitemap source's pages are not the definition's to make or exclude: discovery does.
 * Nothing changes, and the revision stays, when the definition is the same. A dry run only reports.
 */
export async function applyDefinition(
  db: Executor,
  definition: Definition,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<ApplySummary> {
  const id = definition.dataset;
  const hash = await sha256Hex(stableStringify(definition));
  const [existing] = await db
    .select({ revision: datasets.revision, definitionHash: datasets.definitionHash })
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
  const listed =
    existing === undefined
      ? []
      : await db
          .select({ sourceId: items.sourceId, locator: items.locator, status: items.status })
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
  const summary: ApplySummary = {
    dataset: id,
    revision: existing === undefined ? 1 : changed ? existing.revision + 1 : existing.revision,
    created: existing === undefined,
    changed,
    sources: {
      added: [...wanted.keys()].filter((sourceId) => !active.has(sourceId)),
      removed: [...active.keys()].filter((sourceId) => !wanted.has(sourceId)),
      changed: [...wanted]
        .filter(
          ([sourceId, source]) =>
            active.has(sourceId) &&
            stableStringify(active.get(sourceId)) !== stableStringify(source),
        )
        .map(([sourceId]) => sourceId),
    },
    pages: {
      added: [...wantedPages].filter((page) => !livePages.has(page)).length,
      removed: [...livePages].filter((page) => !wantedPages.has(page)).length,
    },
  };
  if (dryRun || !changed) return summary;

  await db.transaction(async (tx) => {
    const now = new Date();
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
      if (source.kind === 'pages') {
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
    }
    if (summary.sources.removed.length > 0) {
      await tx
        .update(sources)
        .set({ removedAt: now })
        .where(and(eq(sources.datasetId, id), inArray(sources.id, summary.sources.removed)));
      await tx
        .update(items)
        .set({ status: 'excluded' })
        .where(and(eq(items.datasetId, id), inArray(items.sourceId, summary.sources.removed)));
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
