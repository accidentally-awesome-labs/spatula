import {
  compareStatements,
  provenanceOf,
  type Provenance,
  type StatementView,
} from './survivorship';
import {
  bySortOrder,
  categoryOf,
  featureOfValue,
  featuresFor,
  impliedFunctions,
  isLive,
  resolveId,
  shelfById,
  type Taxonomy,
  type TaxonomyIssue,
  type TaxonomyItem,
} from './taxonomy';

/*
 * A record's place in its dataset's taxonomy, as a snapshot publishes it (ADR 0007, the snapshot
 * contract). The shelf is the best current statement's that names a live shelf, a merged shelf
 * counting as the one it was merged into, so answers keep their author through a merge (ruling 5).
 * Functions are those the shelf implies and those stated, and features only those on the shelf,
 * each by ID in the taxonomy's order. `category` keeps the name of the shelf's category for one
 * release, so older readers keep working. A record with no live shelf has no place, and a snapshot
 * leaves it out.
 */

/** A type rather than an interface, so a place's fields check as a record's fields. */
export type PlacedFields = {
  /** A live shelf's ID. */
  shelf: string;
  /** Live function IDs, the shelf's implied ones included, in the taxonomy's order. */
  functions: string[];
  /** Live value IDs by feature ID, for the features on the shelf, both in the taxonomy's order. */
  features: Record<string, string[]>;
  /** The name of the shelf's category, kept for one release. */
  category: string;
};

/** Where each field came from (ruling 18). An empty list has none. */
export interface PlacedProvenance {
  shelf: Provenance;
  functions?: Provenance;
  features?: Provenance;
  category: Provenance;
}

export interface PlacedRecord {
  fields: PlacedFields;
  provenance: PlacedProvenance;
}

/** The record's current statements about one of the taxonomy's fields, best first. */
function statementsAbout(statements: readonly StatementView[], property: string): StatementView[] {
  return statements
    .filter((statement) => statement.property === property && typeof statement.value === 'string')
    .sort(compareStatements);
}

/**
 * A record's place under this taxonomy, from its current statements, or null when none names a
 * shelf that is live in it. Provenance follows ruling 18: `category` takes the shelf's;
 * `functions`, when it isn't empty, takes its best statement's, or the shelf's when the shelf
 * implies every function; `features`, when it isn't empty, takes its best statement's.
 */
export function placeRecord(
  taxonomy: Taxonomy,
  statements: readonly StatementView[],
): PlacedRecord | null {
  let shelfId: string | null = null;
  let shelfSaid: StatementView | undefined;
  for (const statement of statementsAbout(statements, 'shelf')) {
    shelfId = resolveId(taxonomy, 'shelf', statement.value as string);
    if (shelfId !== null) {
      shelfSaid = statement;
      break;
    }
  }
  const category = shelfId === null ? undefined : categoryOf(taxonomy, shelfId);
  if (shelfId === null || shelfSaid === undefined || category === undefined) return null;
  const shelfProvenance = provenanceOf(shelfSaid, [shelfSaid]);

  // Each function once, by its best statement. Those the shelf implies need none.
  const implied = new Set(impliedFunctions(taxonomy, shelfId));
  const stated = new Map<string, StatementView>();
  for (const statement of statementsAbout(statements, 'functions')) {
    const fnId = resolveId(taxonomy, 'function', statement.value as string);
    if (fnId !== null && !stated.has(fnId)) stated.set(fnId, statement);
  }
  const functions = taxonomy.functions
    .filter((fn) => implied.has(fn.id) || stated.has(fn.id))
    .sort(bySortOrder)
    .map((fn) => fn.id);
  const beyond = [...stated]
    .filter(([fnId]) => !implied.has(fnId))
    .map(([, statement]) => statement);

  // Each value once, by its best statement, for the features on the shelf. A feature that takes
  // one value takes its best statement's.
  const onShelf = featuresFor(taxonomy, shelfId);
  const shelfFeatures = new Set(onShelf.map((feature) => feature.id));
  const chosen = new Map<string, Map<string, StatementView>>();
  for (const statement of statementsAbout(statements, 'features')) {
    const valueId = resolveId(taxonomy, 'value', statement.value as string);
    const feature = valueId === null ? undefined : featureOfValue(taxonomy, valueId);
    if (valueId === null || feature === undefined || !shelfFeatures.has(feature.id)) continue;
    const values = chosen.get(feature.id) ?? new Map<string, StatementView>();
    if (feature.cardinality === 'one' && values.size > 0) continue;
    if (!values.has(valueId)) values.set(valueId, statement);
    chosen.set(feature.id, values);
  }
  const features: Record<string, string[]> = {};
  const behind: StatementView[] = [];
  for (const feature of onShelf) {
    const values = chosen.get(feature.id);
    if (values === undefined) continue;
    features[feature.id] = feature.values
      .filter((value) => values.has(value.id))
      .sort(bySortOrder)
      .map((value) => value.id);
    behind.push(...values.values());
  }

  const best = (list: StatementView[]) => [...list].sort(compareStatements)[0]!;
  return {
    fields: { shelf: shelfId, functions, features, category: category.name },
    provenance: {
      shelf: shelfProvenance,
      ...(functions.length === 0
        ? {}
        : {
            functions:
              beyond.length === 0 ? { ...shelfProvenance } : provenanceOf(best(beyond), beyond),
          }),
      ...(behind.length === 0 ? {} : { features: provenanceOf(best(behind), behind) }),
      category: { ...shelfProvenance },
    },
  };
}

const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/**
 * What keeps a record's fields from being a place in this taxonomy, as the contract's rules have
 * it, by path inside the fields: a shelf that isn't live; a function or a value that isn't, or is
 * listed twice; functions without what the shelf implies; a feature that isn't on the shelf; a
 * feature that takes one value with more or fewer; and a category that isn't the name of the
 * shelf's category.
 */
export function placementIssues(
  taxonomy: Taxonomy,
  fields: Readonly<Record<string, unknown>>,
): TaxonomyIssue[] {
  const issues: TaxonomyIssue[] = [];
  const report = (path: (string | number)[], message: string) => {
    issues.push({ path, message });
  };
  const named = typeof fields.shelf === 'string' ? shelfById(taxonomy, fields.shelf) : undefined;
  const shelf = named !== undefined && isLive(named) ? named : undefined;
  if (shelf === undefined) {
    report(['shelf'], 'A record’s shelf is a live shelf of the snapshot’s taxonomy.');
  }

  const { functions } = fields;
  if (!isIdList(functions)) {
    report(['functions'], 'functions lists function IDs.');
  } else {
    functions.forEach((fnId, index) => {
      const fn = taxonomy.functions.find((entry) => entry.id === fnId);
      if (fn === undefined || !isLive(fn)) {
        report(['functions', index], 'It isn’t a live function of the snapshot’s taxonomy.');
      } else if (functions.indexOf(fnId) !== index) {
        report(['functions', index], `${fn.name} is listed twice.`);
      }
    });
    // A shelf implies only live functions, so each one it implies is found.
    if (shelf !== undefined) {
      for (const fnId of impliedFunctions(taxonomy, shelf.id)) {
        if (functions.includes(fnId)) continue;
        const fn = taxonomy.functions.find((entry) => entry.id === fnId);
        report(
          ['functions'],
          `functions leaves out ${fn?.name ?? fnId}, which ${shelf.name} implies.`,
        );
      }
    }
  }

  const { features } = fields;
  if (typeof features !== 'object' || features === null || Array.isArray(features)) {
    report(['features'], 'features lists value IDs by feature ID.');
  } else {
    const onShelf = new Set(
      shelf === undefined ? [] : featuresFor(taxonomy, shelf.id).map((feature) => feature.id),
    );
    for (const [featureId, values] of Object.entries(features)) {
      const at = ['features', featureId];
      const feature = taxonomy.features.find((entry) => entry.id === featureId);
      if (feature === undefined || !isLive(feature)) {
        report(at, 'It isn’t a live feature of the snapshot’s taxonomy.');
        continue;
      }
      if (shelf !== undefined && !onShelf.has(feature.id)) {
        report(at, `${feature.name} isn’t a feature of ${shelf.name}.`);
      }
      if (!isIdList(values)) {
        report(at, `${feature.name}’s values are a list of value IDs.`);
        continue;
      }
      values.forEach((valueId, index) => {
        const value = feature.values.find((entry) => entry.id === valueId);
        if (value === undefined || !isLive(value)) {
          report([...at, index], `It isn’t a live value of ${feature.name}.`);
        } else if (values.indexOf(valueId) !== index) {
          report([...at, index], `${value.name} is listed twice.`);
        }
      });
      if (feature.cardinality === 'one' && values.length !== 1) {
        report(at, `${feature.name} takes exactly one value.`);
      }
    }
  }

  const category = shelf === undefined ? undefined : categoryOf(taxonomy, shelf.id);
  if (category !== undefined && fields.category !== category.name) {
    report(['category'], `category is the name of the shelf’s category: ${category.name}.`);
  }
  return issues;
}

/**
 * The taxonomy with its keys in the contract's order. Postgres's jsonb gives an object's keys back
 * in an order of its own, and Zod's output keeps its schema's, so a snapshot's bytes would
 * otherwise depend on where its taxonomy was read from. Lists keep their order, which jsonb keeps.
 */
export function canonicalTaxonomy(taxonomy: Taxonomy): Taxonomy {
  const base = (entry: TaxonomyItem) => ({
    id: entry.id,
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
  });
  return {
    version: taxonomy.version,
    scope: taxonomy.scope,
    shelves: taxonomy.shelves.map((shelf) => ({
      ...base(shelf),
      parentId: shelf.parentId,
      implies: [...shelf.implies],
      sortOrder: shelf.sortOrder,
      retiredIn: shelf.retiredIn,
    })),
    functions: taxonomy.functions.map((fn) => ({
      ...base(fn),
      sortOrder: fn.sortOrder,
      retiredIn: fn.retiredIn,
    })),
    features: taxonomy.features.map((feature) => ({
      ...base(feature),
      cardinality: feature.cardinality,
      shelves: [...feature.shelves],
      sortOrder: feature.sortOrder,
      retiredIn: feature.retiredIn,
      values: feature.values.map((value) => ({
        ...base(value),
        sortOrder: value.sortOrder,
        retiredIn: value.retiredIn,
      })),
    })),
    migrations: taxonomy.migrations.map((migration) => ({
      version: migration.version,
      kind: migration.kind,
      subject: migration.subject,
      from: migration.from,
      to: Array.isArray(migration.to) ? [...migration.to] : migration.to,
    })),
  };
}
