import type { ActorRecord, AppliedChange, Taxonomy } from '@spatula/core';
import { and, desc, eq } from 'drizzle-orm';
import type { Executor } from './client';
import { items, taxonomyVersions } from './schema';
import { lockDataset } from './snapshots';

/*
 * A dataset's taxonomy versions (ADR 0007). Each version is kept whole, with the changes it applied
 * and who applied them. A version moves compared and set under the dataset's row, so two changes at
 * once can't both become the same version, and a step that runs again commits nothing twice.
 */

export interface TaxonomyVersionRow {
  datasetId: string;
  version: number;
  taxonomy: Taxonomy;
  changes: AppliedChange[];
  actor: ActorRecord;
  autonomous: boolean;
  proposalId: string | null;
  undoes: number | null;
  createdAt: Date;
}

/** A version without its taxonomy, as history lists it. */
export type TaxonomyVersionView = Omit<TaxonomyVersionRow, 'taxonomy'>;

/** The dataset's latest version, or null before it's seeded. */
export async function currentTaxonomy(
  db: Executor,
  datasetId: string,
): Promise<TaxonomyVersionRow | null> {
  const [row] = await db
    .select()
    .from(taxonomyVersions)
    .where(eq(taxonomyVersions.datasetId, datasetId))
    .orderBy(desc(taxonomyVersions.version))
    .limit(1);
  return row ?? null;
}

export async function taxonomyAt(
  db: Executor,
  datasetId: string,
  version: number,
): Promise<TaxonomyVersionRow | null> {
  const [row] = await db
    .select()
    .from(taxonomyVersions)
    .where(and(eq(taxonomyVersions.datasetId, datasetId), eq(taxonomyVersions.version, version)));
  return row ?? null;
}

/** Every version, newest first, without the whole taxonomy each holds. */
export async function taxonomyHistory(
  db: Executor,
  datasetId: string,
): Promise<TaxonomyVersionView[]> {
  return db
    .select({
      datasetId: taxonomyVersions.datasetId,
      version: taxonomyVersions.version,
      changes: taxonomyVersions.changes,
      actor: taxonomyVersions.actor,
      autonomous: taxonomyVersions.autonomous,
      proposalId: taxonomyVersions.proposalId,
      undoes: taxonomyVersions.undoes,
      createdAt: taxonomyVersions.createdAt,
    })
    .from(taxonomyVersions)
    .where(eq(taxonomyVersions.datasetId, datasetId))
    .orderBy(desc(taxonomyVersions.version));
}

/** Seeds version 1, unless the dataset has a taxonomy: seeding never replaces one. */
export async function seedTaxonomyVersion(
  db: Executor,
  input: { datasetId: string; taxonomy: Taxonomy; actor: ActorRecord; at: Date },
): Promise<'seeded' | 'exists'> {
  return db.transaction(async (tx) => {
    await lockDataset(tx, input.datasetId);
    if ((await currentTaxonomy(tx, input.datasetId)) !== null) return 'exists';
    await tx.insert(taxonomyVersions).values({
      datasetId: input.datasetId,
      version: 1,
      taxonomy: input.taxonomy,
      changes: [],
      actor: input.actor,
      autonomous: false,
      proposalId: null,
      undoes: null,
      createdAt: input.at,
    });
    return 'seeded';
  });
}

/**
 * Commits the version after `base`, when `base` is still the latest. Otherwise it commits nothing
 * and says which version is the latest, so the caller can apply its change again on that one.
 */
export async function commitTaxonomy(
  db: Executor,
  input: {
    datasetId: string;
    base: number;
    taxonomy: Taxonomy;
    changes: AppliedChange[];
    actor: ActorRecord;
    autonomous?: boolean;
    proposalId?: string | null;
    undoes?: number | null;
    at: Date;
  },
): Promise<{ committed: true; version: number } | { committed: false; version: number }> {
  return db.transaction(async (tx) => {
    await lockDataset(tx, input.datasetId);
    const latest = (await currentTaxonomy(tx, input.datasetId))?.version ?? 0;
    if (latest !== input.base || input.taxonomy.version !== input.base + 1) {
      return { committed: false as const, version: latest };
    }
    await tx.insert(taxonomyVersions).values({
      datasetId: input.datasetId,
      version: input.base + 1,
      taxonomy: input.taxonomy,
      changes: input.changes,
      actor: input.actor,
      autonomous: input.autonomous ?? false,
      proposalId: input.proposalId ?? null,
      undoes: input.undoes ?? null,
      createdAt: input.at,
    });
    return { committed: true as const, version: input.base + 1 };
  });
}

/** Notes the key a page's decision was made under; null forgets it. */
export async function setTaxonomyKey(
  db: Executor,
  itemId: string,
  key: string | null,
): Promise<void> {
  await db.update(items).set({ taxonomyKey: key }).where(eq(items.id, itemId));
}
