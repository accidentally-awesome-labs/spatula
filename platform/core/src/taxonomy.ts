import { z } from 'zod';

/*
 * The living taxonomy (ADR 0007). Shelves are a tree of at most two levels, a category and its
 * subcategories, and a product sits on exactly one: a subcategory when one fits, otherwise the
 * category. Functions are what a product can do in a signal chain. Features are filters that belong
 * to shelves and pass down to their subcategories, each with a few values. Every shelf, function,
 * feature, and value has a stable ID (`tx_` and 20 base32 characters), a slug, a name, and a
 * description, which deciders and reviewers both read. A rename keeps the ID, and an ID is never
 * reused. A retired item stays listed, so readers can resolve old IDs. These are the snapshot
 * contract's shapes: Crowdio's reader checks the same.
 */

/** A taxonomy ID: `tx_` and 20 characters of Crockford's base32, as `newId('tx')` makes. */
export const TX_ID = /^tx_[0-9a-hjkmnp-tv-z]{20}$/u;
/** Words of lowercase letters and digits joined by single hyphens, as Crowdio's reader takes them. */
const SLUG = /^(?=.{1,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const TAXONOMY_NAME_MAX = 80;
export const TAXONOMY_DESCRIPTION_MAX = 300;
export const SCOPE_MAX = 2000;
/** A shelf question offers every live shelf and "None of these", and a question offers at most 255. */
export const MAX_SHELVES = 254;
/** A taxonomy answer's "None of these": the page is about nothing the dataset keeps. */
export const NONE_SHELF = 'none';

export const TAXONOMY_SUBJECTS = ['shelf', 'function', 'feature', 'value'] as const;
export type TaxonomySubject = (typeof TAXONOMY_SUBJECTS)[number];
/** The contract's migration kinds. A restore undoes a merge or a retirement: its `to` repeats `from`. */
export const MIGRATION_KINDS = ['rename', 'move', 'merge', 'split', 'retire', 'restore'] as const;
export type MigrationKind = (typeof MIGRATION_KINDS)[number];
/** The decided fields a record type with a taxonomy has, beside its own. */
export const TAXONOMY_FIELDS = ['shelf', 'functions', 'features'] as const;

export const txIdSchema = z
  .string()
  .regex(TX_ID, 'Use a taxonomy ID: tx_ and 20 base32 characters.');
export const taxonomySlugSchema = z
  .string()
  .regex(SLUG, 'Use lowercase letters, digits, and hyphens, up to 63 characters.');
/** A name on one line: Crowdio's reader refuses a control character in a taxonomy name. */
export const taxonomyNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(TAXONOMY_NAME_MAX)
  .regex(/^[^\p{Cc}]*$/u, 'A name can’t contain line breaks or other control characters.');
export const taxonomyDescriptionSchema = z.string().trim().min(1).max(TAXONOMY_DESCRIPTION_MAX);
export const scopeSchema = z.string().trim().min(1).max(SCOPE_MAX);

const item = {
  id: txIdSchema,
  slug: taxonomySlugSchema,
  name: taxonomyNameSchema,
  description: taxonomyDescriptionSchema,
  sortOrder: z.number().int().min(1).max(10_000),
  retiredIn: z.number().int().min(1).nullable(),
};

const taxonomyShape = z.strictObject({
  version: z.number().int().min(1).max(999_999_999),
  scope: scopeSchema,
  shelves: z
    .array(
      z.strictObject({
        ...item,
        parentId: txIdSchema.nullable(),
        implies: z.array(txIdSchema).max(50),
      }),
    )
    .min(1)
    .max(1000),
  functions: z.array(z.strictObject(item)).max(200),
  features: z
    .array(
      z.strictObject({
        ...item,
        cardinality: z.enum(['one', 'many']),
        shelves: z.array(txIdSchema).max(1000),
        values: z.array(z.strictObject(item)).min(1).max(200),
      }),
    )
    .max(200),
  migrations: z
    .array(
      z.strictObject({
        version: z.number().int().min(1),
        kind: z.enum(MIGRATION_KINDS),
        subject: z.enum(TAXONOMY_SUBJECTS),
        from: txIdSchema,
        to: z.union([txIdSchema, z.array(txIdSchema).min(1).max(100), z.null()]),
      }),
    )
    .max(10_000),
});

export type Taxonomy = z.output<typeof taxonomyShape>;
export type Shelf = Taxonomy['shelves'][number];
export type TaxonomyFunction = Taxonomy['functions'][number];
export type Feature = Taxonomy['features'][number];
export type FeatureValue = Feature['values'][number];
export type TaxonomyMigration = Taxonomy['migrations'][number];
/** What every shelf, function, feature, and value has. */
export type TaxonomyItem = TaxonomyFunction;

/** The taxonomy block of a snapshot, checked as a reader checks it. */
export const taxonomySchema = taxonomyShape.superRefine((taxonomy, ctx) => {
  for (const issue of taxonomyIssues(taxonomy)) {
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
});

export interface TaxonomyIssue {
  path: (string | number)[];
  message: string;
}

export const isLive = (entry: { retiredIn: number | null }): boolean => entry.retiredIn === null;

/** Siblings in their order, and by slug when two share a place. */
export const bySortOrder = (
  a: { sortOrder: number; slug: string },
  b: { sortOrder: number; slug: string },
): number => a.sortOrder - b.sortOrder || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

/**
 * What makes a taxonomy unusable, as a path and a message: an ID or a slug used twice, a shelf
 * called `none`, two live siblings with one name, a third level, a reference to nothing, a live item
 * hanging off a retired one, a live feature with no live value, and a migration that doesn't fit its
 * kind.
 */
export function taxonomyIssues(taxonomy: Taxonomy): TaxonomyIssue[] {
  const issues: TaxonomyIssue[] = [];
  const report = (path: (string | number)[], message: string) => {
    issues.push({ path, message });
  };
  const subjects = new Map<string, TaxonomySubject>();
  const claim = (entryId: string, subject: TaxonomySubject, path: (string | number)[]) => {
    if (subjects.has(entryId)) report([...path, 'id'], `The ID ${entryId} is used twice.`);
    else subjects.set(entryId, subject);
  };
  taxonomy.shelves.forEach((shelf, index) => claim(shelf.id, 'shelf', ['shelves', index]));
  taxonomy.functions.forEach((fn, index) => claim(fn.id, 'function', ['functions', index]));
  const valuePaths: (string | number)[][] = [];
  taxonomy.features.forEach((feature, index) => {
    claim(feature.id, 'feature', ['features', index]);
    feature.values.forEach((value, at) => {
      const path = ['features', index, 'values', at];
      valuePaths.push(path);
      claim(value.id, 'value', path);
    });
  });

  // Slugs are unique within each kind, retired items included, so a slug never names two items.
  const uniqueSlugs = (
    list: readonly { slug: string }[],
    pathOf: (index: number) => (string | number)[],
    kind: string,
  ) => {
    const seen = new Set<string>();
    list.forEach((entry, index) => {
      if (seen.has(entry.slug))
        report([...pathOf(index), 'slug'], `Another ${kind} is also called ${entry.slug}.`);
      seen.add(entry.slug);
    });
  };
  uniqueSlugs(taxonomy.shelves, (index) => ['shelves', index], 'shelf');
  taxonomy.shelves.forEach((shelf, index) => {
    if (shelf.slug === NONE_SHELF) {
      report(
        ['shelves', index, 'slug'],
        `A shelf can’t be called ${NONE_SHELF}: that’s the answer for none of these.`,
      );
    }
  });
  uniqueSlugs(taxonomy.functions, (index) => ['functions', index], 'function');
  uniqueSlugs(taxonomy.features, (index) => ['features', index], 'feature');
  uniqueSlugs(
    taxonomy.features.flatMap((feature) => feature.values),
    (index) => valuePaths[index]!,
    'value',
  );

  // Names are unique among live siblings, whatever their case.
  const uniqueNames = (
    list: readonly { name: string; retiredIn: number | null }[],
    pathOf: (index: number) => (string | number)[],
  ) => {
    const seen = new Set<string>();
    list.forEach((entry, index) => {
      if (!isLive(entry)) return;
      const key = entry.name.toLowerCase();
      if (seen.has(key))
        report([...pathOf(index), 'name'], `Another live sibling is also named ${entry.name}.`);
      seen.add(key);
    });
  };
  const parents = new Set(taxonomy.shelves.map((shelf) => shelf.parentId));
  for (const parentId of parents) {
    const siblings = taxonomy.shelves
      .map((shelf, index) => ({ shelf, index }))
      .filter(({ shelf }) => shelf.parentId === parentId);
    uniqueNames(
      siblings.map(({ shelf }) => shelf),
      (at) => ['shelves', siblings[at]!.index],
    );
  }
  uniqueNames(taxonomy.functions, (index) => ['functions', index]);
  uniqueNames(taxonomy.features, (index) => ['features', index]);
  taxonomy.features.forEach((feature, index) =>
    uniqueNames(feature.values, (at) => ['features', index, 'values', at]),
  );

  const shelves = new Map(taxonomy.shelves.map((shelf) => [shelf.id, shelf]));
  const functions = new Map(taxonomy.functions.map((fn) => [fn.id, fn]));
  const live = taxonomy.shelves.filter(isLive);
  if (live.length === 0) report(['shelves'], 'Keep at least one live shelf.');
  if (live.length > MAX_SHELVES) report(['shelves'], `Keep at most ${MAX_SHELVES} live shelves.`);
  taxonomy.shelves.forEach((shelf, index) => {
    const at = ['shelves', index];
    if (shelf.parentId !== null) {
      const parent = shelves.get(shelf.parentId);
      if (parent === undefined) report([...at, 'parentId'], `There’s no shelf ${shelf.parentId}.`);
      else if (parent.parentId !== null || parent.id === shelf.id) {
        report(
          [...at, 'parentId'],
          'Shelves go two levels deep at most: a category and its subcategories.',
        );
      } else if (isLive(shelf) && !isLive(parent)) {
        report([...at, 'parentId'], 'A live subcategory belongs to a live category.');
      }
    }
    shelf.implies.forEach((fnId, position) => {
      const fn = functions.get(fnId);
      if (fn === undefined) report([...at, 'implies', position], `There’s no function ${fnId}.`);
      else if (isLive(shelf) && !isLive(fn)) {
        report([...at, 'implies', position], 'A live shelf implies only live functions.');
      }
    });
  });
  taxonomy.features.forEach((feature, index) => {
    feature.shelves.forEach((shelfId, position) => {
      if (!shelves.has(shelfId))
        report(['features', index, 'shelves', position], `There’s no shelf ${shelfId}.`);
    });
    if (isLive(feature) && !feature.values.some(isLive)) {
      report(['features', index, 'values'], 'A live feature keeps at least one live value.');
    }
  });
  const items: [TaxonomyItem, (string | number)[]][] = [
    ...taxonomy.shelves.map((shelf, index): [TaxonomyItem, (string | number)[]] => [
      shelf,
      ['shelves', index],
    ]),
    ...taxonomy.functions.map((fn, index): [TaxonomyItem, (string | number)[]] => [
      fn,
      ['functions', index],
    ]),
    ...taxonomy.features.map((feature, index): [TaxonomyItem, (string | number)[]] => [
      feature,
      ['features', index],
    ]),
    ...taxonomy.features
      .flatMap((feature) => feature.values)
      .map((value, index): [TaxonomyItem, (string | number)[]] => [value, valuePaths[index]!]),
  ];
  for (const [entry, path] of items) {
    if (entry.retiredIn !== null && entry.retiredIn > taxonomy.version) {
      report([...path, 'retiredIn'], 'An item can’t be retired after its taxonomy’s version.');
    }
  }

  let last = 0;
  taxonomy.migrations.forEach((migration, index) => {
    const at = ['migrations', index];
    if (migration.version > taxonomy.version) {
      report([...at, 'version'], 'A migration can’t be newer than its taxonomy.');
    }
    if (migration.version < last)
      report([...at, 'version'], 'Migrations are listed in version order.');
    last = Math.max(last, migration.version);
    if (subjects.get(migration.from) !== migration.subject) {
      report([...at, 'from'], `${migration.from} isn’t a listed ${migration.subject}.`);
    }
    const { to } = migration;
    switch (migration.kind) {
      case 'merge':
        if (
          typeof to !== 'string' ||
          to === migration.from ||
          subjects.get(to) !== migration.subject
        ) {
          report([...at, 'to'], 'A merge names the one item it merges into.');
        }
        break;
      case 'split':
        if (
          !Array.isArray(to) ||
          to.some((entryId) => subjects.get(entryId) !== 'shelf') ||
          migration.subject !== 'shelf'
        ) {
          report([...at, 'to'], 'A split lists the subcategories its category gained.');
        }
        break;
      case 'retire':
        if (to !== null) report([...at, 'to'], 'A retirement merges into nothing: its to is null.');
        break;
      case 'rename':
      case 'move':
      case 'restore':
        if (to !== migration.from)
          report([...at, 'to'], `A ${migration.kind} keeps the item’s ID: its to is its from.`);
        break;
    }
  });
  // An item is retired after its last merge or retirement, and live after its last restore, so a
  // reader that applies them in order ends where the taxonomy says.
  const lastSaid = new Map<string, { retired: boolean; index: number }>();
  taxonomy.migrations.forEach((migration, index) => {
    if (migration.kind === 'merge' || migration.kind === 'retire')
      lastSaid.set(migration.from, { retired: true, index });
    if (migration.kind === 'restore') lastSaid.set(migration.from, { retired: false, index });
  });
  const retiredNow = new Map(items.map(([entry]) => [entry.id, !isLive(entry)]));
  for (const [entryId, { retired, index }] of lastSaid) {
    const now = retiredNow.get(entryId);
    if (now !== undefined && now !== retired) {
      report(
        ['migrations', index],
        retired
          ? `${entryId} is live, and its last migration retires it.`
          : `${entryId} is retired, and its last migration restores it.`,
      );
    }
  }
  return issues;
}

const seedItem = {
  id: txIdSchema.optional(),
  slug: taxonomySlugSchema,
  name: taxonomyNameSchema,
  description: taxonomyDescriptionSchema,
};
const seedShelf = { ...seedItem, implies: z.array(taxonomySlugSchema).max(50).default([]) };

/**
 * The seed file (the contract's `audiophile-taxonomy-v1.yaml`): the scope, the functions, the shelves
 * with their children, and the features, by slug. List order sets each item's place. An export adds
 * each item's ID, and seeding keeps an ID it's given.
 */
export const taxonomySeedSchema = z.strictObject({
  scope: scopeSchema,
  functions: z.array(z.strictObject(seedItem)).max(200),
  shelves: z
    .array(
      z.strictObject({
        ...seedShelf,
        children: z.array(z.strictObject(seedShelf)).max(MAX_SHELVES).default([]),
      }),
    )
    .min(1)
    .max(MAX_SHELVES),
  features: z
    .array(
      z.strictObject({
        ...seedItem,
        cardinality: z.enum(['one', 'many']),
        shelves: z.array(taxonomySlugSchema).min(1).max(MAX_SHELVES),
        values: z.array(z.strictObject(seedItem)).min(1).max(200),
      }),
    )
    .max(200)
    .default([]),
});
export type TaxonomySeed = z.output<typeof taxonomySeedSchema>;

/** A seed file as version 1: every item with its ID and place, implied functions and shelves by ID. */
export function seedTaxonomy(
  seed: TaxonomySeed,
  makeId: () => string,
): { ok: true; taxonomy: Taxonomy } | { ok: false; issues: string[] } {
  const problems: string[] = [];
  const idOf = (entry: { id?: string }) => entry.id ?? makeId();
  const functions = seed.functions.map((fn, index) => ({
    id: idOf(fn),
    slug: fn.slug,
    name: fn.name,
    description: fn.description,
    sortOrder: index + 1,
    retiredIn: null,
  }));
  const functionIds = new Map(functions.map((fn) => [fn.slug, fn.id]));
  const implied = (slugs: readonly string[], path: string) =>
    slugs.flatMap((slug) => {
      const fnId = functionIds.get(slug);
      if (fnId === undefined) problems.push(`${path}.implies: There’s no function called ${slug}.`);
      return fnId === undefined ? [] : [fnId];
    });
  const shelves: Shelf[] = [];
  seed.shelves.forEach((category, index) => {
    const categoryId = idOf(category);
    shelves.push({
      id: categoryId,
      slug: category.slug,
      name: category.name,
      description: category.description,
      parentId: null,
      implies: implied(category.implies, `shelves.${index}`),
      sortOrder: index + 1,
      retiredIn: null,
    });
    category.children.forEach((child, at) =>
      shelves.push({
        id: idOf(child),
        slug: child.slug,
        name: child.name,
        description: child.description,
        parentId: categoryId,
        implies: implied(child.implies, `shelves.${index}.children.${at}`),
        sortOrder: at + 1,
        retiredIn: null,
      }),
    );
  });
  const shelfIds = new Map(shelves.map((shelf) => [shelf.slug, shelf.id]));
  const features = seed.features.map((feature, index) => ({
    id: idOf(feature),
    slug: feature.slug,
    name: feature.name,
    description: feature.description,
    cardinality: feature.cardinality,
    shelves: feature.shelves.flatMap((slug) => {
      const shelfId = shelfIds.get(slug);
      if (shelfId === undefined)
        problems.push(`features.${index}.shelves: There’s no shelf called ${slug}.`);
      return shelfId === undefined ? [] : [shelfId];
    }),
    sortOrder: index + 1,
    retiredIn: null,
    values: feature.values.map((value, at) => ({
      id: idOf(value),
      slug: value.slug,
      name: value.name,
      description: value.description,
      sortOrder: at + 1,
      retiredIn: null,
    })),
  }));
  const taxonomy: Taxonomy = {
    version: 1,
    scope: seed.scope,
    shelves,
    functions,
    features,
    migrations: [],
  };
  problems.push(
    ...taxonomyIssues(taxonomy).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  );
  return problems.length > 0 ? { ok: false, issues: problems } : { ok: true, taxonomy };
}

/** The live taxonomy in the seed file's shape, with each item's ID: what `taxonomy export` writes. */
export function exportTaxonomy(taxonomy: Taxonomy): TaxonomySeed {
  const functionSlugs = new Map(taxonomy.functions.map((fn) => [fn.id, fn.slug]));
  const shelfSlugs = new Map(taxonomy.shelves.map((shelf) => [shelf.id, shelf.slug]));
  const base = (entry: TaxonomyItem) => ({
    id: entry.id,
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
  });
  const shelf = (entry: Shelf) => ({
    ...base(entry),
    implies: entry.implies.map((fnId) => functionSlugs.get(fnId) ?? fnId),
  });
  return {
    scope: taxonomy.scope,
    functions: taxonomy.functions.filter(isLive).sort(bySortOrder).map(base),
    shelves: categoriesOf(taxonomy).map((category) => ({
      ...shelf(category),
      children: subcategoriesOf(taxonomy, category.id).map(shelf),
    })),
    features: taxonomy.features
      .filter(isLive)
      .sort(bySortOrder)
      .map((feature) => ({
        ...base(feature),
        cardinality: feature.cardinality,
        shelves: feature.shelves
          .filter((shelfId) => {
            const found = shelfById(taxonomy, shelfId);
            return found !== undefined && isLive(found);
          })
          .map((shelfId) => shelfSlugs.get(shelfId) ?? shelfId),
        values: feature.values.filter(isLive).sort(bySortOrder).map(base),
      })),
  };
}

export function shelfById(taxonomy: Taxonomy, shelfId: string): Shelf | undefined {
  return taxonomy.shelves.find((shelf) => shelf.id === shelfId);
}

/** The shelf's category: the shelf itself for a category. */
export function categoryOf(taxonomy: Taxonomy, shelfId: string): Shelf | undefined {
  const shelf = shelfById(taxonomy, shelfId);
  if (shelf === undefined || shelf.parentId === null) return shelf;
  return shelfById(taxonomy, shelf.parentId);
}

/** The live categories, in order. */
export function categoriesOf(taxonomy: Taxonomy): Shelf[] {
  return taxonomy.shelves
    .filter((shelf) => shelf.parentId === null && isLive(shelf))
    .sort(bySortOrder);
}

/** A category's live subcategories, in order. */
export function subcategoriesOf(taxonomy: Taxonomy, categoryId: string): Shelf[] {
  return taxonomy.shelves
    .filter((shelf) => shelf.parentId === categoryId && isLive(shelf))
    .sort(bySortOrder);
}

/** The live features on a shelf: those listing it or its category, in order. */
export function featuresFor(taxonomy: Taxonomy, shelfId: string): Feature[] {
  const category = categoryOf(taxonomy, shelfId);
  return taxonomy.features
    .filter(
      (feature) =>
        isLive(feature) &&
        (feature.shelves.includes(shelfId) ||
          (category !== undefined && feature.shelves.includes(category.id))),
    )
    .sort(bySortOrder);
}

/** The live features on any of these shelves, each once, in order. */
export function featuresForAny(taxonomy: Taxonomy, shelfIds: readonly string[]): Feature[] {
  const found = new Map<string, Feature>();
  for (const shelfId of shelfIds) {
    for (const feature of featuresFor(taxonomy, shelfId)) found.set(feature.id, feature);
  }
  return [...found.values()].sort(bySortOrder);
}

export function featureOfValue(taxonomy: Taxonomy, valueId: string): Feature | undefined {
  return taxonomy.features.find((feature) => feature.values.some((value) => value.id === valueId));
}

/** Every item of a kind, live and retired. */
export function itemsOf(taxonomy: Taxonomy, subject: TaxonomySubject): TaxonomyItem[] {
  switch (subject) {
    case 'shelf':
      return taxonomy.shelves;
    case 'function':
      return taxonomy.functions;
    case 'feature':
      return taxonomy.features;
    case 'value':
      return taxonomy.features.flatMap((feature) => feature.values);
  }
}

/** An item of a kind by its ID or its slug, live or retired. */
export function findItem(
  taxonomy: Taxonomy,
  subject: TaxonomySubject,
  ref: string,
): TaxonomyItem | undefined {
  const list = itemsOf(taxonomy, subject);
  return TX_ID.test(ref)
    ? list.find((entry) => entry.id === ref)
    : list.find((entry) => entry.slug === ref);
}

/**
 * The live item an ID stands for now: the item itself while it's live; the item a merge retired it
 * into, followed as far as it goes; null for a retired item merged into nothing, or an unknown ID.
 */
export function resolveId(
  taxonomy: Taxonomy,
  subject: TaxonomySubject,
  itemId: string,
): string | null {
  let current = itemId;
  for (let steps = 0; steps <= taxonomy.migrations.length; steps += 1) {
    const found = itemsOf(taxonomy, subject).find((entry) => entry.id === current);
    if (found === undefined) return null;
    if (isLive(found)) return found.id;
    const merge = taxonomy.migrations.findLast(
      (migration) =>
        migration.kind === 'merge' &&
        migration.subject === subject &&
        migration.from === current &&
        migration.version === found.retiredIn,
    );
    if (merge === undefined || typeof merge.to !== 'string') return null;
    current = merge.to;
  }
  return null;
}

/** The live functions a shelf implies. */
export function impliedFunctions(taxonomy: Taxonomy, shelfId: string): string[] {
  const shelf = shelfById(taxonomy, shelfId);
  if (shelf === undefined) return [];
  return shelf.implies.filter((fnId) =>
    taxonomy.functions.some((fn) => fn.id === fnId && isLive(fn)),
  );
}

/** A shelf as people read it: "Amplifiers › Power amps", or the category's name alone. */
export function shelfPath(taxonomy: Taxonomy, shelfId: string): string {
  const shelf = shelfById(taxonomy, shelfId);
  if (shelf === undefined) return shelfId;
  const category = categoryOf(taxonomy, shelfId);
  return category === undefined || category.id === shelf.id
    ? shelf.name
    : `${category.name} › ${shelf.name}`;
}
